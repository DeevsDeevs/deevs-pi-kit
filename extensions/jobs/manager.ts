import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectDetachedArgv, detectDetachedShell } from "../shared/process-safety.ts";
import { ownsProcessIdentity, quiesceProcessGroup, readProcessIdentity, trySignalGroup } from "../shared/process-group.ts";
import { requestRuntimeDelivery } from "../shared/runtime-delivery.ts";
import { consumeRuntimeEvent, runtimeEvents } from "../shared/runtime-events.ts";
import { JobBuffer } from "./buffer.ts";
import type { JobChunk, JobReadInput, JobReadResult, JobRecord, JobRuntime, JobSpec, JobStartInput, JobStatus, JobStream } from "./types.ts";

const TERMINAL = new Set<JobStatus>(["completed", "failed", "cancelled", "timeout", "lost"]);
const MAX_LOG_BYTES = 10_000_000;
const MAX_READY_TEXT_BYTES = 65_536;

interface ActiveJob {
	record: JobRecord;
	child: ChildProcessWithoutNullStreams;
	timer: NodeJS.Timeout;
	readyTimer?: NodeJS.Timeout;
	readyText: string;
	heartbeatTimer?: NodeJS.Timeout;
	requestedStatus?: JobStatus;
	killTimer?: NodeJS.Timeout;
}

export class JobManager {
	private readonly records = new Map<string, JobRecord>();
	private readonly active = new Map<string, ActiveJob>();
	private readonly buffers = new Map<string, JobBuffer>();
	private readonly staleTimers = new Map<string, NodeJS.Timeout>();
	private readonly hidden = new Set<string>();
	private readonly events = new EventEmitter();
	private parentSessionFile?: string;

	constructor(private pi: ExtensionAPI) {}

	setExtensionApi(pi: ExtensionAPI): void {
		this.pi = pi;
	}

	onChange(listener: (job: JobRecord) => void): () => void {
		this.events.on("change", listener);
		return () => this.events.off("change", listener);
	}

	list(): JobRecord[] {
		return [...this.records.values()]
			.filter((record) => !this.hidden.has(record.spec.id) && record.spec.parentSessionFile === this.parentSessionFile)
			.sort((a, b) => b.runtime.startedAt - a.runtime.startedAt);
	}

	clearTerminal(id?: string): number {
		const candidates = this.list().filter((record) => (!id || record.spec.id === id) && TERMINAL.has(record.runtime.status));
		let cleared = 0;
		for (const record of candidates) {
			if (!TERMINAL.has(record.runtime.status)) continue;
			consumeRuntimeEvent(this.pi, `terminal:${record.spec.id}:${record.spec.generation}`, this.parentSessionFile ?? "job-manager");
			this.records.delete(record.spec.id);
			this.buffers.delete(record.spec.id);
			rmSync(record.spec.artifactsDir, { recursive: true, force: true });
			cleared++;
		}
		return cleared;
	}

	get(id: string): JobRecord {
		const record = this.records.get(id);
		if (!record || this.hidden.has(id) || record.spec.parentSessionFile !== this.parentSessionFile) throw new Error(`Unknown job: ${id}`);
		return record;
	}

	async start(input: JobStartInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<JobRecord> {
		validateStart(input);
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		await this.switchSession(parentSessionFile);
		const detachedReason = input.command ? detectDetachedShell(input.command) : detectDetachedArgv(input.argv ?? []);
		if (detachedReason) throw new Error(detachedReason);
		const id = `j_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const generation = randomUUID();
		const root = jobsRoot(ctx.cwd);
		const artifactsDir = path.join(root, id);
		mkdirSync(artifactsDir, { recursive: true });
		const spec: JobSpec = {
			id,
			generation,
			name: input.name.trim(),
			command: input.command,
			argv: input.argv,
			cwd: path.resolve(input.cwd ?? ctx.cwd),
			timeoutMs: clamp(input.timeoutMs, 1_000, 15 * 60_000, 5 * 60_000),
			maxBufferBytes: clamp(input.maxBytes, 1_024, 4_000_000, 1_000_000),
			readyPattern: input.readyPattern,
			readyMode: input.readyMode,
			readyTimeoutMs: input.readyPattern ? clamp(input.readyTimeoutMs, 100, 5 * 60_000, 30_000) : undefined,
			createdAt: Date.now(),
			parentSessionFile,
			artifactsDir,
			runtimePath: path.join(artifactsDir, "runtime.json"),
			logPath: path.join(artifactsDir, "combined.log"),
			spoolPath: path.join(artifactsDir, "chunks.jsonl"),
		};
		const runtime: JobRuntime = { version: 1, id, status: "starting", startedAt: Date.now(), ready: !input.readyPattern, bufferedBytes: 0, droppedBytes: 0, logBytes: 0, logTruncated: false, spoolBytes: 0 };
		const record = { spec, runtime };
		writeJson(path.join(artifactsDir, "spec.json"), spec);
		writeJson(spec.runtimePath, runtime);
		this.records.set(id, record);
		this.buffers.set(id, new JobBuffer(spec.maxBufferBytes));
		runtimeEvents.record(this.pi, { type: "activate", source: { kind: "job", id }, generation });

		const childEnv = { ...process.env, ...input.env, DEEVS_PI_JOB_ID: id, DEEVS_PI_JOB_GENERATION: generation };
		const child = input.argv
			? spawn(input.argv[0]!, input.argv.slice(1), { cwd: spec.cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] })
			: spawn(process.env.SHELL || "/bin/bash", ["-lc", input.command!], { cwd: spec.cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		try {
			await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
		} catch (error) {
			return this.finish(record, "failed", error instanceof Error ? error.message : String(error));
		}
		if (!child.pid || !child.stdin || !child.stdout || !child.stderr) return this.finish(record, "failed", "Job spawned without piped stdio.");
		let earlyClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, childSignal) => {
			earlyClose = { code, signal: childSignal };
			resolve(earlyClose);
		}));
		const timer = setTimeout(() => void this.stop(id, "timeout"), spec.timeoutMs);
		timer.unref?.();
		const active: ActiveJob = { record, child: child as ChildProcessWithoutNullStreams, timer, readyText: "" };
		this.active.set(id, active);
		child.stdout.on("data", (chunk: Buffer) => this.append(id, "stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => this.append(id, "stderr", chunk));
		if (input.stdin !== undefined) child.stdin.write(input.stdin);
		child.stdin.end();

		const processIdentity = await readProcessIdentity(child.pid);
		if (!processIdentity) {
			if (!earlyClose) await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 10))]);
			if (!earlyClose) {
				active.requestedStatus = "failed";
				runtime.error = "Job process identity could not be established; the process was not published as running.";
				trySignalGroup(child.pid, "SIGKILL");
			}
			const result = await closed;
			await this.onClose(id, result.code, result.signal);
			return record;
		}
		runtime.status = "running";
		runtime.pid = child.pid;
		runtime.processIdentity = processIdentity;
		runtime.heartbeatAt = Date.now();
		writeJson(spec.runtimePath, runtime);
		active.heartbeatTimer = setInterval(() => {
			record.runtime.heartbeatAt = Date.now();
			writeJson(record.spec.runtimePath, record.runtime);
		}, 5_000);
		active.heartbeatTimer.unref?.();
		if (!runtime.ready && spec.readyPattern && spec.readyTimeoutMs) {
			active.readyTimer = setTimeout(() => void this.stop(id, "failed", `Readiness pattern was not observed within ${spec.readyTimeoutMs}ms.`), spec.readyTimeoutMs);
			active.readyTimer.unref?.();
		}
		void closed.then(({ code, signal: childSignal }) => this.onClose(id, code, childSignal));
		this.emit(record);
		if (signal?.aborted) await this.stop(id, "cancelled", "Job start aborted.");
		if (spec.readyPattern) return this.waitReady(id, spec.readyTimeoutMs, signal);
		return record;
	}

	read(input: JobReadInput): JobReadResult {
		const job = this.get(input.id);
		const buffer = this.buffers.get(input.id) ?? new JobBuffer();
		return buffer.read(job, input.afterSeq, clamp(input.maxBytes, 1, 262_144, 65_536), input.stream);
	}

	async wait(ids: string[], waitMs?: number, signal?: AbortSignal): Promise<JobRecord[]> {
		return Promise.all(ids.map((id) => this.waitOne(id, waitMs, signal)));
	}

	consumeTerminal(records: JobRecord[], claimant: string): void {
		for (const record of records) if (TERMINAL.has(record.runtime.status)) consumeRuntimeEvent(this.pi, `terminal:${record.spec.id}:${record.spec.generation}`, claimant);
	}

	async stop(id: string, status: "cancelled" | "timeout" | "failed" = "cancelled", error?: string): Promise<JobRecord> {
		return this.stopRecord(this.get(id), status, error);
	}

	private async stopRecord(record: JobRecord, status: "cancelled" | "timeout" | "failed", error?: string): Promise<JobRecord> {
		if (TERMINAL.has(record.runtime.status)) return record;
		const id = record.spec.id;
		const active = this.active.get(id);
		if (!active?.child.pid) {
			const quiesced = record.runtime.pid ? await stopStaleProcess(record.runtime.pid, record.runtime.processIdentity) : true;
			if (quiesced) return this.finish(record, "lost", "Job process ownership was unavailable after its process group quiesced.");
			record.runtime.status = "stopping";
			record.runtime.error = "Known stale Job process group has not quiesced; terminal settlement is withheld.";
			writeJson(record.spec.runtimePath, record.runtime);
			this.emit(record);
			this.scheduleStaleReconciliation(record);
			return record;
		}
		clearTimeout(active.timer);
		if (active.readyTimer) clearTimeout(active.readyTimer);
		active.requestedStatus = status;
		record.runtime.status = "stopping";
		if (error) record.runtime.error = error;
		writeJson(record.spec.runtimePath, record.runtime);
		this.emit(record);
		trySignalGroup(active.child.pid, "SIGTERM");
		if (!active.killTimer) {
			active.killTimer = setTimeout(() => trySignalGroup(active.child.pid!, "SIGKILL"), 1_500);
			active.killTimer.unref?.();
		}
		return this.waitOne(id, 3_000, undefined, true);
	}

	async restore(ctx: ExtensionContext): Promise<void> {
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		await this.switchSession(parentSessionFile);
		if (!parentSessionFile) return;
		const root = jobsRoot(ctx.cwd);
		if (!existsSync(root)) return;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const dir = path.join(root, entry.name);
				const spec = JSON.parse(readFileSync(path.join(dir, "spec.json"), "utf8")) as JobSpec;
				if (spec.parentSessionFile !== parentSessionFile) continue;
				const runtime = JSON.parse(readFileSync(spec.runtimePath, "utf8")) as JobRuntime;
				spec.spoolPath ??= path.join(spec.artifactsDir, "chunks.jsonl");
				spec.maxBufferBytes ??= 1_000_000;
				runtime.spoolBytes ??= 0;
				if (this.active.has(spec.id)) continue;
				const record = { spec, runtime };
				if (!TERMINAL.has(runtime.status)) {
					const quiesced = runtime.pid ? await stopStaleProcess(runtime.pid, runtime.processIdentity) : true;
					record.runtime = quiesced
						? { ...runtime, status: "lost", endedAt: Date.now(), error: "Job parent session restarted before bounded settlement." }
						: { ...runtime, status: "stopping", error: "Stale Job process group has not quiesced; terminal settlement is withheld." };
					writeJson(spec.runtimePath, record.runtime);
				}
				this.records.set(spec.id, record);
				const buffer = new JobBuffer(spec.maxBufferBytes);
				if (existsSync(spec.spoolPath)) {
					const records = readFileSync(spec.spoolPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
						try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
					});
					const metadata = [...records].reverse().find((item) => item.type === "meta") as { nextSeq?: number; droppedBytes?: number } | undefined;
					const chunks = records.filter((item) => Number.isInteger(item.seq)) as unknown as JobChunk[];
					buffer.restore(chunks, metadata);
				}
				this.buffers.set(spec.id, buffer);
				if (record.runtime.status === "lost") this.emitTerminal(record);
				else if (record.runtime.status === "stopping") this.scheduleStaleReconciliation(record);
			} catch {
				// Keep other job artifacts available when one record is corrupt.
			}
		}
		this.pruneTerminal();
	}

	private async switchSession(parentSessionFile?: string): Promise<void> {
		if (this.parentSessionFile === parentSessionFile) return;
		this.parentSessionFile = parentSessionFile;
		await Promise.all([...this.records.values()].filter((record) => record.spec.parentSessionFile !== parentSessionFile).map(async (record) => {
			this.hidden.add(record.spec.id);
			if (!TERMINAL.has(record.runtime.status)) await this.stopRecord(record, "cancelled", "Parent Pi session changed.");
			if (TERMINAL.has(record.runtime.status)) {
				this.hidden.delete(record.spec.id);
				this.records.delete(record.spec.id);
				this.buffers.delete(record.spec.id);
			}
		}));
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.active.keys()].flatMap((id) => {
			const record = this.records.get(id);
			return record ? [this.stopRecord(record, "cancelled", "Pi session shut down.")] : [];
		}));
		for (const timer of this.staleTimers.values()) clearTimeout(timer);
		this.staleTimers.clear();
		this.events.removeAllListeners();
	}

	terminateActiveSync(): void {
		for (const active of this.active.values()) if (active.child.pid) trySignalGroup(active.child.pid, "SIGKILL");
	}

	private append(id: string, stream: JobStream, data: Buffer): void {
		const active = this.active.get(id);
		const buffer = this.buffers.get(id);
		if (!active || !buffer) return;
		const chunk = buffer.append(stream, data);
		const runtime = active.record.runtime;
		runtime.lastOutputAt = chunk.at;
		runtime.bufferedBytes = buffer.bufferedBytes;
		runtime.droppedBytes = buffer.droppedBytes;
		const metadata = { type: "meta", nextSeq: buffer.nextSeq, droppedBytes: buffer.droppedBytes };
		const addition = `${JSON.stringify(chunk)}\n${JSON.stringify(metadata)}\n`;
		appendFileSync(active.record.spec.spoolPath, addition, { encoding: "utf8", mode: 0o600 });
		runtime.spoolBytes += Buffer.byteLength(addition);
		if (runtime.spoolBytes > active.record.spec.maxBufferBytes * 2) {
			const compact = [...buffer.snapshot(), metadata].map((item) => JSON.stringify(item)).join("\n") + "\n";
			writeTextAtomic(active.record.spec.spoolPath, compact);
			runtime.spoolBytes = Buffer.byteLength(compact);
		}
		if (!runtime.logTruncated) {
			const remaining = MAX_LOG_BYTES - runtime.logBytes;
			if (remaining > 0) {
				const text = Buffer.from(`[${stream}] ${chunk.text}`);
				const clipped = text.subarray(0, remaining);
				appendFileSync(active.record.spec.logPath, clipped, { mode: 0o600 });
				runtime.logBytes += clipped.length;
			}
			if (runtime.logBytes >= MAX_LOG_BYTES) runtime.logTruncated = true;
		}
		let becameReady = false;
		if (!runtime.ready) {
			active.readyText = Buffer.from(active.readyText + chunk.text).subarray(-MAX_READY_TEXT_BYTES).toString("utf8");
			becameReady = matchesReady(active.record.spec, active.readyText);
		}
		if (becameReady) {
			runtime.ready = true;
			runtime.readyAt = Date.now();
			if (active.readyTimer) clearTimeout(active.readyTimer);
			active.readyText = "";
		}
		writeJson(active.record.spec.runtimePath, runtime);
		if (becameReady) this.emit(active.record);
	}

	private async onClose(id: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		const active = this.active.get(id);
		if (!active) return;
		let quiesced = await quiesceProcessGroup(active.child.pid!, { graceful: !active.requestedStatus, graceMs: active.requestedStatus ? 0 : 250 });
		while (!quiesced) {
			active.record.runtime.status = "stopping";
			active.record.runtime.error = "Waiting for the Job process group to quiesce after SIGKILL.";
			writeJson(active.record.spec.runtimePath, active.record.runtime);
			this.emit(active.record);
			await new Promise((wait) => setTimeout(wait, 1_000));
			quiesced = await quiesceProcessGroup(active.child.pid!, { graceful: false });
		}
		if (active.killTimer) clearTimeout(active.killTimer);
		const status = active.requestedStatus ?? (code === 0 ? "completed" : "failed");
		active.record.runtime.exitCode = code;
		active.record.runtime.exitSignal = signal;
		this.finish(active.record, status, active.record.runtime.error ?? (status === "failed" ? `Job exited with code ${code ?? "?"}.` : undefined));
	}

	private finish(record: JobRecord, status: JobStatus, error?: string): JobRecord {
		if (TERMINAL.has(record.runtime.status)) return record;
		const staleTimer = this.staleTimers.get(record.spec.id);
		if (staleTimer) clearTimeout(staleTimer);
		this.staleTimers.delete(record.spec.id);
		const active = this.active.get(record.spec.id);
		if (active) {
			clearTimeout(active.timer);
			if (active.readyTimer) clearTimeout(active.readyTimer);
			if (active.heartbeatTimer) clearInterval(active.heartbeatTimer);
			if (active.killTimer) clearTimeout(active.killTimer);
			this.active.delete(record.spec.id);
		}
		record.runtime.status = status;
		record.runtime.endedAt = Date.now();
		record.runtime.error = error;
		writeJson(record.spec.runtimePath, record.runtime);
		this.emit(record);
		if (this.hidden.delete(record.spec.id)) {
			this.records.delete(record.spec.id);
			this.buffers.delete(record.spec.id);
		} else {
			this.emitTerminal(record);
			this.pruneTerminal();
		}
		return record;
	}

	private pruneTerminal(limit = 64): void {
		const terminal = this.list().filter((record) => TERMINAL.has(record.runtime.status));
		for (const record of terminal.slice(limit)) this.clearTerminal(record.spec.id);
	}

	private scheduleStaleReconciliation(record: JobRecord): void {
		if (this.staleTimers.has(record.spec.id)) return;
		const timer = setTimeout(() => {
			this.staleTimers.delete(record.spec.id);
			void (async () => {
				if (TERMINAL.has(record.runtime.status)) return;
				const quiesced = record.runtime.pid ? await stopStaleProcess(record.runtime.pid, record.runtime.processIdentity) : true;
				if (quiesced) this.finish(record, "lost", "Stale Job process group quiesced during reconciliation.");
				else this.scheduleStaleReconciliation(record);
			})();
		}, 1_000);
		timer.unref?.();
		this.staleTimers.set(record.spec.id, timer);
	}

	private emitTerminal(record: JobRecord): void {
		if (record.spec.parentSessionFile !== this.parentSessionFile) return;
		runtimeEvents.record(this.pi, { type: "activate", source: { kind: "job", id: record.spec.id }, generation: record.spec.generation });
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: `terminal:${record.spec.id}:${record.spec.generation}`,
				dedupeKey: `job:${record.spec.id}:${record.spec.generation}:terminal`,
				source: { kind: "job", id: record.spec.id, generation: record.spec.generation },
				type: "terminal",
				status: jobTerminalStatus(record.runtime.status),
				delivery: "notify",
				createdAt: record.runtime.endedAt ?? Date.now(),
				summary: record.runtime.error || `${record.spec.name} ${record.runtime.status}`,
				artifactRef: record.spec.artifactsDir,
			},
		});
		requestRuntimeDelivery();
	}

	private emit(record: JobRecord): void {
		this.events.emit("change", record);
	}

	private async waitReady(id: string, waitMs = 30_000, signal?: AbortSignal): Promise<JobRecord> {
		const record = this.get(id);
		if (record.runtime.ready || TERMINAL.has(record.runtime.status)) return record;
		return new Promise<JobRecord>((resolve, reject) => {
			const listener = (candidate: JobRecord): void => {
				if (candidate.spec.id !== id || (!candidate.runtime.ready && !TERMINAL.has(candidate.runtime.status))) return;
				cleanup(); resolve(candidate);
			};
			const abort = (): void => {
				cleanup();
				void this.stop(id, "cancelled", "Job readiness wait aborted.").then(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Job readiness wait aborted.")), reject);
			};
			const timer = setTimeout(() => { cleanup(); resolve(this.get(id)); }, waitMs);
			const cleanup = (): void => { clearTimeout(timer); this.events.off("change", listener); signal?.removeEventListener("abort", abort); };
			this.events.on("change", listener);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}

	private async waitOne(id: string, waitMs?: number, signal?: AbortSignal, includeHidden = false): Promise<JobRecord> {
		const record = includeHidden ? this.records.get(id) : this.get(id);
		if (!record) throw new Error(`Unknown job: ${id}`);
		if (TERMINAL.has(record.runtime.status) || waitMs === 0) return record;
		return new Promise<JobRecord>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const listener = (candidate: JobRecord): void => { if (candidate.spec.id === id && TERMINAL.has(candidate.runtime.status)) { cleanup(); resolve(candidate); } };
			const abort = (): void => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error("Job wait aborted.")); };
			const cleanup = (): void => { if (timer) clearTimeout(timer); this.events.off("change", listener); signal?.removeEventListener("abort", abort); };
			this.events.on("change", listener);
			signal?.addEventListener("abort", abort, { once: true });
			if (waitMs !== undefined) timer = setTimeout(() => { cleanup(); resolve(record); }, Math.max(0, waitMs));
			if (signal?.aborted) abort();
		});
	}
}

function jobTerminalStatus(status: JobStatus): "completed" | "failed" | "cancelled" | "timeout" | "lost" {
	return TERMINAL.has(status) ? status as "completed" | "failed" | "cancelled" | "timeout" | "lost" : "failed";
}

function jobsRoot(cwd: string): string {
	const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const project = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
	return path.join(base, "jobs", project);
}

function validateStart(input: JobStartInput): void {
	if (!input.name?.trim()) throw new Error("Job name is required.");
	if (!!input.command === !!input.argv?.length) throw new Error("Provide exactly one of command or argv.");
	if (input.argv && !input.argv[0]?.trim()) throw new Error("Job argv[0] is required.");
	if (input.readyPattern && Buffer.byteLength(input.readyPattern) > MAX_READY_TEXT_BYTES) throw new Error(`Job readiness pattern exceeds ${MAX_READY_TEXT_BYTES} bytes.`);
	if (input.readyMode === "regex" && input.readyPattern) new RegExp(input.readyPattern);
}

function matchesReady(spec: JobSpec, text: string): boolean {
	if (!spec.readyPattern) return true;
	return spec.readyMode === "regex" ? new RegExp(spec.readyPattern).test(text) : text.includes(spec.readyPattern);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(Math.floor(value!), max)) : fallback;
}

function writeTextAtomic(filePath: string, value: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, filePath);
}

function writeJson(filePath: string, value: unknown): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, filePath);
}

async function stopStaleProcess(pid: number, identity: string | undefined): Promise<boolean> {
	if (!await ownsProcessIdentity(pid, identity)) return true;
	return quiesceProcessGroup(pid);
}
