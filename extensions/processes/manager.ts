import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { clampReadBytes, clampWaitMs, type ProcessesConfig } from "./config.ts";
import { ProcessLogWriter, readLogTail, type ProcessLogRead } from "./logs.ts";
import { OutputBuffer } from "./output-buffer.ts";
import { signalProcess, signalProcessGroup, spawnPipeProcess } from "./runner.ts";
import { resolveCwd, validateStartInput } from "./safety.ts";
import { compileWatches, findWatchMatches } from "./watches.ts";
import type {
	ClearProcessInput,
	ListProcessInput,
	LogsProcessInput,
	ManagedProcessInfo,
	ManagedProcessInternal,
	OutputStream,
	ProcessManagerEvent,
	ReadProcessInput,
	ReadResult,
	SignalProcessInput,
	StartProcessInput,
	StartProcessResult,
	WriteProcessInput,
} from "./types.ts";

const TERMINAL_STATUSES = new Set(["exited", "signaled", "failed", "orphaned", "unknown"]);

export class ProcessManager {
	private readonly processes = new Map<string, ManagedProcessInternal>();
	private readonly events = new EventEmitter();
	private counter = 0;
	private pendingStarts = 0;
	private shuttingDown = false;

	constructor(
		private readonly config: ProcessesConfig,
		private readonly onProcessEvent?: (event: ProcessManagerEvent) => void,
	) {
		this.events.setMaxListeners(200);
	}

	async start(input: StartProcessInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<StartProcessResult> {
		if (this.shuttingDown) throw new Error("process manager is shutting down");
		validateStartInput(input, this.config);
		this.reserveLiveSlot();

		let cwd: string;
		try {
			cwd = await resolveCwd(input.cwd, ctx, this.config);
		} catch (error) {
			this.releaseReservedLiveSlot();
			throw error;
		}

		const id = this.createId();
		const now = Date.now();
		const processRecord: ManagedProcessInternal = {
			id,
			name: input.name.trim(),
			command: input.command ?? null,
			argv: input.argv ? [...input.argv] : null,
			cwd,
			backend: input.backend ?? this.config.execution.defaultBackend,
			pid: null,
			pgid: null,
			status: "starting",
			startedAt: now,
			endedAt: null,
			exitCode: null,
			signal: null,
			stdinOpen: false,
			persistent: input.persistent ?? false,
			logFile: null,
			stdoutLogFile: null,
			stderrLogFile: null,
			alertPolicy: {
				alertOnExit: input.alertOnExit ?? this.config.alerts.defaultAlertOnExit,
				alertOnFailure: input.alertOnFailure ?? this.config.alerts.defaultAlertOnFailure,
				alertOnReady: input.alertOnReady ?? false,
			},
			stats: {
				stdoutBytes: 0,
				stderrBytes: 0,
				droppedBytes: 0,
				bufferedBytes: 0,
				logBytes: 0,
				lastOutputAt: null,
			},
			child: null,
			logWriter: null,
			watches: compileWatches(input.watches, this.config),
		};

		const buffer = new OutputBuffer({
			maxBytes: this.config.limits.maxBufferBytesPerProcess,
			maxChunkBytes: this.config.limits.maxChunkBytes,
		});
		Object.defineProperty(processRecord, "output", { value: buffer, enumerable: false });

		processRecord.logWriter = await ProcessLogWriter.create({ id, name: processRecord.name, cwd, config: this.config });
		if (processRecord.logWriter) {
			const logs = processRecord.logWriter.info();
			processRecord.logFile = logs.logFile;
			processRecord.stdoutLogFile = logs.stdoutLogFile;
			processRecord.stderrLogFile = logs.stderrLogFile;
		}

		this.processes.set(id, processRecord);
		this.releaseReservedLiveSlot();

		try {
			if (signal?.aborted) throw new Error("proc_start cancelled before spawn");

			const spawned = spawnPipeProcess(
				{ command: input.command, argv: input.argv, cwd, env: input.env },
				this.config,
			);
			processRecord.child = spawned.child;
			processRecord.pid = spawned.pid;
			processRecord.pgid = spawned.pgid;
			processRecord.stdinOpen = true;
			processRecord.status = "running";

			spawned.child.stdout.on("data", (data: Buffer) => this.appendOutput(id, "stdout", data));
			spawned.child.stderr.on("data", (data: Buffer) => this.appendOutput(id, "stderr", data));
			spawned.child.stdin.on("error", () => {
				processRecord.stdinOpen = false;
			});
			spawned.child.on("error", (error) => this.markFailed(id, error));
			spawned.child.on("exit", (code, childSignal) => this.markExited(id, code, childSignal));
			spawned.child.on("close", () => {
				processRecord.stdinOpen = false;
			});
		} catch (error) {
			processRecord.status = "failed";
			processRecord.endedAt = Date.now();
			this.appendOutput(id, "stderr", Buffer.from(`${error instanceof Error ? error.message : String(error)}\n`));
			this.events.emit(this.eventName(id));
		}

		const waitMs = clampWaitMs(input.waitMs, this.config);
		if (waitMs > 0 && !signal?.aborted) await this.waitForChange(id, 0, waitMs, signal);

		return {
			process: this.info(id),
			output: this.read({ id, afterSeq: 0, maxBytes: input.maxBytes }),
		};
	}

	read(input: ReadProcessInput): ReadResult {
		const processRecord = this.get(input.id);
		const buffer = this.bufferOf(processRecord);
		return buffer.read({
			id: processRecord.id,
			status: processRecord.status,
			afterSeq: input.afterSeq,
			maxBytes: clampReadBytes(input.maxBytes, this.config),
			stream: input.stream,
			exitCode: processRecord.exitCode,
			signal: processRecord.signal,
		});
	}

	async readWait(input: ReadProcessInput, signal?: AbortSignal): Promise<ReadResult> {
		const before = this.read(input);
		const waitMs = clampWaitMs(input.waitMs, this.config);
		if (before.chunks.length > 0 || before.exited || waitMs <= 0 || signal?.aborted) return before;
		await this.waitForChange(input.id, input.afterSeq ?? 0, waitMs, signal);
		return this.read(input);
	}

	list(input: ListProcessInput = {}): ManagedProcessInfo[] {
		return [...this.processes.values()]
			.filter((processRecord) => input.includeExited || !TERMINAL_STATUSES.has(processRecord.status))
			.filter((processRecord) => input.includePersistent || !processRecord.persistent)
			.map((processRecord) => this.toInfo(processRecord));
	}

	write(input: WriteProcessInput): ManagedProcessInfo {
		const processRecord = this.get(input.id);
		if (!processRecord.child || TERMINAL_STATUSES.has(processRecord.status)) throw new Error(`Process is not running: ${input.id}`);
		if (!processRecord.stdinOpen || processRecord.child.stdin.destroyed) throw new Error(`stdin is closed: ${input.id}`);
		processRecord.child.stdin.write(input.input);
		if (input.end) {
			processRecord.child.stdin.end();
			processRecord.stdinOpen = false;
		}
		return this.toInfo(processRecord);
	}

	async signal(input: SignalProcessInput): Promise<ManagedProcessInfo> {
		const processRecord = this.get(input.id);
		if (TERMINAL_STATUSES.has(processRecord.status)) return this.toInfo(processRecord);
		if (!processRecord.pid) throw new Error(`Process has no pid: ${input.id}`);

		processRecord.status = input.signal === "SIGKILL" ? "killing" : "killing";
		this.events.emit(this.eventName(processRecord.id));

		try {
			if (input.tree ?? true) signalProcessGroup(processRecord.pgid ?? processRecord.pid, input.signal);
			else signalProcess(processRecord.pid, input.signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				processRecord.status = "unknown";
				processRecord.endedAt = Date.now();
				void processRecord.logWriter?.close();
				return this.toInfo(processRecord);
			}
			throw error;
		}

		const timeoutMs = Math.max(0, Math.min(input.timeoutMs ?? 5000, this.config.limits.maxWaitMs));
		if (timeoutMs > 0) {
			await this.waitForTerminal(processRecord.id, timeoutMs);
			if (!TERMINAL_STATUSES.has(processRecord.status)) {
				processRecord.status = "kill_timeout";
			}
		}

		return this.toInfo(processRecord);
	}

	async logs(input: LogsProcessInput): Promise<ProcessLogRead | null> {
		const info = this.get(input.id).logWriter?.info();
		if (!info) return null;
		return readLogTail(info, { stream: input.stream, maxBytes: clampReadBytes(input.maxBytes, this.config) });
	}

	async clear(input: ClearProcessInput): Promise<{ cleared: string[]; remaining: ManagedProcessInfo[] }> {
		const cleared: string[] = [];
		const targets = input.allExited
			? [...this.processes.values()].filter((processRecord) => TERMINAL_STATUSES.has(processRecord.status))
			: input.id
				? [this.get(input.id)]
				: [];

		for (const processRecord of targets) {
			if (!TERMINAL_STATUSES.has(processRecord.status)) throw new Error(`Refusing to clear running process: ${processRecord.id}`);
			await processRecord.logWriter?.close();
			if (input.deleteLogs) await processRecord.logWriter?.deleteFiles();
			this.processes.delete(processRecord.id);
			cleared.push(processRecord.id);
		}

		return { cleared, remaining: this.list({ includeExited: true, includePersistent: true }) };
	}

	async shutdown(reason: string): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		const shouldKill = reason === "reload" ? this.config.execution.killOnReload : this.config.execution.killOnShutdown;
		if (!shouldKill) return;

		await Promise.allSettled(
			[...this.processes.values()]
				.filter((processRecord) => !TERMINAL_STATUSES.has(processRecord.status))
				.map((processRecord) => this.signal({ id: processRecord.id, signal: "SIGTERM", tree: true, timeoutMs: 1000 })),
		);

		await Promise.allSettled(
			[...this.processes.values()]
				.filter((processRecord) => !TERMINAL_STATUSES.has(processRecord.status))
				.map((processRecord) => this.signal({ id: processRecord.id, signal: "SIGKILL", tree: true, timeoutMs: 1000 })),
		);
	}

	formatList(includeExited = true): string {
		const processes = this.list({ includeExited, includePersistent: true });
		if (processes.length === 0) return "No managed processes.";
		return processes.map((processRecord) => formatProcessLine(processRecord)).join("\n");
	}

	formatRead(id: string, maxBytes?: number): string {
		const result = this.read({ id, maxBytes, stream: "combined" });
		const body = result.chunks.map((chunk) => chunk.text).join("");
		const status = `${result.id} ${result.status} nextSeq=${result.nextSeq}`;
		return body.length > 0 ? `${status}\n${body}` : `${status}\n(no buffered output)`;
	}

	resolveId(idOrName: string): string {
		if (this.processes.has(idOrName)) return idOrName;
		const matches = [...this.processes.values()].filter((processRecord) => processRecord.name === idOrName);
		if (matches.length === 1) return matches[0]!.id;
		if (matches.length > 1) throw new Error(`Ambiguous process name: ${idOrName}`);
		throw new Error(`Unknown process: ${idOrName}`);
	}

	private appendOutput(id: string, stream: OutputStream, data: Buffer): void {
		const processRecord = this.processes.get(id);
		if (!processRecord) return;
		const chunk = this.bufferOf(processRecord).append(stream, data);
		const logBytes = processRecord.logWriter?.append(stream, chunk.text) ?? 0;
		for (const match of findWatchMatches(processRecord.watches, stream, chunk.text, this.config.alerts.repeatWatchCooldownMs)) {
			this.onProcessEvent?.({
				type: "watch_match",
				process: this.toInfo(processRecord),
				pattern: match.watch.pattern,
				text: match.text,
				triggerTurn: match.watch.triggerTurn ?? true,
			});
		}
		if (stream === "stdout") processRecord.stats.stdoutBytes += chunk.byteLength;
		else processRecord.stats.stderrBytes += chunk.byteLength;
		processRecord.stats.logBytes += logBytes;
		processRecord.stats.bufferedBytes = this.bufferOf(processRecord).bufferedBytes;
		processRecord.stats.droppedBytes = this.bufferOf(processRecord).droppedByteCount;
		processRecord.stats.lastOutputAt = chunk.time;
		this.events.emit(this.eventName(id));
	}

	private markFailed(id: string, error: Error): void {
		const processRecord = this.processes.get(id);
		if (!processRecord || TERMINAL_STATUSES.has(processRecord.status)) return;
		processRecord.status = "failed";
		processRecord.endedAt = Date.now();
		this.appendOutput(id, "stderr", Buffer.from(`${error.message}\n`));
		void processRecord.logWriter?.close();
		this.events.emit(this.eventName(id));
		this.maybeEmitExitEvent(processRecord, false);
	}

	private markExited(id: string, code: number | null, childSignal: NodeJS.Signals | null): void {
		const processRecord = this.processes.get(id);
		if (!processRecord || TERMINAL_STATUSES.has(processRecord.status)) return;
		const wasKilling = processRecord.status === "killing" || processRecord.status === "kill_timeout";
		processRecord.exitCode = code;
		processRecord.signal = childSignal;
		processRecord.endedAt = Date.now();
		processRecord.stdinOpen = false;
		processRecord.status = childSignal ? "signaled" : "exited";
		void processRecord.logWriter?.close();
		this.events.emit(this.eventName(id));
		this.maybeEmitExitEvent(processRecord, wasKilling);
		this.enforceExitedRecordLimit();
	}

	private maybeEmitExitEvent(processRecord: ManagedProcessInternal, wasKilling: boolean): void {
		const failed = !wasKilling && (processRecord.status === "failed" || processRecord.status === "signaled" || (processRecord.exitCode ?? 0) !== 0);
		const triggerTurn = failed ? processRecord.alertPolicy.alertOnFailure : processRecord.alertPolicy.alertOnExit;
		if (!triggerTurn && !processRecord.alertPolicy.alertOnExit) return;
		if (failed && !processRecord.alertPolicy.alertOnFailure) return;

		this.onProcessEvent?.({
			type: "process_exit",
			process: this.toInfo(processRecord),
			triggerTurn,
		});
	}

	private async waitForChange(id: string, afterSeq: number, waitMs: number, signal?: AbortSignal): Promise<void> {
		if (waitMs <= 0 || signal?.aborted) return;
		const processRecord = this.get(id);
		const startNextSeq = Math.max(afterSeq + 1, this.bufferOf(processRecord).nextSeq);
		if (this.bufferOf(processRecord).nextSeq > startNextSeq || TERMINAL_STATUSES.has(processRecord.status)) return;

		await new Promise<void>((resolve) => {
			const event = this.eventName(id);
			let timer: NodeJS.Timeout;
			const done = () => {
				clearTimeout(timer);
				this.events.off(event, onChange);
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => done();
			const onChange = () => {
				const latest = this.processes.get(id);
				if (!latest) return done();
				if (this.bufferOf(latest).nextSeq > startNextSeq || TERMINAL_STATUSES.has(latest.status)) done();
			};

			timer = setTimeout(done, waitMs);
			this.events.on(event, onChange);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async waitForTerminal(id: string, waitMs: number): Promise<void> {
		if (waitMs <= 0) return;
		await new Promise<void>((resolve) => {
			const event = this.eventName(id);
			let timer: NodeJS.Timeout;
			const done = () => {
				clearTimeout(timer);
				this.events.off(event, onChange);
				resolve();
			};
			const onChange = () => {
				const processRecord = this.processes.get(id);
				if (!processRecord || TERMINAL_STATUSES.has(processRecord.status)) done();
			};
			timer = setTimeout(done, waitMs);
			this.events.on(event, onChange);
		});
	}

	private info(id: string): ManagedProcessInfo {
		return this.toInfo(this.get(id));
	}

	private get(id: string): ManagedProcessInternal {
		const processRecord = this.processes.get(id);
		if (!processRecord) throw new Error(`Unknown process: ${id}`);
		return processRecord;
	}

	private toInfo(processRecord: ManagedProcessInternal): ManagedProcessInfo {
		return {
			id: processRecord.id,
			name: processRecord.name,
			command: processRecord.command,
			argv: processRecord.argv ? [...processRecord.argv] : null,
			cwd: processRecord.cwd,
			backend: processRecord.backend,
			pid: processRecord.pid,
			pgid: processRecord.pgid,
			status: processRecord.status,
			startedAt: processRecord.startedAt,
			endedAt: processRecord.endedAt,
			exitCode: processRecord.exitCode,
			signal: processRecord.signal,
			stdinOpen: processRecord.stdinOpen,
			persistent: processRecord.persistent,
			logFile: processRecord.logFile,
			stdoutLogFile: processRecord.stdoutLogFile,
			stderrLogFile: processRecord.stderrLogFile,
			alertPolicy: { ...processRecord.alertPolicy },
			stats: { ...processRecord.stats },
		};
	}

	private bufferOf(processRecord: ManagedProcessInternal): OutputBuffer {
		return (processRecord as unknown as { output: OutputBuffer }).output;
	}

	private reserveLiveSlot(): void {
		const live = [...this.processes.values()].filter((processRecord) => !TERMINAL_STATUSES.has(processRecord.status)).length;
		if (live + this.pendingStarts >= this.config.limits.maxProcesses) {
			throw new Error(`Process limit reached (${this.config.limits.maxProcesses})`);
		}
		this.pendingStarts += 1;
	}

	private releaseReservedLiveSlot(): void {
		this.pendingStarts = Math.max(0, this.pendingStarts - 1);
	}

	private enforceExitedRecordLimit(): void {
		const exited = [...this.processes.values()]
			.filter((processRecord) => TERMINAL_STATUSES.has(processRecord.status))
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		while (exited.length > this.config.limits.maxExitedRecords) {
			const oldest = exited.shift();
			if (oldest) {
				void oldest.logWriter?.close();
				this.processes.delete(oldest.id);
			}
		}
	}

	private createId(): string {
		this.counter += 1;
		return `p_${Date.now().toString(36)}_${this.counter.toString(36)}`;
	}

	private eventName(id: string): string {
		return `process:${id}`;
	}
}

export function formatProcessLine(processRecord: ManagedProcessInfo): string {
	const command = processRecord.command ?? processRecord.argv?.join(" ") ?? "";
	const pid = processRecord.pid ? ` pid=${processRecord.pid}` : "";
	const exit = processRecord.exitCode === null ? "" : ` exit=${processRecord.exitCode}`;
	return `${processRecord.id} [${processRecord.status}] ${processRecord.name}${pid}${exit} — ${command}`;
}
