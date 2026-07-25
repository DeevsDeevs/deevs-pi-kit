import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampConcurrency, clampTimeoutMs, loadAgentsSettings } from "./config.ts";
import { findAgent, loadBuiltinAgents } from "./agents.ts";
import { defaultDelegateRoot } from "./artifacts.ts";
import { DelegateExecutor } from "./executor.ts";
import type { DelegateRun, DelegateRunStatus } from "./runtime-types.ts";
import { requestRuntimeDelivery } from "../shared/runtime-delivery.ts";
import { runtimeEvents, type RuntimeTerminalStatus } from "../shared/runtime-events.ts";
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
	/** Internal: foreground workflow children return through their owning tool call instead of a second wake. */
	deliverTerminal?: boolean;
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
	private ctx?: ExtensionContext;
	private unsubscribe: () => void;
	private readonly artifactsRoot?: string;

	constructor(pi: ExtensionAPI, executor = new DelegateExecutor(), artifactsRoot?: string) {
		this.pi = pi;
		this.executor = executor;
		this.artifactsRoot = artifactsRoot;
		this.unsubscribe = executor.onChange((run) => void this.onRunChange(run));
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
				this.activate(run);
				return run;
			} finally {
				this.startingRuns--;
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
		}, ctx, request.background !== false);
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

	list(): { runs: DelegateRun[]; groups: SubagentGroup[] } {
		return { runs: this.executor.list(), groups: [...this.groups.values()].sort((a, b) => b.createdAt - a.createdAt) };
	}

	clearTerminal(id?: string): number {
		let cleared = 0;
		for (const group of [...this.groups.values()]) {
			if ((id && group.id !== id) || group.status === "running") continue;
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
			rmSync(run.spec.artifactsDir, { recursive: true, force: true });
			this.executor.forget(run.spec.id);
			this.terminalSeen.delete(run.spec.id);
			cleared++;
		}
		return cleared;
	}

	async restore(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		if (!parentSessionFile) return;
		for (const run of this.executor.list()) if (run.spec.parentSessionFile !== parentSessionFile) {
			this.executor.detach(run.spec.id);
			this.terminalSeen.delete(run.spec.id);
		}
		for (const group of [...this.groups.values()]) if (group.parentSessionFile !== parentSessionFile) {
			this.groups.delete(group.id);
			this.roots.delete(group.id);
			this.terminalSeen.delete(group.id);
		}
		const root = this.root(ctx.cwd);
		await this.executor.restore(ctx.cwd, parentSessionFile);
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
	}

	dispose(): void {
		this.unsubscribe();
		this.executor.dispose();
	}

	private async startTask(task: SubagentTaskInput, ctx: ExtensionContext, background: boolean): Promise<DelegateRun> {
		const agents = loadBuiltinAgents();
		const persona = findAgent(agents, task.agent);
		if (!persona || persona.disabled) throw new Error(`Unknown or disabled persona: ${task.agent}`);
		const cwd = path.resolve(task.cwd ?? ctx.cwd);
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
				parentSessionFile: ctx.sessionManager.getSessionFile(),
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
			this.activate(run);
			return run;
		} finally {
			this.startingRuns--;
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
				const run = await this.startTask(task, ctx, true);
				group.children.push(run.spec.id);
				group.active.push(run.spec.id);
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
		if (this.terminalSeen.has(run.spec.id)) return;
		this.terminalSeen.add(run.spec.id);
		this.activate(run);
		if (run.spec.allowWrite) chainCheckpoints.current?.due(`write-enabled subagent ${run.spec.id} settled`);
		if (run.spec.deliverTerminal === false) {
			this.pruneTerminal();
			return;
		}
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: `terminal:${run.spec.id}:${run.spec.generation}`,
				dedupeKey: `subagent:${run.spec.id}:${run.spec.generation}:terminal`,
				source: { kind: "subagent", id: run.spec.id, generation: run.spec.generation },
				type: run.runtime.status === "needs_attention" ? "attention" : "terminal",
				status: terminalStatus(run.runtime.status),
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
				if (group.pending.length && this.ctx) {
					await this.fillGroup(group, this.ctx);
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

function isTerminal(status: DelegateRunStatus): boolean {
	return !["starting", "running", "stopping"].includes(status);
}

function terminalStatus(status: DelegateRunStatus): RuntimeTerminalStatus {
	if (status === "needs_attention") return "blocked";
	return status === "limited" ? "limited" : status as RuntimeTerminalStatus;
}
