import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ownsProcessIdentity, quiesceProcessGroup } from "../shared/process-group.ts";
import { DEFAULT_TIMEOUT_MS } from "./config.ts";
import {
	createDelegatePaths,
	defaultDelegateRoot,
	findRunByAdmission,
	listRunIds,
	readRun,
	writePrivateText,
	writeRunRuntime,
	writeRunSpec,
} from "./artifacts.ts";
import { createBoundedByteTail } from "./protocol.ts";
import type {
	DelegateExecutorOptions,
	DelegateResumeInput,
	DelegateRun,
	DelegateRunRuntime,
	DelegateRunSpec,
	DelegateRunStatus,
	DelegateStartInput,
} from "./runtime-types.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const CHILD_SAFETY_PATH = fileURLToPath(new URL("./child-safety-runtime.ts", import.meta.url));
const TERMINAL = new Set<DelegateRunStatus>(["completed", "partial", "failed", "cancelled", "timeout", "limited", "needs_attention", "lost"]);

export class DelegateExecutor {
	private readonly runs = new Map<string, DelegateRun>();
	private readonly roots = new Map<string, string>();
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly events = new EventEmitter();
	private readonly options: DelegateExecutorOptions;

	constructor(options: DelegateExecutorOptions = {}) {
		this.options = options;
	}

	onChange(listener: (run: DelegateRun) => void): () => void {
		this.events.on("change", listener);
		return () => this.events.off("change", listener);
	}

	rootFor(cwd: string): string {
		return this.options.artifactsRoot ?? defaultDelegateRoot(cwd);
	}

	list(includeTerminal = true): DelegateRun[] {
		return [...this.runs.values()].filter((run) => includeTerminal || !TERMINAL.has(run.runtime.status)).sort((a, b) => b.runtime.startedAt - a.runtime.startedAt);
	}

	find(id: string): DelegateRun | undefined {
		return this.runs.get(id);
	}

	get(id: string): DelegateRun {
		const run = this.find(id);
		if (!run) throw new Error(`Unknown delegate run: ${id}`);
		return run;
	}

	detach(id: string): boolean {
		if (!this.runs.has(id)) return false;
		this.closeWatcher(id);
		this.runs.delete(id);
		this.roots.delete(id);
		return true;
	}

	forget(id: string): boolean {
		const run = this.runs.get(id);
		return !!run && TERMINAL.has(run.runtime.status) && this.detach(id);
	}

	allocateRunId(): string {
		return runId(this.now());
	}

	async start(input: DelegateStartInput): Promise<DelegateRun> {
		if (!input.task.trim()) throw new Error("Delegate task is empty.");
		if (input.context === "fork" && !input.forkSessionFile) throw new Error("Fork context requires forkSessionFile.");
		const now = this.now();
		const id = input.id ?? runId(now);
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || this.runs.has(id)) throw new Error(`Invalid or duplicate delegate run id: ${id}`);
		const agentId = `sa_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const root = this.options.artifactsRoot ?? defaultDelegateRoot(input.cwd);
		const paths = createDelegatePaths(root, id, agentId);
		const tools = resolveTools(input.personaTools, input.tools, input.allowWrite ?? false);
		const spec: DelegateRunSpec = {
			id,
			agentId,
			generation: randomUUID(),
			persona: input.persona,
			personaVersion: personaVersion(input.persona, input.personaBody, input.personaTools),
			task: input.task,
			cwd: input.cwd,
			tools,
			allowWrite: input.allowWrite ?? false,
			deliverTerminal: input.deliverTerminal !== false,
			model: input.model,
			context: input.context ?? "fresh",
			forkSessionFile: input.forkSessionFile,
			parentSessionFile: input.parentSessionFile,
			admissionKey: input.admissionKey,
			createdAt: now,
			limits: limitsFrom(input),
			...paths,
			execution: { command: "", args: [] },
		};
		writePrivateText(spec.systemPromptPath, buildSystemPrompt(spec, input.personaBody));
		writePrivateText(spec.taskPath, taskPrompt(input.task));
		return this.launch(root, spec, input.detach ?? true);
	}

	async resume(input: DelegateResumeInput): Promise<DelegateRun> {
		if (!input.task.trim()) throw new Error("Delegate resume task is empty.");
		const previous = this.get(input.runId);
		if (!TERMINAL.has(previous.runtime.status)) throw new Error(`Run ${input.runId} is still active.`);
		const sessionFile = previous.runtime.sessionFile;
		if (!sessionFile || !existsSync(sessionFile)) throw new Error(`Run ${input.runId} has no resumable session file.`);
		const now = this.now();
		const id = runId(now);
		const root = this.roots.get(previous.spec.id) ?? this.options.artifactsRoot ?? defaultDelegateRoot(previous.spec.cwd);
		const paths = createDelegatePaths(root, id, previous.spec.agentId);
		const spec: DelegateRunSpec = {
			...previous.spec,
			...paths,
			id,
			generation: randomUUID(),
			task: input.task,
			context: "resume",
			admissionKey: undefined,
			forkSessionFile: undefined,
			resumeSessionFile: sessionFile,
			createdAt: now,
			limits: limitsFrom(input),
			execution: { command: "", args: [] },
		};
		const previousPrompt = readFileSync(previous.spec.systemPromptPath, "utf8");
		const turnLimit = spec.limits.turns === undefined ? "unbounded" : String(spec.limits.turns);
		const systemPrompt = /^Provider-turn limit:.*$/m.test(previousPrompt)
			? previousPrompt.replace(/^Provider-turn limit:.*$/m, `Provider-turn limit: ${turnLimit}`)
			: previousPrompt.replace("\n\nRules:", `\nProvider-turn limit: ${turnLimit}\n\nRules:`);
		writePrivateText(spec.systemPromptPath, systemPrompt);
		writePrivateText(spec.taskPath, taskPrompt(input.task));
		return this.launch(root, spec, input.detach ?? true);
	}

	async wait(id: string, waitMs?: number, signal?: AbortSignal): Promise<DelegateRun> {
		const current = this.refresh(id);
		if (TERMINAL.has(current.runtime.status) || waitMs === 0) return current;
		return new Promise<DelegateRun>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const keepAlive = waitMs === undefined ? setTimeout(() => undefined, 2_147_483_647) : undefined;
			const poll = setInterval(() => {
				try { done(this.refresh(id)); } catch { /* A concurrent restore may detach the run; the timeout path returns the last known state. */ }
			}, 250);
			const done = (run: DelegateRun): void => {
				if (run.spec.id !== id || !TERMINAL.has(run.runtime.status)) return;
				cleanup();
				resolve(run);
			};
			const abort = (): void => {
				cleanup();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("Delegate wait aborted."));
			};
			const cleanup = (): void => {
				this.events.off("change", done);
				signal?.removeEventListener("abort", abort);
				if (timer) clearTimeout(timer);
				if (keepAlive) clearTimeout(keepAlive);
				clearInterval(poll);
			};
			this.events.on("change", done);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) { abort(); return; }
			const refreshed = this.refresh(id);
			if (TERMINAL.has(refreshed.runtime.status)) { done(refreshed); return; }
			// refresh(id) throws if the run was detached (e.g. a concurrent restore for another session) while this timed wait was pending; fall back to the last-known state rather than throwing uncaught inside the timer callback.
			if (waitMs !== undefined) timer = setTimeout(() => { cleanup(); try { resolve(this.refresh(id)); } catch { resolve(refreshed); } }, Math.max(0, waitMs));
		});
	}

	async cancel(id: string): Promise<DelegateRun> {
		let run = this.refresh(id);
		if (TERMINAL.has(run.runtime.status)) return run;
		if (run.runtime.workerPid && !await ownsProcessIdentity(run.runtime.workerPid, run.runtime.workerIdentity)) {
			const runtime: DelegateRunRuntime = { ...run.runtime, status: "lost", endedAt: this.now(), error: "Delegate worker identity no longer matches; no process was signalled." };
			writeRunRuntime(run.spec, runtime);
			return this.accept({ spec: run.spec, runtime });
		}
		if (run.runtime.workerPid) trySignal(run.runtime.workerPid, "SIGTERM");
		run = await this.wait(id, 3_000);
		if (TERMINAL.has(run.runtime.status)) return run;
		const childOwned = !run.runtime.childPid || !isPidAlive(run.runtime.childPid) || await ownsProcessIdentity(run.runtime.childPid, run.runtime.childIdentity);
		if (!childOwned) {
			const runtime: DelegateRunRuntime = { ...run.runtime, status: "lost", endedAt: this.now(), error: "Delegate child identity no longer matches; no process was signalled." };
			writeRunRuntime(run.spec, runtime);
			return this.accept({ spec: run.spec, runtime });
		}
		const childQuiesced = run.runtime.childPid ? await quiesceProcessGroup(run.runtime.childPid, { graceful: false }) : true;
		if (!childQuiesced) {
			const runtime: DelegateRunRuntime = { ...run.runtime, status: "stopping", error: "Child SIGKILL was sent, but its process group has not quiesced; the worker remains the active reconciler." };
			writeRunRuntime(run.spec, runtime);
			this.watchRun({ spec: run.spec, runtime });
			return this.accept({ spec: run.spec, runtime });
		}
		const workerOwned = !run.runtime.workerPid || !isPidAlive(run.runtime.workerPid) || await ownsProcessIdentity(run.runtime.workerPid, run.runtime.workerIdentity);
		if (!workerOwned) {
			const runtime: DelegateRunRuntime = { ...run.runtime, status: "lost", endedAt: this.now(), error: "Delegate worker identity changed during cancellation; no replacement process was signalled." };
			writeRunRuntime(run.spec, runtime);
			return this.accept({ spec: run.spec, runtime });
		}
		const workerQuiesced = run.runtime.workerPid ? await quiesceProcessGroup(run.runtime.workerPid, { graceful: false }) : true;
		const runtime: DelegateRunRuntime = workerQuiesced ? {
			...run.runtime,
			status: "cancelled",
			endedAt: this.now(),
			error: "Delegate force-cancelled after both process groups quiesced.",
		} : {
			...run.runtime,
			status: "stopping",
			error: "Worker SIGKILL was sent, but its process group has not quiesced; terminal settlement is withheld.",
		};
		writeRunRuntime(run.spec, runtime);
		if (!workerQuiesced) this.watchRun({ spec: run.spec, runtime });
		return this.accept({ spec: run.spec, runtime });
	}

	adopt(id: string, parentSessionFile: string): DelegateRun | undefined {
		const run = this.runs.get(id);
		if (!run) return undefined;
		const adopted = { spec: { ...run.spec, parentSessionFile }, runtime: run.runtime };
		writeRunSpec(adopted.spec);
		return this.accept(adopted);
	}

	async restoreAdmission(cwd: string, admissionKey: string): Promise<DelegateRun | undefined> {
		const root = this.options.artifactsRoot ?? defaultDelegateRoot(cwd);
		const run = findRunByAdmission(root, cwd, admissionKey);
		return run ? this.restoreRun(root, run) : undefined;
	}

	async restore(cwd: string, parentSessionFile?: string): Promise<DelegateRun[]> {
		const root = this.options.artifactsRoot ?? defaultDelegateRoot(cwd);
		return this.restoreRoot(root, parentSessionFile);
	}

	async restoreRoot(root: string, parentSessionFile?: string): Promise<DelegateRun[]> {
		for (const id of listRunIds(root)) {
			const run = readRun(root, id);
			if (!run || (parentSessionFile !== undefined && run.spec.parentSessionFile !== parentSessionFile)) continue;
			await this.restoreRun(root, run);
		}
		return this.list();
	}

	private async restoreRun(root: string, run: DelegateRun): Promise<DelegateRun> {
		this.roots.set(run.spec.id, root);
		if (!TERMINAL.has(run.runtime.status)) {
			const workerOwned = run.runtime.workerPid !== undefined && await ownsProcessIdentity(run.runtime.workerPid, run.runtime.workerIdentity);
			if (!workerOwned) {
				const childOwned = run.runtime.childPid !== undefined && await ownsProcessIdentity(run.runtime.childPid, run.runtime.childIdentity);
				const quiesced = childOwned ? await quiesceProcessGroup(run.runtime.childPid!, { graceful: false }) : true;
				run.runtime = quiesced
					? { ...run.runtime, status: "lost", endedAt: this.now(), error: "Delegate ownership could not be proven during restoration; unrelated processes were not signalled." }
					: { ...run.runtime, status: "stopping", error: "Owned stale delegate process group has not quiesced; terminal settlement is withheld." };
				writeRunRuntime(run.spec, run.runtime);
			}
		}
		const restored = this.accept(run);
		if (!TERMINAL.has(restored.runtime.status)) this.watchRun(restored);
		return restored;
	}

	dispose(): void {
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		this.events.removeAllListeners();
	}

	private async launch(root: string, spec: DelegateRunSpec, detach: boolean): Promise<DelegateRun> {
		spec.execution = this.options.command?.(spec) ?? buildPiCommand(spec);
		const runtime: DelegateRunRuntime = {
			version: 1,
			id: spec.id,
			status: "starting",
			startedAt: this.now(),
			settled: false,
			turns: 0,
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
			lastActivityAt: this.now(),
		};
		writeRunSpec(spec);
		writeRunRuntime(spec, runtime);
		let worker: ChildProcess;
		try {
			worker = await startDelegateWorker(spec);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeRunRuntime(spec, { ...runtime, status: "failed", endedAt: this.now(), error: message });
			throw error;
		}
		worker.unref();
		this.roots.set(spec.id, root);
		const run = readRun(root, spec.id) ?? { spec, runtime };
		this.accept(run);
		if (!TERMINAL.has(run.runtime.status)) this.watchRun(run);
		return detach ? run : this.wait(spec.id);
	}

	private watchRun(run: DelegateRun): void {
		if (this.watchers.has(run.spec.id)) return;
		const watcher = watch(run.spec.artifactsDir, (_event, filename) => {
			const runtimeName = path.basename(run.spec.runtimePath);
			if (filename && filename !== runtimeName && !filename.startsWith(`${runtimeName}.`)) return;
			try {
				const refreshed = this.refresh(run.spec.id);
				if (TERMINAL.has(refreshed.runtime.status)) this.closeWatcher(run.spec.id);
			} catch {
				// Atomic rename can briefly coalesce filesystem notifications; the next event or wait refresh repairs it.
			}
		});
		watcher.unref?.();
		this.watchers.set(run.spec.id, watcher);
	}

	private refresh(id: string): DelegateRun {
		const existing = this.get(id);
		const root = this.roots.get(id);
		if (!root) return existing;
		const run = readRun(root, id);
		return run ? this.accept(run) : existing;
	}

	private accept(run: DelegateRun): DelegateRun {
		const previous = this.runs.get(run.spec.id);
		this.runs.set(run.spec.id, run);
		if (!previous || JSON.stringify(previous.runtime) !== JSON.stringify(run.runtime)) this.events.emit("change", run);
		return run;
	}

	private closeWatcher(id: string): void {
		this.watchers.get(id)?.close();
		this.watchers.delete(id);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

export function buildPiCommand(spec: DelegateRunSpec): { command: string; args: string[] } {
	const args = ["--mode", "json", "--print", "--session-dir", spec.sessionDir, "--name", `${spec.persona}:${spec.agentId}`];
	if (spec.context === "fork") args.push("--fork", spec.forkSessionFile!);
	if (spec.context === "resume") args.push("--session", spec.resumeSessionFile!);
	if (spec.model) args.push("--model", spec.model);
	args.push("--no-extensions", "--extension", CHILD_SAFETY_PATH, "--no-skills", "--append-system-prompt", spec.systemPromptPath);
	if (spec.tools.length) args.push("--tools", spec.tools.join(","));
	args.push(`@${spec.taskPath}`);
	return resolvePiInvocation(args);
}

export function resolvePiInvocation(args: string[], currentScript = process.argv[1], execPath = process.execPath): { command: string; args: string[] } {
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) return { command: execPath, args: [currentScript, ...args] };
	if (!/^(node|bun)(\.exe)?$/i.test(path.basename(execPath))) return { command: execPath, args };
	return { command: "pi", args };
}

export function scriptRuntimeCandidates(execPath = process.execPath, env = process.env): string[] {
	if (/^(node|bun)(\.exe)?$/i.test(path.basename(execPath))) return [execPath];
	return [...new Set([env.NODE, env.npm_node_execpath, "node", "bun"].filter((value): value is string => !!value))];
}

async function startDelegateWorker(spec: DelegateRunSpec): Promise<ChildProcess> {
	const failures: string[] = [];
	for (const runtime of scriptRuntimeCandidates()) {
		try {
			return await startDelegateWorkerWith(runtime, spec);
		} catch (error) {
			failures.push(`${runtime}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Unable to start the Subagent worker with Node or Bun. ${failures.join("; ")}`);
}

function startDelegateWorkerWith(runtime: string, spec: DelegateRunSpec): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const stderr = createBoundedByteTail(spec.limits.maxStderrBytes);
		const worker = spawn(runtime, [WORKER_PATH, path.join(spec.artifactsDir, "spec.json")], {
			cwd: spec.cwd,
			detached: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let finished = false;
		worker.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		const cleanup = (): void => {
			worker.off("error", onError);
			worker.off("exit", onExit);
			worker.off("message", onMessage);
		};
		const fail = (error: Error): void => {
			if (finished) return;
			finished = true;
			cleanup();
			worker.stderr?.destroy();
			reject(error);
		};
		const onError = (error: Error): void => fail(error);
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			const output = stderr.text().trim();
			fail(new Error(`Worker exited before readiness (${signal ?? code ?? "unknown"})${output ? `: ${output}` : "."}`));
		};
		const onMessage = (message: unknown): void => {
			if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "delegate_worker_ready" || finished) return;
			finished = true;
			cleanup();
			worker.stderr?.destroy();
			resolve(worker);
		};
		worker.once("error", onError);
		worker.once("exit", onExit);
		worker.on("message", onMessage);
	});
}

function taskPrompt(task: string): string {
	return `Task:\n${task.trim()}\n\nReturn concise structured output with concrete evidence, file paths, and uncertainty notes.\n`;
}

function buildSystemPrompt(spec: DelegateRunSpec, personaBody: string): string {
	const turnLimit = spec.limits.turns === undefined ? "unbounded" : String(spec.limits.turns);
	return `You are a delegated Deevs staff subagent.\n\nAgent: ${spec.persona}\nWorking directory: ${spec.cwd}\nContext mode: ${spec.context}\nWrite access: ${spec.allowWrite ? "on" : "off"}\nEnabled tools: ${spec.tools.join(", ") || "none"}\nProvider-turn limit: ${turnLimit}\n\nRules:\n- Stay within the assigned persona and task.\n- Be concrete and evidence-based.\n- Do not spawn other subagents.\n- Do not edit unless write access is on.\n- Do not run destructive or persistent background commands.\n- If provider turns are bounded, return a usable conclusion before the final allowed turn.\n- Return uncertainty explicitly.\n\nPersona:\n${personaBody.trim()}\n`;
}

function resolveTools(personaTools: string[], requested: string[] | undefined, allowWrite: boolean): string[] {
	const allowed = new Set(personaTools.map((tool) => tool.trim()).filter(Boolean));
	if (allowWrite) {
		allowed.add("bash");
		allowed.add("edit");
		allowed.add("write");
	} else {
		allowed.delete("bash");
	}
	if (requested && !requested.some((tool) => tool.trim())) throw new Error("tools must not be empty; omit it to use the persona's read-only tools.");
	const selected = requested ? requested.map((tool) => tool.trim()).filter(Boolean) : [...allowed];
	for (const tool of selected) if (!allowed.has(tool)) throw new Error(`Tool ${tool} is not allowed by the ${allowWrite ? "write-enabled" : "read-only"} persona policy. Allowed tools: ${[...allowed].sort().join(", ") || "none"}.`);
	if (!allowWrite && (selected.includes("edit") || selected.includes("write"))) throw new Error("Write tools require allowWrite=true.");
	return [...new Set(selected)].sort();
}

function limitsFrom(input: Pick<DelegateStartInput, "wallMs" | "turns" | "tokens" | "costUsd">): DelegateRunSpec["limits"] {
	return {
		wallMs: positive(input.wallMs, "wallMs") ?? DEFAULT_TIMEOUT_MS,
		turns: positive(input.turns, "turns"),
		tokens: positive(input.tokens, "tokens"),
		costUsd: positive(input.costUsd, "costUsd"),
		maxProtocolLineBytes: 16 * 1024 * 1024,
		maxStderrBytes: 128 * 1024,
	};
}

function positive(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
	return value;
}

function personaVersion(name: string, body: string, tools: string[]): string {
	return createHash("sha256").update(JSON.stringify({ name, body, tools: [...tools].sort() })).digest("hex").slice(0, 16);
}

function runId(now: number): string {
	return `a_${now.toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process already exited.
	}
}
