import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampConcurrency, clampTimeoutMs, loadAgentsSettings } from "./config.ts";
import { findAgent, loadBuiltinAgents } from "./agents.ts";
import { defaultDelegateRoot } from "./artifacts.ts";
import { DelegateExecutor } from "./executor.ts";
import type { DelegateRun, DelegateRunStatus } from "./runtime-types.ts";
import { requestRuntimeDelivery } from "../shared/runtime-delivery.ts";
import { consumeRuntimeEvent, runtimeEvents, type RuntimeTerminalStatus } from "../shared/runtime-events.ts";
import { chainCheckpoints } from "../chains/checkpoint.ts";

class ConcurrencyLimitError extends Error {}

export interface SubagentTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	tools?: string[];
	allowWrite?: boolean;
	deliverTerminal?: boolean;
	wallMs?: number;
	turns?: number;
	tokens?: number;
	costUsd?: number;
}

export interface SubagentStartRequest {
	agent?: string;
	task?: string;
	cwd?: string;
	context?: "fresh" | "fork";
	model?: string;
	tools?: string[];
	allowWrite?: boolean;
	wallMs?: number;
	turns?: number;
	tokens?: number;
	costUsd?: number;
	resume?: string;
	background?: boolean;
	tasks?: SubagentTaskInput[];
	concurrency?: number;
	failFast?: boolean;
	/** Internal: record terminal evidence but suppress the separate parent wake. */
	deliverTerminal?: boolean;
	/** Internal: return the existing durable run when an ambiguous launch is retried. */
	admissionKey?: string;
}

export interface SubagentWaitRequest {
	ids: string[];
	waitMs?: number;
	cancel?: boolean;
}

export interface SubagentGroup {
	version: 1;
	id: string;
	generation: string;
	status: "running" | "completed" | "partial" | "failed" | "cancelled";
	cwd: string;
	createdAt: number;
	endedAt?: number;
	cancelRequestedAt?: number;
	concurrency: number;
	failFast: boolean;
	pending: SubagentTaskInput[];
	children: string[];
	active: string[];
	launchFailures: string[];
	/** Exact parent Pi session that owns this group. Legacy records may omit it. */
	parentSessionFile?: string;
	/** Artifact root for each child, needed when group tasks use different cwd values. */
	childRoots?: Record<string, string>;
}

export class SubagentService {
	readonly executor: DelegateExecutor;
	private readonly pi: ExtensionAPI;
	private readonly groups = new Map<string, SubagentGroup>();
	private readonly roots = new Map<string, string>();
	private readonly terminalSeen = new Set<string>();
	private readonly groupFills = new Map<string, Promise<void>>();
	private startingRuns = 0;
	private restoredParentSessionFile?: string;
	private capacityVersion = 0;
	private readonly capacityWaiters = new Set<() => void>();
	private ctx?: ExtensionContext;
	private unsubscribe: () => void;
	private readonly artifactsRoot?: string;

	constructor(pi: ExtensionAPI, executor = new DelegateExecutor(), artifactsRoot?: string) {
		this.pi = pi;
		this.executor = executor;
		this.artifactsRoot = artifactsRoot;
		this.unsubscribe = executor.onChange((run) => {
			this.signalCapacityChange();
			void this.onRunChange(run);
		});
	}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	async start(request: SubagentStartRequest, ctx: ExtensionContext): Promise<DelegateRun | SubagentGroup> {
		this.ctx = ctx;
		const previous = request.resume ? this.executor.get(request.resume) : undefined;
		const writeRequested = request.allowWrite === true || request.tasks?.some((task) => task.allowWrite) === true || previous?.spec.allowWrite === true;
		if (writeRequested && !await authorizeDelegatedWrite(ctx, request)) throw new Error("Delegated writes were not authorized by the user.");
		if (request.tasks?.length) return this.startGroup(request.tasks, request, ctx);
		if (request.resume) {
			if (!request.task?.trim()) throw new Error("A resume task is required.");
			const settings = await loadAgentsSettings(previous!.spec.cwd);
			this.reserveCapacity(settings.parallelMaxConcurrency);
			try {
				const run = await this.executor.resume({
					runId: request.resume,
					task: request.task,
					detach: request.background !== false,
					wallMs: clampTimeoutMs(request.wallMs, settings),
					turns: request.turns,
					tokens: request.tokens,
					costUsd: request.costUsd,
				});
				try {
					this.recordRunRoot(run, ctx);
				} catch (error) {
					await this.executor.cancel(run.spec.id).catch(() => undefined);
					throw error;
				}
				this.activate(run);
				return run;
			} finally {
				this.startingRuns--;
				this.signalCapacityChange();
			}
		}
		if (!request.agent || !request.task) throw new Error("A persona and task are required for a fresh subagent run.");
		return this.startTask({
			agent: request.agent,
			task: request.task,
			cwd: request.cwd,
			context: request.context,
			model: request.model,
			tools: request.tools,
			allowWrite: request.allowWrite,
			deliverTerminal: request.deliverTerminal,
			wallMs: request.wallMs,
			turns: request.turns,
			tokens: request.tokens,
			costUsd: request.costUsd,
		}, ctx, request.background !== false, request.admissionKey);
	}

	async wait(request: SubagentWaitRequest, signal?: AbortSignal): Promise<Array<DelegateRun | SubagentGroup>> {
		if (!request.ids.length) throw new Error("subagent_wait requires at least one id.");
		if (request.cancel) {
			for (const id of request.ids) await this.cancel(id);
		}
		return Promise.all(request.ids.map(async (id) => {
			const group = this.groups.get(id);
			if (group) return this.waitGroup(group, request.waitMs, signal);
			return this.executor.wait(id, request.waitMs, signal);
		}));
	}

	consumeTerminal(results: Array<DelegateRun | SubagentGroup>, claimant: string): void {
		for (const result of results) {
			if ("spec" in result) {
				if (isTerminal(result.runtime.status)) consumeRuntimeEvent(this.pi, `terminal:${result.spec.id}:${result.spec.generation}`, claimant);
				continue;
			}
			if (result.status === "running") continue;
			consumeRuntimeEvent(this.pi, `terminal:${result.id}:${result.generation}`, claimant);
			for (const id of result.children) {
				const run = this.executor.find(id);
				if (run && isTerminal(run.runtime.status)) consumeRuntimeEvent(this.pi, `terminal:${run.spec.id}:${run.spec.generation}`, claimant);
			}
		}
	}

	list(): { runs: DelegateRun[]; groups: SubagentGroup[] } {
		return { runs: this.executor.list(), groups: [...this.groups.values()].sort((a, b) => b.createdAt - a.createdAt) };
	}

	activeLaunchReservations(): number {
		return this.startingRuns;
	}

	restorationComplete(): boolean {
		return this.restoredParentSessionFile !== undefined;
	}

	clearTerminal(id?: string): number {
		let cleared = 0;
		const claimant = this.ctx?.sessionManager.getSessionFile() ?? "subagent-service";
		for (const group of [...this.groups.values()]) {
			if ((id && group.id !== id) || group.status === "running") continue;
			consumeRuntimeEvent(this.pi, `terminal:${group.id}:${group.generation}`, claimant);
			const root = this.roots.get(group.id) ?? this.root(group.cwd);
			rmSync(path.join(root, "groups", `${group.id}.json`), { force: true });
			this.groups.delete(group.id);
			this.roots.delete(group.id);
			this.terminalSeen.delete(group.id);
			cleared++;
		}
		const referenced = new Set([...this.groups.values()].flatMap((group) => group.children));
		for (const run of this.executor.list()) {
			if ((id && run.spec.id !== id) || !isTerminal(run.runtime.status) || referenced.has(run.spec.id)) continue;
			consumeRuntimeEvent(this.pi, `terminal:${run.spec.id}:${run.spec.generation}`, claimant);
			rmSync(run.spec.artifactsDir, { recursive: true, force: true });
			this.executor.forget(run.spec.id);
			this.terminalSeen.delete(runTerminalKey(run));
			cleared++;
		}
		return cleared;
	}

	async restore(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		this.restoredParentSessionFile = undefined;
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		for (const run of this.executor.list()) if (!parentSessionFile || run.spec.parentSessionFile !== parentSessionFile) {
			this.executor.detach(run.spec.id);
			this.terminalSeen.delete(runTerminalKey(run));
		}
		for (const group of [...this.groups.values()]) if (!parentSessionFile || group.parentSessionFile !== parentSessionFile) {
			this.groups.delete(group.id);
			this.roots.delete(group.id);
			this.terminalSeen.delete(group.id);
		}
		if (!parentSessionFile) return;
		const root = this.root(ctx.cwd);
		await this.executor.restore(ctx.cwd, parentSessionFile);
		for (const indexedRoot of this.readRunRoots(root, parentSessionFile)) if (indexedRoot !== root) await this.executor.restoreRoot(indexedRoot, parentSessionFile);
		this.restoreGroups(root, parentSessionFile);
		const childRoots = new Set([...this.groups.values()].flatMap((group) => Object.values(group.childRoots ?? {})));
		for (const childRoot of childRoots) if (childRoot !== root) await this.executor.restoreRoot(childRoot, parentSessionFile);
		for (const run of this.executor.list()) {
			this.activate(run);
			if (isTerminal(run.runtime.status)) this.emitTerminal(run);
		}
		for (const group of this.groups.values()) {
			this.reconcileGroup(group);
			this.writeGroup(group);
			if (group.status === "running") void this.fillGroup(group, ctx);
			else this.emitGroupTerminal(group);
		}
		this.pruneTerminal();
		this.restoredParentSessionFile = parentSessionFile;
	}

	dispose(): void {
		this.unsubscribe();
		this.executor.dispose();
	}

	private async startTask(task: SubagentTaskInput, ctx: ExtensionContext, background: boolean, admissionKey?: string): Promise<DelegateRun> {
		const agents = loadBuiltinAgents();
		const persona = findAgent(agents, task.agent);
		if (!persona || persona.disabled) throw new Error(`Unknown or disabled persona: ${task.agent}`);
		const cwd = path.resolve(task.cwd ?? ctx.cwd);
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		if (admissionKey) {
			if (!/^[A-Za-z0-9_-]{1,200}$/.test(admissionKey)) throw new Error("Invalid internal Subagent admission key.");
			await this.executor.restore(cwd, parentSessionFile);
			const existing = this.executor.list().find((run) => run.spec.admissionKey === admissionKey && run.spec.cwd === cwd && run.spec.parentSessionFile === parentSessionFile);
			if (existing) {
				this.recordRunRoot(existing, ctx);
				return existing;
			}
		}
		this.recordRunRootPath(this.executor.rootFor(cwd), ctx);
		const settings = await loadAgentsSettings(cwd);
		const model = task.model ?? settings.modelsByAgent[persona.name] ?? persona.model ?? settings.defaultModel;
		if (model && settings.allowedModels.length && !settings.allowedModels.includes(model)) throw new Error(`Model override not allowed: ${model}`);
		this.reserveCapacity(settings.parallelMaxConcurrency);
		try {
			const run = await this.executor.start({
				persona: persona.name,
				personaBody: persona.body,
				personaTools: persona.tools,
				task: task.task,
				cwd,
				context: task.context ?? "fresh",
				forkSessionFile: task.context === "fork" ? ctx.sessionManager.getSessionFile() : undefined,
				parentSessionFile,
				admissionKey,
				model,
				tools: task.tools,
				allowWrite: task.allowWrite === true,
				deliverTerminal: task.deliverTerminal,
				detach: background,
				wallMs: clampTimeoutMs(task.wallMs, settings),
				turns: task.turns,
				tokens: task.tokens,
				costUsd: task.costUsd,
			});
			try {
				this.recordRunRoot(run, ctx);
			} catch (error) {
				await this.executor.cancel(run.spec.id).catch(() => undefined);
				throw error;
			}
			this.activate(run);
			return run;
		} finally {
			this.startingRuns--;
			this.signalCapacityChange();
		}
	}

	private reserveCapacity(limit: number): void {
		const active = this.executor.list(false).length + this.startingRuns;
		if (active >= limit) throw new ConcurrencyLimitError(`Subagent concurrency limit reached (${limit}). Wait for a run to settle.`);
		this.startingRuns++;
	}

	private async startGroup(tasks: SubagentTaskInput[], request: SubagentStartRequest, ctx: ExtensionContext): Promise<SubagentGroup> {
		if (tasks.length > 16) throw new Error("A subagent group is limited to 16 tasks.");
		const settings = await loadAgentsSettings(ctx.cwd);
		for (const task of tasks) {
			if (!task.task?.trim()) throw new Error(`Task for ${task.agent || "persona"} is empty.`);
			if (!findAgent(loadBuiltinAgents(), task.agent)) throw new Error(`Unknown persona: ${task.agent}`);
		}
		const group: SubagentGroup = {
			version: 1,
			id: `g_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
			generation: randomUUID(),
			status: "running",
			cwd: ctx.cwd,
			createdAt: Date.now(),
			concurrency: clampConcurrency(request.concurrency, settings),
			failFast: request.failFast === true,
			pending: tasks.map((task) => ({ ...task })),
			children: [],
			active: [],
			launchFailures: [],
			parentSessionFile: ctx.sessionManager.getSessionFile(),
			childRoots: {},
		};
		this.groups.set(group.id, group);
		this.roots.set(group.id, this.root(ctx.cwd));
		runtimeEvents.record(this.pi, { type: "activate", source: { kind: "subagent-group", id: group.id }, generation: group.generation });
		this.writeGroup(group);
		await this.fillGroup(group, ctx);
		if (request.background === false) await this.waitGroup(group, undefined);
		return group;
	}

	private async fillGroup(group: SubagentGroup, ctx: ExtensionContext): Promise<void> {
		const existing = this.groupFills.get(group.id);
		if (existing) return existing;
		const fill = this.fillGroupNow(group, ctx);
		this.groupFills.set(group.id, fill);
		try {
			await fill;
		} finally {
			if (this.groupFills.get(group.id) === fill) this.groupFills.delete(group.id);
			this.reconcileGroup(group);
			this.writeGroup(group);
			if (group.status !== "running") this.emitGroupTerminal(group);
		}
	}

	private async fillGroupNow(group: SubagentGroup, ctx: ExtensionContext): Promise<void> {
		while (group.status === "running" && !group.cancelRequestedAt && group.active.length < group.concurrency && group.pending.length) {
			const task = group.pending.shift()!;
			try {
				const run = await this.startTask({ ...task, deliverTerminal: false }, ctx, true);
				group.children.push(run.spec.id);
				if (!isTerminal(run.runtime.status)) group.active.push(run.spec.id);
				(group.childRoots ??= {})[run.spec.id] = path.dirname(path.dirname(run.spec.artifactsDir));
				if (group.cancelRequestedAt) await this.executor.cancel(run.spec.id);
			} catch (error) {
				if (error instanceof ConcurrencyLimitError) {
					group.pending.unshift(task);
					break;
				}
				group.launchFailures.push(error instanceof Error ? error.message : String(error));
				if (group.failFast) {
					group.pending = [];
					for (const id of group.active) await this.executor.cancel(id);
					break;
				}
			}
			this.writeGroup(group);
		}
	}

	private async onRunChange(run: DelegateRun): Promise<void> {
		if (!isTerminal(run.runtime.status)) return;
		this.emitTerminal(run);
		for (const group of [...this.groups.values()]) {
			const owned = group.active.includes(run.spec.id);
			if (owned) {
				group.active = group.active.filter((id) => id !== run.spec.id);
				if (group.failFast && run.runtime.status !== "completed") {
					group.pending = [];
					for (const id of group.active) await this.executor.cancel(id);
				}
			}
			if (!owned && !group.pending.length) continue;
			this.reconcileGroup(group);
			this.writeGroup(group);
			if (group.status === "running" && this.ctx) await this.fillGroup(group, this.ctx);
			if (group.status !== "running") this.emitGroupTerminal(group);
		}
	}

	private activate(run: DelegateRun): void {
		runtimeEvents.record(this.pi, {
			type: "activate",
			source: { kind: "subagent", id: run.spec.id },
			generation: run.spec.generation,
		});
	}

	private emitTerminal(run: DelegateRun): void {
		const terminalKey = runTerminalKey(run);
		if (this.terminalSeen.has(terminalKey)) return;
		this.terminalSeen.add(terminalKey);
		this.activate(run);
		const terminalDedupeKey = `subagent:${run.spec.id}:${run.spec.generation}:terminal`;
		if (run.spec.allowWrite && !run.runtime.chainCheckpointRecordedAt) {
			if (!runtimeEvents.read().dedupe[terminalDedupeKey]) chainCheckpoints.current?.due(`write-enabled subagent ${run.spec.id} settled`, "material_change");
			run.runtime.chainCheckpointRecordedAt = Date.now();
			writeFileSync(run.spec.runtimePath, JSON.stringify(run.runtime));
		}
		const attention = run.runtime.status === "needs_attention";
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: `terminal:${run.spec.id}:${run.spec.generation}`,
				dedupeKey: terminalDedupeKey,
				source: { kind: "subagent", id: run.spec.id, generation: run.spec.generation },
				type: attention ? "attention" : "terminal",
				status: terminalStatus(run.runtime.status),
				delivery: attention || run.spec.deliverTerminal !== false ? "notify" : "record_only",
				createdAt: run.runtime.endedAt ?? Date.now(),
				summary: run.runtime.output?.split(/\r?\n/, 1)[0]?.slice(0, 240) || run.runtime.error || run.runtime.status,
				artifactRef: run.spec.artifactsDir,
				usage: run.runtime.usage,
			},
		});
		requestRuntimeDelivery();
		this.pruneTerminal();
	}

	private async cancel(id: string): Promise<void> {
		const group = this.groups.get(id);
		if (!group) {
			await this.executor.cancel(id);
			return;
		}
		group.pending = [];
		group.cancelRequestedAt = Date.now();
		this.writeGroup(group);
		const filling = this.groupFills.get(group.id);
		if (filling) await filling;
		for (const child of group.active) await this.executor.cancel(child);
		this.reconcileGroup(group);
		this.writeGroup(group);
		if (group.status !== "running") this.emitGroupTerminal(group);
	}

	private async waitGroup(group: SubagentGroup, waitMs?: number, signal?: AbortSignal): Promise<SubagentGroup> {
		if (group.status !== "running" || waitMs === 0) return group;
		const started = Date.now();
		while (group.status === "running") {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Subagent group wait aborted.");
			const remaining = waitMs === undefined ? undefined : Math.max(0, waitMs - (Date.now() - started));
			if (remaining === 0) break;
			const active = group.active[0];
			if (!active) {
				const inFlightFill = this.groupFills.get(group.id);
				if (inFlightFill) { await inFlightFill; continue; }
				if (group.pending.length && this.ctx) {
					const observedCapacity = this.capacityVersion;
					await this.fillGroup(group, this.ctx);
					if (!group.active.length && group.pending.length) await this.waitForCapacityChange(observedCapacity, remaining, signal);
					continue;
				}
				break;
			}
			await this.executor.wait(active, remaining, signal);
			const filling = this.groupFills.get(group.id);
			if (filling) await filling;
			this.reconcileGroup(group);
		}
		return group;
	}

	private signalCapacityChange(): void {
		this.capacityVersion++;
		for (const waiter of [...this.capacityWaiters]) waiter();
	}

	private waitForCapacityChange(observedVersion: number, waitMs?: number, signal?: AbortSignal): Promise<void> {
		if (this.capacityVersion !== observedVersion) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: unknown) => {
				this.capacityWaiters.delete(onCapacity);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onCapacity = () => finish();
			const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Subagent group wait aborted."));
			this.capacityWaiters.add(onCapacity);
			if (this.capacityVersion !== observedVersion) return finish();
			if (waitMs !== undefined) {
				timer = setTimeout(() => finish(), waitMs);
				timer.unref?.();
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private reconcileGroup(group: SubagentGroup): void {
		if (this.groupFills.has(group.id)) {
			group.status = "running";
			return;
		}
		const runs = group.children.flatMap((id) => {
			const run = this.executor.find(id);
			if (run) return [run];
			const failure = `Missing child run record: ${id}`;
			if (!group.launchFailures.includes(failure)) group.launchFailures.push(failure);
			return [];
		});
		group.active = runs.filter((run) => !isTerminal(run.runtime.status)).map((run) => run.spec.id);
		if (group.pending.length || group.active.length) {
			group.status = "running";
			return;
		}
		const statuses = runs.map((run) => run.runtime.status);
		group.status = !group.launchFailures.length && statuses.length > 0 && statuses.every((status) => status === "completed") ? "completed"
			: !group.launchFailures.length && statuses.length > 0 && statuses.every((status) => status === "cancelled") ? "cancelled"
			: statuses.some((status) => status === "completed") ? "partial"
			: "failed";
		group.endedAt ??= Date.now();
	}

	private recordRunRoot(run: DelegateRun, ctx: ExtensionContext): void {
		this.recordRunRootPath(path.dirname(path.dirname(run.spec.artifactsDir)), ctx);
	}

	private recordRunRootPath(runRoot: string, ctx: ExtensionContext): void {
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Subagent runs require a durable parent session file.");
		const parentRoot = this.root(ctx.cwd);
		if (runRoot === parentRoot) return;
		const target = this.runRootsPath(parentRoot, parentSessionFile);
		const roots = new Set(this.readRunRoots(parentRoot, parentSessionFile));
		roots.add(runRoot);
		mkdirSync(path.dirname(target), { recursive: true });
		const temp = `${target}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ version: 1, parentSessionFile, roots: [...roots].sort() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temp, target);
	}

	private readRunRoots(parentRoot: string, parentSessionFile: string): string[] {
		// A corrupt index degrades to empty rather than throwing: throwing here would abort restore (fail-open, hiding active alt-root runs) and permanently block every future alt-cwd launch (fail-closed). recordRunRoot rewrites a fresh index on the next launch. The atomic temp+rename write makes real corruption practically unreachable.
		const target = this.runRootsPath(parentRoot, parentSessionFile);
		if (!existsSync(target)) return [];
		try {
			const value = JSON.parse(readFileSync(target, "utf8")) as { version?: unknown; parentSessionFile?: unknown; roots?: unknown };
			if (value.version !== 1 || value.parentSessionFile !== parentSessionFile || !Array.isArray(value.roots)) return [];
			return value.roots.filter((root): root is string => typeof root === "string" && path.isAbsolute(root));
		} catch {
			return [];
		}
	}

	private runRootsPath(parentRoot: string, parentSessionFile: string): string {
		const key = createHash("sha256").update(parentSessionFile).digest("hex").slice(0, 24);
		return path.join(parentRoot, "roots", `${key}.json`);
	}

	private restoreGroups(root: string, parentSessionFile: string): void {
		const dir = path.join(root, "groups");
		if (!existsSync(dir)) return;
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
			try {
				const group = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as SubagentGroup;
				if (group.version !== 1 || !group.id || group.parentSessionFile !== parentSessionFile) continue;
				group.launchFailures ??= [];
				group.childRoots ??= {};
				this.groups.set(group.id, group);
				this.roots.set(group.id, root);
			} catch {
				// Ignore a corrupted group record; individual run artifacts remain inspectable.
			}
		}
	}

	private writeGroup(group: SubagentGroup): void {
		const root = this.roots.get(group.id) ?? this.root(group.cwd);
		const dir = path.join(root, "groups");
		mkdirSync(dir, { recursive: true });
		const target = path.join(dir, `${group.id}.json`);
		const temp = `${target}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(group, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temp, target);
	}

	private emitGroupTerminal(group: SubagentGroup): void {
		if (this.terminalSeen.has(group.id) || group.status === "running") return;
		this.terminalSeen.add(group.id);
		const runs = group.children.flatMap((id) => {
			const run = this.executor.find(id);
			return run ? [run] : [];
		});
		const missing = group.children.length - runs.length;
		const usage = runs.reduce((total, run) => ({
			inputTokens: total.inputTokens + run.runtime.usage.inputTokens,
			outputTokens: total.outputTokens + run.runtime.usage.outputTokens,
			cacheReadTokens: total.cacheReadTokens + run.runtime.usage.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + run.runtime.usage.cacheWriteTokens,
			costUsd: total.costUsd + run.runtime.usage.costUsd,
		}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
		runtimeEvents.record(this.pi, { type: "activate", source: { kind: "subagent-group", id: group.id }, generation: group.generation });
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: `terminal:${group.id}:${group.generation}`,
				dedupeKey: `subagent-group:${group.id}:${group.generation}:terminal`,
				source: { kind: "subagent-group", id: group.id, generation: group.generation },
				type: "terminal",
				status: group.status,
				delivery: "notify",
				createdAt: group.endedAt ?? Date.now(),
				summary: missing ? `${runs.length}/${group.children.length} child run record(s) settled · ${missing} missing` : `${runs.length} child run(s) settled`,
				artifactRef: path.join(this.roots.get(group.id) ?? this.root(group.cwd), "groups", `${group.id}.json`),
				usage,
			},
		});
		requestRuntimeDelivery();
		this.pruneTerminal();
	}

	private pruneTerminal(runLimit = 64, groupLimit = 32): void {
		const terminalGroups = [...this.groups.values()].filter((group) => group.status !== "running").sort((a, b) => b.createdAt - a.createdAt);
		for (const group of terminalGroups.slice(groupLimit)) this.clearTerminal(group.id);
		const referenced = new Set([...this.groups.values()].flatMap((group) => group.children));
		const terminalRuns = this.executor.list().filter((run) => isTerminal(run.runtime.status) && !referenced.has(run.spec.id));
		for (const run of terminalRuns.slice(runLimit)) this.clearTerminal(run.spec.id);
	}

	private root(cwd: string): string {
		return this.artifactsRoot ?? defaultDelegateRoot(cwd);
	}
}

async function authorizeDelegatedWrite(ctx: ExtensionContext, request: SubagentStartRequest): Promise<boolean> {
	if (ctx.mode !== "tui") return false;
	const target = request.tasks?.length ? `${request.tasks.length} Subagents` : request.resume ? `resumed Subagent ${request.resume}` : `${request.agent ?? "Subagent"} persona`;
	return ctx.ui.confirm("Authorize delegated writes?", `${target} will receive edit/write tools and shell access for this run.`);
}

function runTerminalKey(run: DelegateRun): string {
	return `${run.spec.id}:${run.spec.generation}`;
}

function isTerminal(status: DelegateRunStatus): boolean {
	return !["starting", "running", "stopping"].includes(status);
}

function terminalStatus(status: DelegateRunStatus): RuntimeTerminalStatus {
	if (status === "needs_attention") return "blocked";
	return status === "limited" ? "limited" : status as RuntimeTerminalStatus;
}
