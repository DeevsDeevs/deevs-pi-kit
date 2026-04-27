import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { clampReadBytes, clampWaitMs, type ProcessesConfig } from "./config.ts";
import { ProcessLogWriter, readLogTail, type ProcessLogRead } from "./logs.ts";
import { OutputBuffer } from "./output-buffer.ts";
import { spawnPtyProcess } from "./pty-runner.ts";
import { signalProcess, signalProcessGroup, spawnPipeProcess } from "./runner.ts";
import { resolveCwd, validateStartInput } from "./safety.ts";
import { getStateFile, readStateFile, writeStateFile, type PersistentProcessRecord, type PersistentWatchRecord } from "./state.ts";
import {
	captureTmuxPane,
	getTmuxExitMarker,
	hasTmuxSession,
	killTmuxSession,
	sendTmuxInput,
	signalTmuxSession,
	startTmuxProcess,
} from "./tmux-runner.ts";
import { compileWatches, findWatchMatches, type RuntimeWatch } from "./watches.ts";
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
const OUTPUT_CHANGE_THROTTLE_MS = 250;

export class ProcessManager {
	private readonly processes = new Map<string, ManagedProcessInternal>();
	private readonly events = new EventEmitter();
	private readonly changeListeners = new Set<() => void>();
	private counter = 0;
	private pendingStarts = 0;
	private stateFile: string | null = null;
	private shuttingDown = false;
	private changeTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly config: ProcessesConfig,
		private readonly onProcessEvent?: (event: ProcessManagerEvent) => void,
	) {
		this.events.setMaxListeners(200);
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	getConfig(): ProcessesConfig {
		return this.config;
	}

	notifySettingsChanged(): void {
		this.emitChange();
	}

	isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	async restore(ctx: ExtensionContext): Promise<void> {
		this.stateFile = getStateFile(ctx.cwd);
		const state = await readStateFile(this.stateFile);
		let changed = false;

		for (const saved of state.processes) {
			if (this.processes.has(saved.id) || saved.backend !== "tmux" || !saved.tmuxSession) continue;
			const running = await hasTmuxSession(saved.tmuxSession);
			if (!running) {
				changed = true;
				continue;
			}
			await this.restoreTmuxProcess(saved);
		}

		if (changed) void this.savePersistentState();
	}

	async start(input: StartProcessInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<StartProcessResult> {
		if (this.shuttingDown) throw new Error("process manager is shutting down");
		validateStartInput(input, this.config);
		this.reserveLiveSlot();
		let slotReserved = true;

		let cwd: string;
		try {
			cwd = await resolveCwd(input.cwd, ctx, this.config);
		} catch (error) {
			if (slotReserved) {
				this.releaseReservedLiveSlot();
				slotReserved = false;
			}
			throw error;
		}

		const id = this.createId();
		if (!this.stateFile) this.stateFile = getStateFile(ctx.cwd);

		const now = Date.now();
		const backend = input.persistent && !input.backend ? "tmux" : (input.backend ?? this.config.execution.defaultBackend);
		let watches: RuntimeWatch[];
		try {
			watches = compileWatches(input.watches, this.config);
		} catch (error) {
			if (slotReserved) {
				this.releaseReservedLiveSlot();
				slotReserved = false;
			}
			throw error;
		}
		const processRecord: ManagedProcessInternal = {
			id,
			name: input.name.trim(),
			command: input.command ?? null,
			argv: input.argv ? [...input.argv] : null,
			cwd,
			backend,
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
			ptyProcess: null,
			logWriter: null,
			tmuxSession: null,
			tmuxLastCapture: "",
			tmuxPollTimer: null,
			watches,
		};

		const buffer = new OutputBuffer({
			maxBytes: this.config.limits.maxBufferBytesPerProcess,
			maxChunkBytes: this.config.limits.maxChunkBytes,
		});
		Object.defineProperty(processRecord, "output", { value: buffer, enumerable: false });

		try {
			processRecord.logWriter = await ProcessLogWriter.create({ id, name: processRecord.name, cwd, config: this.config });
		} catch (error) {
			if (slotReserved) {
				this.releaseReservedLiveSlot();
				slotReserved = false;
			}
			throw error;
		}
		if (processRecord.logWriter) {
			const logs = processRecord.logWriter.info();
			processRecord.logFile = logs.logFile;
			processRecord.stdoutLogFile = logs.stdoutLogFile;
			processRecord.stderrLogFile = logs.stderrLogFile;
		}

		this.processes.set(id, processRecord);
		if (slotReserved) {
			this.releaseReservedLiveSlot();
			slotReserved = false;
		}

		try {
			if (signal?.aborted) throw new Error("proc_start cancelled before spawn");

			if (processRecord.backend === "tmux") {
				const session = `pi_${id}`;
				await startTmuxProcess({ session, command: input.command, argv: input.argv, cwd, config: this.config });
				processRecord.tmuxSession = session;
				processRecord.stdinOpen = true;
				processRecord.status = "running";
				this.startTmuxPolling(id);
			} else if (processRecord.backend === "pty") {
				const spawned = await spawnPtyProcess({ command: input.command, argv: input.argv, cwd, env: input.env }, this.config);
				processRecord.ptyProcess = spawned;
				processRecord.pid = spawned.pid;
				processRecord.pgid = spawned.pid;
				processRecord.stdinOpen = true;
				processRecord.status = "running";
				spawned.onData((data) => this.appendOutput(id, "stdout", Buffer.from(data)));
				spawned.onExit((event) => this.markExited(id, event.exitCode, ptySignalName(event.signal)));
			} else {
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
				spawned.child.on("close", (code, childSignal) => {
					processRecord.stdinOpen = false;
					this.markExited(id, code, childSignal);
				});
			}
		} catch (error) {
			processRecord.status = "failed";
			processRecord.endedAt = Date.now();
			this.appendOutput(id, "stderr", Buffer.from(`${error instanceof Error ? error.message : String(error)}\n`));
			this.events.emit(this.eventName(id));
		}

		if (processRecord.persistent) void this.savePersistentState();
		this.emitChange();

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
			.filter((processRecord) => input.includePersistent !== false || !processRecord.persistent)
			.map((processRecord) => this.toInfo(processRecord));
	}

	write(input: WriteProcessInput): ManagedProcessInfo {
		const processRecord = this.get(input.id);
		if (TERMINAL_STATUSES.has(processRecord.status)) throw new Error(`Process is not running: ${input.id}`);
		if (processRecord.tmuxSession) {
			void sendTmuxInput(processRecord.tmuxSession, input.input);
			return this.toInfo(processRecord);
		}
		if (processRecord.ptyProcess) {
			processRecord.ptyProcess.write(input.input);
			return this.toInfo(processRecord);
		}
		if (!processRecord.child) throw new Error(`Process is not running: ${input.id}`);
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
		if (!processRecord.pid && !processRecord.tmuxSession && !processRecord.ptyProcess) throw new Error(`Process has no pid/session: ${input.id}`);

		processRecord.status = "killing";
		this.events.emit(this.eventName(processRecord.id));

		try {
			if (processRecord.tmuxSession) {
				await signalTmuxSession(processRecord.tmuxSession, input.signal);
				if (input.signal !== "SIGINT") this.markExited(processRecord.id, null, input.signal);
			} else if (processRecord.ptyProcess) {
				processRecord.ptyProcess.kill(input.signal);
			} else if (input.tree ?? true) signalProcessGroup(processRecord.pgid ?? processRecord.pid!, input.signal);
			else signalProcess(processRecord.pid!, input.signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				processRecord.status = "unknown";
				processRecord.endedAt = Date.now();
				if (processRecord.tmuxPollTimer) clearInterval(processRecord.tmuxPollTimer);
				processRecord.tmuxPollTimer = null;
				void processRecord.logWriter?.close();
				void this.savePersistentState();
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
			if (processRecord.tmuxPollTimer) clearInterval(processRecord.tmuxPollTimer);
			await processRecord.logWriter?.close();
			if (input.deleteLogs) await processRecord.logWriter?.deleteFiles();
			this.processes.delete(processRecord.id);
			cleared.push(processRecord.id);
		}

		void this.savePersistentState();
		this.emitChange();
		return { cleared, remaining: this.list({ includeExited: true, includePersistent: true }) };
	}

	async shutdown(reason: string): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		const shouldKill = reason === "reload" ? this.config.execution.killOnReload : this.config.execution.killOnShutdown;
		const persistentSurvivors = [...this.processes.values()]
			.filter((processRecord) => processRecord.persistent && !TERMINAL_STATUSES.has(processRecord.status));
		for (const processRecord of persistentSurvivors) {
			if (processRecord.tmuxPollTimer) clearInterval(processRecord.tmuxPollTimer);
			processRecord.tmuxPollTimer = null;
			void processRecord.logWriter?.close();
			processRecord.logWriter = null;
		}
		if (!shouldKill) return;

		const targets = [...this.processes.values()]
			.filter((processRecord) => !processRecord.persistent && !TERMINAL_STATUSES.has(processRecord.status));
		if (targets.length > 0) {
			for (const processRecord of targets) processRecord.suppressNextExitEvent = true;
			this.onProcessEvent?.({
				type: "shutdown_cleanup",
				processes: targets.map((processRecord) => this.toInfo(processRecord)),
				reason,
				triggerTurn: false,
			});
		}

		await Promise.allSettled(
			targets.map((processRecord) => this.signal({ id: processRecord.id, signal: "SIGTERM", tree: true, timeoutMs: 1000 })),
		);

		await Promise.allSettled(
			targets
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
		const matches = findWatchMatches(processRecord.watches, stream, chunk.text, this.config.alerts.repeatWatchCooldownMs);
		if (matches.length > 0 && processRecord.persistent) void this.savePersistentState();
		for (const match of matches) {
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
		this.emitChange(OUTPUT_CHANGE_THROTTLE_MS);
	}

	private markFailed(id: string, error: Error): void {
		const processRecord = this.processes.get(id);
		if (!processRecord || TERMINAL_STATUSES.has(processRecord.status)) return;
		processRecord.status = "failed";
		processRecord.endedAt = Date.now();
		if (processRecord.tmuxPollTimer) clearInterval(processRecord.tmuxPollTimer);
		processRecord.tmuxPollTimer = null;
		this.appendOutput(id, "stderr", Buffer.from(`${error.message}\n`));
		void processRecord.logWriter?.close();
		this.events.emit(this.eventName(id));
		this.emitChange();
		this.maybeEmitExitEvent(processRecord, false);
		void this.savePersistentState();
	}

	private markExited(id: string, code: number | null, childSignal: NodeJS.Signals | null): void {
		const processRecord = this.processes.get(id);
		if (!processRecord || TERMINAL_STATUSES.has(processRecord.status)) return;
		const wasKilling = processRecord.status === "killing" || processRecord.status === "kill_timeout";
		processRecord.exitCode = code;
		processRecord.signal = childSignal;
		processRecord.endedAt = Date.now();
		processRecord.stdinOpen = false;
		processRecord.ptyProcess = null;
		if (processRecord.tmuxPollTimer) clearInterval(processRecord.tmuxPollTimer);
		processRecord.tmuxPollTimer = null;
		processRecord.status = childSignal ? "signaled" : "exited";
		void processRecord.logWriter?.close();
		this.events.emit(this.eventName(id));
		this.emitChange();
		this.maybeEmitExitEvent(processRecord, wasKilling);
		void this.savePersistentState();
		this.enforceExitedRecordLimit();
	}

	private async restoreTmuxProcess(saved: PersistentProcessRecord): Promise<void> {
		const processRecord: ManagedProcessInternal = {
			id: saved.id,
			name: saved.name,
			command: saved.command,
			argv: saved.argv ? [...saved.argv] : null,
			cwd: saved.cwd,
			backend: saved.backend,
			pid: null,
			pgid: null,
			status: "running",
			startedAt: saved.startedAt,
			endedAt: null,
			exitCode: null,
			signal: null,
			stdinOpen: true,
			persistent: true,
			logFile: null,
			stdoutLogFile: null,
			stderrLogFile: null,
			alertPolicy: { ...saved.alertPolicy },
			stats: {
				stdoutBytes: 0,
				stderrBytes: 0,
				droppedBytes: 0,
				bufferedBytes: 0,
				logBytes: 0,
				lastOutputAt: null,
			},
			child: null,
			ptyProcess: null,
			logWriter: null,
			tmuxSession: saved.tmuxSession,
			tmuxLastCapture: "",
			tmuxPollTimer: null,
			watches: restoreWatches(saved.watches, this.config),
		};

		const buffer = new OutputBuffer({
			maxBytes: this.config.limits.maxBufferBytesPerProcess,
			maxChunkBytes: this.config.limits.maxChunkBytes,
		});
		Object.defineProperty(processRecord, "output", { value: buffer, enumerable: false });

		processRecord.logWriter = await ProcessLogWriter.create({ id: saved.id, name: saved.name, cwd: saved.cwd, config: this.config });
		if (processRecord.logWriter) {
			const logs = processRecord.logWriter.info();
			processRecord.logFile = logs.logFile;
			processRecord.stdoutLogFile = logs.stdoutLogFile;
			processRecord.stderrLogFile = logs.stderrLogFile;
		}

		try {
			const captured = await captureTmuxPane(saved.tmuxSession);
			const marker = getTmuxExitMarker(saved.tmuxSession);
			const markerIndex = captured.indexOf(marker);
			processRecord.tmuxLastCapture = markerIndex >= 0 ? captured.slice(0, markerIndex) : captured;
		} catch {
			processRecord.tmuxLastCapture = "";
		}

		this.processes.set(saved.id, processRecord);
		this.startTmuxPolling(saved.id);
		this.emitChange();
	}

	private async savePersistentState(): Promise<void> {
		if (!this.stateFile) return;
		const processes: PersistentProcessRecord[] = [...this.processes.values()]
			.filter((processRecord) => processRecord.persistent && !TERMINAL_STATUSES.has(processRecord.status))
			.map((processRecord) => ({
				id: processRecord.id,
				name: processRecord.name,
				command: processRecord.command,
				argv: processRecord.argv ? [...processRecord.argv] : null,
				cwd: processRecord.cwd,
				backend: processRecord.backend,
				tmuxSession: processRecord.tmuxSession,
				startedAt: processRecord.startedAt,
				alertPolicy: { ...processRecord.alertPolicy },
				watches: processRecord.watches.map((watch) => ({
					pattern: watch.pattern,
					mode: watch.mode,
					stream: watch.stream,
					repeat: watch.repeat,
					triggerTurn: watch.triggerTurn,
					fired: watch.fired,
					lastTriggeredAt: watch.lastTriggeredAt,
				})),
			}));
		await writeStateFile(this.stateFile, { version: 1, processes });
	}

	private startTmuxPolling(id: string): void {
		const processRecord = this.get(id);
		if (!processRecord.tmuxSession) return;

		const poll = () => {
			void this.pollTmux(id);
		};
		processRecord.tmuxPollTimer = setInterval(poll, 300);
		poll();
	}

	private async pollTmux(id: string): Promise<void> {
		const processRecord = this.processes.get(id);
		if (!processRecord?.tmuxSession || TERMINAL_STATUSES.has(processRecord.status)) return;

		const session = processRecord.tmuxSession;
		let captured = "";
		try {
			captured = await captureTmuxPane(session);
		} catch {
			if (!(await hasTmuxSession(session))) {
				this.markExited(id, processRecord.exitCode, processRecord.signal);
			}
			return;
		}

		const marker = getTmuxExitMarker(session);
		const markerIndex = captured.indexOf(marker);
		let exitCode: number | null = null;
		if (markerIndex >= 0) {
			const match = captured.slice(markerIndex).match(/^__PI_EXIT_[^:]+:(\d+)__/);
			exitCode = match ? Number(match[1]) : 0;
			captured = captured.slice(0, markerIndex);
		}

		if (captured.startsWith(processRecord.tmuxLastCapture)) {
			const delta = captured.slice(processRecord.tmuxLastCapture.length);
			if (delta) this.appendOutput(id, "stdout", Buffer.from(delta));
		} else if (captured !== processRecord.tmuxLastCapture) {
			this.appendOutput(id, "stdout", Buffer.from(captured));
		}
		processRecord.tmuxLastCapture = captured;

		if (exitCode !== null) {
			await killTmuxSession(session);
			this.markExited(id, exitCode, null);
		}
	}

	private maybeEmitExitEvent(processRecord: ManagedProcessInternal, wasKilling: boolean): void {
		if (processRecord.suppressNextExitEvent) {
			processRecord.suppressNextExitEvent = false;
			return;
		}
		if (wasKilling && processRecord.status === "signaled") {
			processRecord.suppressNextExitEvent = true;
		}
		const failed = !wasKilling && (processRecord.status === "failed" || processRecord.status === "signaled" || (processRecord.exitCode ?? 0) !== 0);
		const triggerTurn = failed ? processRecord.alertPolicy.alertOnFailure : processRecord.alertPolicy.alertOnExit;

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

	private emitChange(throttleMs = 0): void {
		if (throttleMs <= 0) {
			this.flushChange();
			return;
		}
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => this.flushChange(), throttleMs);
		this.changeTimer.unref?.();
	}

	private flushChange(): void {
		if (this.changeTimer) {
			clearTimeout(this.changeTimer);
			this.changeTimer = null;
		}
		for (const listener of this.changeListeners) listener();
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

function restoreWatches(saved: PersistentWatchRecord[] | undefined, config: ProcessesConfig) {
	const watches = compileWatches(saved, config);
	for (let i = 0; i < watches.length; i += 1) {
		const savedWatch = saved?.[i];
		if (!savedWatch) continue;
		watches[i]!.fired = savedWatch.fired ?? false;
		watches[i]!.lastTriggeredAt = savedWatch.lastTriggeredAt ?? 0;
	}
	return watches;
}

function ptySignalName(signal: number | undefined): NodeJS.Signals | null {
	if (signal === undefined || signal === 0) return null;
	const signals: Record<number, NodeJS.Signals> = {
		1: "SIGHUP",
		2: "SIGINT",
		3: "SIGQUIT",
		6: "SIGABRT",
		9: "SIGKILL",
		14: "SIGALRM",
		15: "SIGTERM",
	};
	return signals[signal] ?? (`SIG${signal}` as NodeJS.Signals);
}

export function formatProcessLine(processRecord: ManagedProcessInfo): string {
	const command = processRecord.command ?? processRecord.argv?.join(" ") ?? "";
	const pid = processRecord.pid ? ` pid=${processRecord.pid}` : "";
	const exit = processRecord.exitCode === null ? "" : ` exit=${processRecord.exitCode}`;
	return `${processRecord.id} [${processRecord.status}] ${processRecord.name}${pid}${exit} — ${command}`;
}
