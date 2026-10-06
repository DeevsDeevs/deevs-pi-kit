// The only code that imports pi-durable. Agents run as durable conversations inside the lead's process: they survive
// /reload, pause when Pi exits and continue when their session reopens; their reports reach the lead exactly once.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, getAgentDir, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { guardBashCall } from "../../shared/guard.ts";
import { loadKitConfig, modelLabel, resolveModel, type ModelContext } from "../../shared/models.ts";
import { agentSummary, newAgentId, tasks, workflowDiagnostics, workflowRecovery, workflowSummary, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";
import { addWorktree, agentWorktreeAt, createAgentWorktree, finishAgentWorktree, git, type AgentWorktree } from "../../shared/worktree.ts";
import { LEVELS, PI_TOOLS, workerPrompt, workflowAgentType, type PiToolName } from "../definitions.ts";
import { parseWorkflow } from "../workflow/meta.ts";
import { driveWorkflow, framePrompt, newProgress, runRecord, usage, type AgentRunner, type CallOutcome, type Progress } from "../workflow/run.ts";
import type { AgentOptions, JsonValue } from "../workflow/sandbox.ts";
import { bunSqlite, lock, reap, unlock } from "./storage.ts";

type D = typeof Durable;
type Ctx = Parameters<Durable.Harness["close"]>[0];
type ConversationId = Durable.ConversationId;
// Documents hold strict JSON; these shapes are read and written through `json()`.
type OutboxDoc = { items: Durable.JsonObject[] };
type AgentsDoc = { agents: Record<string, Durable.JsonObject> };
type WorkflowsDoc = { workflows: Record<string, Durable.JsonObject> };

/** One global throttle across every engine and Workflow: at most 16 agents run, the rest queue FIFO. */
export const AGENT_SLOTS = 16;
const SAFE_TOOLS = new Set<PiToolName>(["read", "grep", "find", "ls"]);
const FACTORIES = { read: createReadTool, grep: createGrepTool, find: createFindTool, ls: createLsTool, bash: createBashTool, edit: createEditTool, write: createWriteTool };
// ponytail: a structural chord Context that never cancels; import chord's BACKGROUND_CONTEXT if durable starts checking identity.
const CTX: Ctx = { abortSignal: undefined, value: () => undefined, toString: () => "pi-kit" };
const FailureDetail = Type.Object({ message: Type.String() });
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

export interface Limits { maxTurns?: number; maxTokens?: number; timeout?: number }

export interface LaunchSpec {
	agentId: string;
	description: string;
	prompt: string;
	name?: string;
	model: Model<Api>;
	level?: ModelThinkingLevel;
	tools: PiToolName[];
	instructions: string;
	cwd: string;
	writer: boolean;
	toolUseId: string;
	limits: Limits;
	foreground: boolean;
	worktree?: AgentWorktree;
}

interface AgentRecord {
	name?: string;
	description: string;
	conversationId: ConversationId;
	startedAt: number;
	status: TaskStatus;
	cwd: string;
	writer: boolean;
	stopped?: boolean;
	/** Set only by `/agents stop`; SendMessage refuses such an agent. */
	stoppedBy?: "user";
	worktree?: AgentWorktree;
}
type OutboxItem = TaskNotification & { silent?: boolean };
interface ReporterInput {
	agentId: string;
	session: string;
	conversationId: ConversationId;
	prompt: string;
	requestId: string;
	description: string;
	toolUseId: string;
	limits: Limits;
	startedAt: number;
	outputFile: string;
	worktree?: AgentWorktree;
}

/** A Workflow run: the script, its snapshot of the user's request and the lead's model, all fixed at launch. */
export interface WorkflowInput {
	taskId: string;
	runId: string;
	session: string;
	toolUseId: string;
	source: string;
	scriptPath: string;
	args?: JsonValue;
	cwd: string;
	/** The transcript dir: journal.jsonl, progress.jsonl, `<runId>.json` and each agent's transcript. */
	dir: string;
	request?: string;
	lead?: { provider: string; id: string; level: ModelThinkingLevel };
	startedAt: number;
}
interface WorkflowRecord {
	runId: string;
	description: string;
	startedAt: number;
	status: TaskStatus;
	durableTaskId?: Durable.TaskId;
}
/** The crash map: one per agent() call, keyed by prompt, options and occurrence; written with the call's conversation, then with its outcome. */
type CallRecord = Partial<CallOutcome> & { agentId: string; conversationId: ConversationId; worktree?: AgentWorktree };
type WorkflowRuntime = Durable.TaskRuntime<WorkflowInput, { phase: "run" }, null, object>;

interface Kit {
	extension: Durable.Extension;
	tools: Record<PiToolName, Durable.ToolRegistration>;
	Outbox: Durable.ConversationDocToken<OutboxDoc>;
	Agents: Durable.ConversationDocToken<AgentsDoc>;
	Workflows: Durable.ConversationDocToken<WorkflowsDoc>;
	Calls: Durable.ConversationDocFamilyToken<Durable.JsonObject, string>;
	Anchor: Durable.Task<null, { phase: "done" }, null, object>;
	Reporter: Durable.Task<ReporterInput, { phase: "run" }, null, object>;
	Workflow: Durable.Task<WorkflowInput, { phase: "run" }, null, object>;
}

export interface Engine {
	session: string;
	dir: string;
	project: string;
	harness: Durable.Harness;
	root: Durable.Conversation;
	registry: Durable.Registry;
	kit: Kit;
}

interface Modules { D: D; openStorage(file: string): Promise<Durable.Storage> }
interface Waiter { claimed: boolean; timedOut: boolean; resolve(n: TaskNotification): void }
interface Host {
	/** The durable module stays loaded across /reload: a fresh copy would fail its own `instanceof` checks. */
	modules?: Promise<Modules>;
	engines: Map<string, Promise<Engine>>;
	models?: ModelRegistry;
	running: number;
	queue: { agentId: string; go(held: boolean): void }[];
	waiters: Map<string, Waiter>;
	/** Live progress of each workflow run, by its task id: the widget and /agents read it across /reload. */
	workflows: Map<string, Progress>;
}

const KEY = Symbol.for("pi-kit.agents");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores the host in it.
const slot = globalThis as typeof globalThis & { [KEY]?: Host };
const host: Host = slot[KEY] ??= { engines: new Map(), running: 0, queue: [], waiters: new Map(), workflows: new Map() };
host.workflows ??= new Map();

tasks.addSource({
	name: "agents",
	async pending(session) {
		const engine = await host.engines.get(session)?.catch(() => undefined);
		if (!engine) return [];
		return outboxItems(await engine.harness.snapshot(engine.kit.Outbox, engine.root.id, CTX)).filter((item) => !item.silent);
	},
});

/** Opens (once) the engine of the context's session; its storage lives under the agent dir, per project and session. */
export function ensureEngine(ctx: ExtensionContext): Promise<Engine> {
	host.models = ctx.modelRegistry;
	const session = ctx.sessionManager.getSessionId();
	let engine = host.engines.get(session);
	if (!engine) {
		engine = open(session, ctx.cwd);
		host.engines.set(session, engine);
		engine.catch(() => host.engines.delete(session));
	}
	return engine;
}

/**
 * At session start: load durable, then resume a session's paused agents only when it has a store; other sessions' stores stay untouched.
 * Node loads durable's module graph synchronously (about 400 ms); loaded here, that stall never lands on an Agent launch.
 */
export async function resumeSession(ctx: ExtensionContext): Promise<void> {
	host.models = ctx.modelRegistry;
	await (host.modules ??= loadModules());
	if (host.engines.has(ctx.sessionManager.getSessionId())) return;
	const exists = await access(join(await storageDir(ctx.cwd, ctx.sessionManager.getSessionId()), "engine.sqlite")).then(() => true, () => false);
	if (exists) await ensureEngine(ctx);
}

/** /reload keeps every harness and swaps in this module graph's task and tool code. */
export async function reinstall(): Promise<void> {
	if (!host.modules) return;
	const { D } = await host.modules;
	for (const pending of host.engines.values()) {
		const engine = await pending.catch(() => undefined);
		if (!engine) continue;
		engine.kit = buildKit(D, engine.dir, engine.project);
		engine.registry.install(engine.kit.extension);
	}
}

/** On quit: reap tool children, close each harness (work stays pending for the next start), release the locks. */
export async function closeAll(): Promise<void> {
	const engines = [...host.engines.values()];
	host.engines.clear();
	for (const pending of engines) {
		const engine = await pending.catch(() => undefined);
		if (!engine) continue;
		await reap(engine.dir);
		await engine.harness.close(CTX).catch(() => {});
		await unlock(join(engine.dir, "engine.lock"));
	}
}

export function queuedAhead(): boolean {
	return host.running >= AGENT_SLOTS;
}

export async function launch(engine: Engine, spec: LaunchSpec): Promise<{ outputFile: string; done?: Promise<TaskNotification> }> {
	const { D } = await host.modules!;
	const { agentId } = spec;
	const outputFile = join(engine.dir, "out", `${agentId}.md`);
	const startedAt = Date.now();
	const done = spec.foreground ? new Promise<TaskNotification>((resolve) => host.waiters.set(agentId, { claimed: false, timedOut: false, resolve })) : undefined;
	const { kit, root } = engine;
	await root.commit(async (tx) => {
		const anchor = await tx.createTask(kit.Anchor, null, BACKGROUND);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await D.configure(tx, child.id, {
			model: { provider: spec.model.provider, modelId: spec.model.id },
			thinkingLevel: spec.level,
			tools: spec.tools.map((name) => kit.tools[name]),
			instructions: spec.instructions,
			cwd: spec.cwd,
		});
		const input: ReporterInput = { agentId, session: engine.session, conversationId: child.id, prompt: spec.prompt, requestId: `agent:${agentId}`, description: spec.description, toolUseId: spec.toolUseId, limits: spec.limits, startedAt, outputFile, worktree: spec.worktree };
		await tx.createTask(kit.Reporter, input, BACKGROUND);
		(await tx.doc(kit.Agents, root.id)).agents[agentId] = json({ name: spec.name, description: spec.description, conversationId: child.id, startedAt, status: "running", cwd: spec.cwd, writer: spec.writer, worktree: spec.worktree });
	}, CTX);
	tasks.register({ id: agentId, kind: "agent", name: spec.name, description: spec.description, status: "running", ownerSession: engine.session, startedAt, stop: () => stop(engine, agentId) });
	return { outputFile, done };
}

/** SendMessage: a running agent gets a steer at its next tool round; any other is resumed on its own conversation and notifies again. */
export async function send(engine: Engine, agentId: string, message: string, toolUseId: string): Promise<"steered" | "resumed" | "refused"> {
	const record = agentRecords(await engine.harness.snapshot(engine.kit.Agents, engine.root.id, CTX))[agentId]!;
	if (record.stoppedBy === "user") return "refused";
	const requestId = `send:${randomUUID()}`;
	if (record.status === "running") {
		const conversation = (await engine.harness.conversation(record.conversationId, CTX))!;
		const submission = await conversation.submit({ type: "input", content: message, requestId, whenBusy: "steer" }, CTX);
		// An idle conversation (the agent waits for a slot, or just answered) runs the message at once; that run gets its own report.
		if ((await submission.status(CTX)).status === "queued") return "steered";
	}
	const worktree = record.worktree && await reopenWorktree(record.worktree);
	await engine.root.commit(async (tx) => {
		const current = agentRecords(await tx.doc(engine.kit.Agents, engine.root.id))[agentId]!;
		current.status = "running";
		current.stopped = false;
		if (worktree) current.worktree = worktree;
		const input: ReporterInput = { agentId, session: engine.session, conversationId: record.conversationId, prompt: message, requestId, description: record.description, toolUseId, limits: {}, startedAt: Date.now(), outputFile: join(engine.dir, "out", `${agentId}.md`), worktree };
		await tx.createTask(engine.kit.Reporter, input, BACKGROUND);
	}, CTX);
	tasks.update(agentId, { status: "running" });
	return "resumed";
}

/** A resumed agent works in its worktree again; one removed as unchanged comes back on its branch at today's HEAD. */
async function reopenWorktree(worktree: AgentWorktree): Promise<AgentWorktree> {
	if (existsSync(worktree.path)) return worktree;
	const base = (await git(worktree.repoRoot, ["rev-parse", "HEAD"])).trim();
	await addWorktree(worktree.repoRoot, worktree.branch, worktree.path, base);
	return { ...worktree, base };
}

/** Where running writers work, for the shared-cwd warning. */
export async function writerCwds(engine: Engine): Promise<{ cwd: string }[]> {
	return Object.values(agentRecords(await engine.harness.snapshot(engine.kit.Agents, engine.root.id, CTX))).filter((record) => record.status === "running" && record.writer);
}

/** Foreground: the report if it lands within `ms`; otherwise the agent continues in the background and notifies. Esc keeps the report out of the notifications. */
export async function settle(agentId: string, done: Promise<TaskNotification>, ms: number, signal: AbortSignal | undefined): Promise<TaskNotification | "background" | "aborted"> {
	const waiter = host.waiters.get(agentId)!;
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const raced = await Promise.race([
		done,
		new Promise<"background">((resolve) => { timer = setTimeout(() => resolve("background"), ms); }),
		new Promise<"aborted">((resolve) => {
			onAbort = () => resolve("aborted");
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		}),
	]);
	clearTimeout(timer);
	if (onAbort) signal?.removeEventListener("abort", onAbort);
	if (raced === "aborted") {
		waiter.claimed = true;
		return raced;
	}
	if (raced !== "background" || waiter.claimed) return done;
	waiter.timedOut = true;
	host.waiters.delete(agentId);
	return "background";
}

export async function stop(engine: Engine, agentId: string, by?: "user"): Promise<void> {
	let conversationId: ConversationId | undefined;
	await engine.root.commit(async (tx) => {
		const record = agentRecords(await tx.doc(engine.kit.Agents, engine.root.id))[agentId];
		if (!record) return;
		record.stopped = true;
		if (by) record.stoppedBy = by;
		conversationId = record.conversationId;
	}, CTX);
	const queued = host.queue.findIndex((entry) => entry.agentId === agentId);
	if (queued >= 0) host.queue.splice(queued, 1)[0]!.go(false);
	if (conversationId !== undefined) await (await engine.harness.conversation(conversationId, CTX))?.abort(CTX);
}

async function open(session: string, cwd: string): Promise<Engine> {
	const dir = await storageDir(cwd, session);
	await mkdir(join(dir, "out"), { recursive: true });
	await lock(join(dir, "engine.lock"));
	await reap(dir);
	const { D, openStorage } = await (host.modules ??= loadModules());
	const registry = D.createRegistry();
	const kit = buildKit(D, dir, cwd);
	registry.install(kit.extension);
	const harness = await D.Harness.open(await openStorage(join(dir, "engine.sqlite")), {
		models: modelsAdapter(),
		registry,
		settings: { progress: { partialIntervalMs: 500, outputIntervalMs: 500 } },
		onReport: () => {},
	}, CTX);
	const root = await harness.root(CTX);
	const engine: Engine = { session, dir, project: cwd, harness, root, registry, kit };
	for (const [id, record] of Object.entries(agentRecords(await harness.snapshot(kit.Agents, root.id, CTX)))) {
		tasks.register({ id, kind: "agent", name: record.name, description: record.description, status: record.status, ownerSession: session, startedAt: record.startedAt, stop: () => stop(engine, id) });
	}
	for (const [id, record] of Object.entries(workflowRecords(await harness.snapshot(kit.Workflows, root.id, CTX)))) registerWorkflow(engine, id, record);
	harness.resume();
	for (const item of outboxItems(await harness.snapshot(kit.Outbox, root.id, CTX))) if (!item.silent) await tasks.notify(item);
	return engine;
}

async function storageDir(cwd: string, session: string): Promise<string> {
	const project = createHash("sha256").update(await realpath(cwd).catch(() => cwd)).digest("hex").slice(0, 16);
	return join(getAgentDir(), "pi-kit", "agents", project, session);
}

async function loadModules(): Promise<Modules> {
	const D = await import("@earendil-works/pi-durable");
	if ("Bun" in globalThis) {
		const bunModule: string = "bun:sqlite";
		const { Database } = await import(bunModule);
		const { SqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite");
		return { D, openStorage: (file) => SqliteStorage.open(bunSqlite(Database, file)) };
	}
	const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
	return { D, openStorage: openNodeSqliteStorage };
}

/** durable calls models through Pi's own registry: the lead's auth and providers, and one token refresher. */
function modelsAdapter(): Durable.HarnessOptions["models"] {
	const registry = (): ModelRegistry => {
		if (!host.models) throw new Error("Pi's model registry is not available yet.");
		return host.models;
	};
	// SAFETY: durable calls only these five members of pi-ai's Models; the rest of that interface is never reached.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions
	return {
		getModel: (provider: string, id: string) => registry().find(provider, id),
		streamSimple: (...args: Parameters<ModelRegistry["streamSimple"]>) => registry().streamSimple(...args),
		completeSimple: (...args: Parameters<ModelRegistry["streamSimple"]>) => registry().streamSimple(...args).result(),
		fetchDeferred: () => { throw new Error("Deferred model calls are not available to kit agents."); },
		cancelDeferred: async () => {},
	} as unknown as Durable.HarnessOptions["models"];
}

/** `project` is the lead's cwd: the guard's rm root for every agent, whatever cwd the lead gave it, except an isolated agent's own worktree. */
function buildKit(D: D, owner: string, project: string): Kit {
	const Outbox = D.defineDoc<OutboxDoc>({ kind: "pi-kit.outbox", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });
	const Agents = D.defineDoc<AgentsDoc>({ kind: "pi-kit.agents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: {} }) });
	const Workflows = D.defineDoc<WorkflowsDoc>({ kind: "pi-kit.workflows", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ workflows: {} }) });
	// On the lead's conversation, keyed by run and call: a task's own documents are all retired in its terminal commit.
	const Calls = D.defineDocFamily<Durable.JsonObject, string>({ kind: "pi-kit.workflow-call", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (agentId) => ({ agentId }) });
	const terminal = <S extends { phase: string }>(status: "completed" | "aborted") => (_task: Durable.RunningTask<unknown, S, null>, runtime: Durable.TaskRuntime<unknown, S, null, object>, context: Ctx) =>
		runtime.commit(() => (status === "completed" ? { status: "terminal", outcome: { status, result: null } } : { status: "terminal", outcome: { status } }), context);
	// Owns the agent's conversation so it outlives its report, for a later SendMessage.
	const Anchor = D.defineTask<null, { phase: "done" }, null>({ name: "pi-kit.agent-anchor", version: 1, initial: () => ({ phase: "done" }), phases: { done: terminal("completed") }, abort: terminal("aborted") });
	const Reporter = D.defineTask<ReporterInput, { phase: "run" }, null>({
		name: "pi-kit.agent-reporter",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, context) => report(D, { Outbox, Agents }, task.input, runtime, context) },
		abort: terminal("aborted"),
	});
	// SAFETY: one entry for every PI_TOOLS name.
	const tools = Object.fromEntries(PI_TOOLS.map((name) => [name, piTool(D, name, owner)])) as Record<PiToolName, Durable.ToolRegistration>;
	const docs = { Outbox, Workflows, Calls, tools };
	// The script re-runs from the top after an interruption; the crash map answers every call that already finished.
	const Workflow = D.defineTask<WorkflowInput, { phase: "run" }, null>({
		name: "pi-kit.workflow",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, context) => runWorkflowTask(D, docs, task.input, runtime, context) },
		abort: (task, runtime, context) => abortWorkflowTask(docs, task.input, runtime, context),
	});
	const guard = D.hook(D.ToolTask, {
		beforeTool: async (call, api, context) => {
			if (call.name !== "bash") return undefined;
			const cwd = (await api.snapshot(D.AgentDoc, api.conversationId, context))?.cwd ?? process.cwd();
			const blocked = guardBashCall(String(call.arguments.command ?? ""), cwd, agentWorktreeAt(cwd, getAgentDir()) ?? project);
			return blocked ? { block: blocked.reason } : undefined;
		},
	});
	const extension = D.defineExtension({ name: "pi-kit", tasks: [Anchor, Reporter, Workflow], tools: Object.values(tools), hooks: [guard] });
	return { extension, tools, Outbox, Agents, Workflows, Calls, Anchor, Reporter, Workflow };
}

/** Pi's own tool, built for the agent's cwd at each call and without a Pi context, so no lead session env leaks in. */
function piTool(D: D, name: PiToolName, owner: string): Durable.ToolRegistration {
	const make = (cwd: string) => name === "bash"
		? createBashTool(cwd, { spawnHook: (spawn) => ({ ...spawn, env: { ...spawn.env, PI_KIT_OWNER: owner } }) })
		: FACTORIES[name](cwd);
	const piDefinition = make(process.cwd());
	return D.defineTool({
		name,
		description: piDefinition.description,
		parameters: piDefinition.parameters,
		replay: SAFE_TOOLS.has(name) ? "safe" : "unsafe",
		prepareArguments: piDefinition.prepareArguments,
		execute: async (args, api, context) => {
			const cwd = (await api.agent(context)).cwd ?? process.cwd();
			// SAFETY: durable validated `args` against this very tool's parameters before execute().
			const result = await make(cwd).execute(api.callId, args as never, context.abortSignal);
			return { content: result.content };
		},
	});
}

async function report(D: D, docs: Pick<Kit, "Outbox" | "Agents">, input: ReporterInput, runtime: Durable.TaskRuntime<ReporterInput, { phase: "run" }, null, object>, context: Ctx): Promise<void> {
	const engine = (await host.engines.get(input.session))!;
	const conversation = (await engine.harness.conversation(input.conversationId, context))!;
	const record = async () => agentRecords(await runtime.snapshot(docs.Agents, runtime.conversationId, context))[input.agentId];
	let settled: Durable.SettledSubmissionRecord | undefined;
	let limited: string | undefined;
	const held = await acquire(input.agentId);
	try {
		if (held && !(await record())?.stopped) {
			const submission = await conversation.submit({ type: "input", content: input.prompt, requestId: input.requestId }, context);
			const unwatch = watchLimits(D, engine, input, (limit) => {
				limited = limit;
				void conversation.abort(CTX);
			});
			settled = await submission.wait(context).finally(unwatch);
		}
	} finally {
		if (held) release();
	}
	// A steer that missed the last tool round runs on after the answer; the report waits for it and carries the last answer.
	await conversation.waitForIdle(context);
	const transcript = await scan(conversation, context);
	const usage = (await runtime.snapshot(D.UsageDoc, input.conversationId, context))?.models ?? {};
	const lastText = text(transcript.filter((entry) => entry.kind === "pi.assistant").at(-1)?.model?.[0]);
	if (settled?.status === "done") limited = undefined;
	const output = settled?.status === "done" || limited ? lastText : "";
	const status = settled?.status === "done" ? "completed"
		: limited ? (output ? "completed" : "failed")
		: settled === undefined || settled.status === "unanswered" && settled.reason === "aborted" ? "killed" : "failed";
	const kept = input.worktree && existsSync(input.worktree.path) ? await finishAgentWorktree(input.worktree).catch(() => input.worktree) : undefined;
	const n: OutboxItem = {
		notificationId: `${input.agentId}:${String(runtime.taskId)}`,
		taskId: input.agentId,
		kind: "agent",
		ownerSession: input.session,
		toolUseId: input.toolUseId,
		outputFile: input.outputFile,
		status,
		summary: limited
			? `Agent "${input.description}" stopped at its ${limited} limit (partial result)`
			: agentSummary(input.description, status, { error: failure(settled), byUser: (await record())?.stoppedBy === "user" }),
		result: output,
		usage: {
			subagentTokens: Object.values(usage).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0),
			toolUses: transcript.filter((entry) => entry.kind === "pi.tool-result").length,
			durationMs: Date.now() - input.startedAt,
		},
	};
	if (limited) n.limited = limited;
	if (kept) n.worktree = { path: kept.path, branch: kept.branch };
	await writeFile(input.outputFile, `${transcriptLog(transcript)}\n\n${output}\n`).catch(() => {});
	const waiter = host.waiters.get(input.agentId);
	await runtime.commit(async (tx) => {
		const record = agentRecords(await tx.doc(docs.Agents, runtime.conversationId))[input.agentId];
		if (record) record.status = n.status;
		if (waiter && !waiter.timedOut) waiter.claimed = true;
		(await tx.doc(docs.Outbox, runtime.conversationId)).items.push(json({ ...n, silent: waiter?.claimed || undefined }));
		return { status: "terminal", outcome: { status: "completed", result: null } };
	}, context);
	tasks.update(input.agentId, { status: n.status });
	if (waiter?.claimed) {
		host.waiters.delete(input.agentId);
		waiter.resolve(n);
	} else await tasks.notify(n);
}

/** `maxTurns`, `maxTokens` and `timeout` exist only when the user asked; the first one reached stops the agent. */
function watchLimits(D: D, engine: Engine, input: ReporterInput, hit: (limit: string) => void): () => void {
	const { maxTurns, maxTokens, timeout } = input.limits;
	if (!maxTurns && !maxTokens && !timeout) return () => {};
	let turns = 0;
	let fired = false;
	const fire = (limit: string) => {
		if (fired) return;
		fired = true;
		hit(limit);
	};
	const timer = timeout ? setTimeout(() => fire(`${timeout} ms timeout`), Math.max(0, input.startedAt + timeout - Date.now())) : undefined;
	const unsubscribe = engine.harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type !== "entry" || change.value.conversationId !== input.conversationId || change.value.kind !== "pi.assistant") continue;
			if (maxTurns && ++turns >= maxTurns) fire(`${maxTurns}-turn`);
			if (maxTokens) void engine.harness.snapshot(D.UsageDoc, input.conversationId, CTX).then((usage) => {
				const tokens = Object.values(usage?.models ?? {}).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0);
				if (tokens >= maxTokens) fire(`${maxTokens}-token`);
			});
		}
	});
	return () => {
		clearTimeout(timer);
		unsubscribe();
	};
}

function acquire(agentId: string): Promise<boolean> {
	if (host.running < AGENT_SLOTS) {
		host.running++;
		return Promise.resolve(true);
	}
	return new Promise((go) => host.queue.push({ agentId, go }));
}

/** A freed slot passes straight to the oldest queued agent. */
function release(): void {
	const next = host.queue.shift();
	if (next) next.go(true);
	else host.running--;
}

async function scan(conversation: Durable.Conversation, context: Ctx): Promise<Durable.EntryRecord[]> {
	const entries: Durable.EntryRecord[] = [];
	let cursor: Durable.Cursor | undefined;
	do {
		const page = await conversation.entries({}, 500, cursor, context);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor);
	// Pages come newest first.
	return entries.reverse();
}

function text(message: Message | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function transcriptLog(entries: readonly Durable.EntryRecord[]): string {
	return entries.flatMap((entry) => (entry.model ?? []).flatMap((message) => {
		if (message.role === "assistant") return message.content.flatMap((block) => block.type === "toolCall" ? [`→ ${block.name} ${JSON.stringify(block.arguments).slice(0, 300)}`] : block.type === "text" && block.text ? [block.text] : []);
		if (message.role === "toolResult") return [`← ${message.isError ? "error " : ""}${message.content.flatMap((block) => (block.type === "text" ? [block.text.slice(0, 300)] : [])).join("")}`];
		return [];
	})).join("\n");
}

function failure(settled: Durable.SettledSubmissionRecord | undefined): string {
	if (settled?.status !== "unanswered") return "no answer";
	return Value.Check(FailureDetail, settled.detail) ? settled.detail.message : settled.reason;
}

/** Documents hold strict JSON: optional fields that are `undefined` are dropped. */
function json(value: AgentRecord | OutboxItem | WorkflowRecord | CallRecord | CallOutcome): Durable.JsonObject {
	return JSON.parse(JSON.stringify(value));
}

// Documents hold JsonObject, which no interface with optional fields can be asserted from directly.
// SAFETY: the kit writes the Outbox only through json() of an OutboxItem.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const outboxItems = (doc: OutboxDoc | undefined) => (doc?.items ?? []) as unknown as OutboxItem[];
// SAFETY: the kit writes Agents only through json() of an AgentRecord.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const agentRecords = (doc: AgentsDoc | undefined) => (doc?.agents ?? {}) as unknown as Record<string, AgentRecord>;
// SAFETY: the kit writes Workflows only through json() of a WorkflowRecord.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const workflowRecords = (doc: WorkflowsDoc | undefined) => (doc?.workflows ?? {}) as unknown as Record<string, WorkflowRecord>;
// SAFETY: the kit writes a Calls member only through json() of a CallRecord.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const callRecord = (doc: Readonly<Durable.JsonObject> | undefined) => (doc?.conversationId === undefined ? undefined : doc as unknown as CallRecord);

export async function launchWorkflow(engine: Engine, input: WorkflowInput, description: string): Promise<void> {
	const { kit, root } = engine;
	const record: WorkflowRecord = { runId: input.runId, description, startedAt: input.startedAt, status: "running" };
	await root.commit(async (tx) => {
		record.durableTaskId = await tx.createTask(kit.Workflow, input, BACKGROUND);
		(await tx.doc(kit.Workflows, root.id)).workflows[input.taskId] = json(record);
	}, CTX);
	registerWorkflow(engine, input.taskId, record);
}

/** Live progress of a session's workflow runs since this Pi started. */
export function workflowProgress(session: string): Progress[] {
	return [...host.workflows.values()].filter((progress) => progress.session === session);
}

function registerWorkflow(engine: Engine, id: string, record: WorkflowRecord): void {
	const stopRun = async () => {
		if (record.durableTaskId !== undefined) await engine.harness.abortTask(record.durableTaskId, CTX);
	};
	tasks.register({ id, kind: "workflow", name: record.runId, description: record.description, status: record.status, ownerSession: engine.session, startedAt: record.startedAt, stop: stopRun });
}

function trackProgress(input: WorkflowInput): Progress {
	const progress = host.workflows.get(input.taskId) ?? newProgress({ taskId: input.taskId, runId: input.runId, session: input.session, meta: parseWorkflow(input.source).meta, startedAt: input.startedAt });
	host.workflows.set(input.taskId, progress);
	return progress;
}

type WorkflowDocs = Pick<Kit, "Outbox" | "Workflows" | "Calls" | "tools">;

async function runWorkflowTask(D: D, docs: WorkflowDocs, input: WorkflowInput, runtime: WorkflowRuntime, context: Ctx): Promise<void> {
	const engine = (await host.engines.get(input.session))!;
	const workflow = parseWorkflow(input.source);
	const progress = trackProgress(input);
	let result: JsonValue | undefined;
	let error: string | undefined;
	try {
		result = await driveWorkflow(workflow, input.args, input.dir, callRunner(D, docs, engine, input, runtime, context), progress, runtime.signal);
	} catch (thrown) {
		if (runtime.signal.aborted) throw thrown;
		error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
	}
	const status = error === undefined ? "completed" : "failed";
	progress.status = status;
	const durationMs = Date.now() - input.startedAt;
	const outputFile = join(input.dir, `${input.runId}.json`);
	await writeFile(outputFile, runRecord({ progress, script: input.source, scriptPath: input.scriptPath, args: input.args, result, error, defaultModel: input.lead && `${input.lead.provider}/${input.lead.id}`, durationMs })).catch(() => {});
	const n: TaskNotification = {
		notificationId: `${input.taskId}:${String(runtime.taskId)}`,
		taskId: input.taskId,
		kind: "workflow",
		ownerSession: input.session,
		toolUseId: input.toolUseId,
		outputFile,
		status,
		summary: workflowSummary(workflow.meta.description, status, error),
		...(status === "completed"
			? { result: JSON.stringify(result ?? null), diagnostics: workflowDiagnostics(input.dir, input.scriptPath, input.runId) }
			: { recovery: workflowRecovery(input.dir, input.scriptPath, input.runId) }),
		failures: progress.failures.length ? progress.failures.join("\n").slice(0, 40_000) : undefined,
		usage: usage(progress, durationMs),
	};
	await runtime.commit(async (tx) => {
		(await tx.doc(docs.Outbox, runtime.conversationId)).items.push(json(n));
		const record = workflowRecords(await tx.doc(docs.Workflows, runtime.conversationId))[input.taskId];
		if (record) record.status = status;
		return { status: "terminal", outcome: { status: "completed", result: null } };
	}, context);
	tasks.update(input.taskId, { status });
	await tasks.notify(n);
}

/** TaskStop: the owned agents are aborted first; the run record says `killed`, and no notification follows, as in CC. */
async function abortWorkflowTask(docs: WorkflowDocs, input: WorkflowInput, runtime: WorkflowRuntime, context: Ctx): Promise<void> {
	const progress = trackProgress(input);
	progress.status = "killed";
	await writeFile(join(input.dir, `${input.runId}.json`), runRecord({ progress, script: input.source, scriptPath: input.scriptPath, args: input.args, result: undefined, durationMs: Date.now() - input.startedAt })).catch(() => {});
	await runtime.commit(async (tx) => {
		const record = workflowRecords(await tx.doc(docs.Workflows, runtime.conversationId))[input.taskId];
		if (record) record.status = "killed";
		return { status: "terminal", outcome: { status: "aborted" } };
	}, context);
	tasks.update(input.taskId, { status: "killed" });
}

/** agent() over durable: a slot of the global throttle, then a conversation the run owns, answered once even across a Pi exit. */
function callRunner(D: D, docs: WorkflowDocs, engine: Engine, input: WorkflowInput, runtime: WorkflowRuntime, context: Ctx): AgentRunner {
	const instructions = new Map<string, string>();
	const member = (key: string) => `${input.taskId}:${key}`;
	const read = async (key: string) => callRecord(await runtime.snapshot(docs.Calls, runtime.conversationId, member(key), context));
	let creating = Promise.resolve();
	const create = async (key: string, options: AgentOptions): Promise<CallRecord> => {
		const type = workflowAgentType(options.agentType);
		const resolved = resolveModel(options.model ?? type.model, await modelContext(input), LEVELS.find((level) => level === options.effort) ?? type.effort);
		if (resolved.harness !== "pi") throw new Error(`${modelLabel(resolved)} runs as a Claude Code or Codex worker, which the kit does not start yet; pick a Pi model.`);
		const agentId = newAgentId();
		const requested = resolve(input.cwd, options.cwd ?? ".");
		const worktree = (options.isolation ?? type.isolation) === "worktree" ? await createAgentWorktree({ cwd: requested, agentId, agentDir: getAgentDir() }) : undefined;
		const cwd = worktree ? join(worktree.path, relative(worktree.repoRoot, realpathSync(requested))) : requested;
		const prompt = `${type.name}\0${cwd}`;
		// Context files and skills are read once per type and directory, not once per agent.
		if (!instructions.has(prompt)) instructions.set(prompt, workerPrompt(type, cwd, worktree));
		let call: CallRecord | undefined;
		await runtime.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
			await D.configure(tx, conversation.id, {
				model: { provider: resolved.model.provider, modelId: resolved.model.id },
				thinkingLevel: resolved.level,
				tools: type.tools.map((name) => docs.tools[name]),
				instructions: instructions.get(prompt),
				cwd,
			});
			call = { agentId, conversationId: conversation.id, worktree };
			Object.assign(await tx.doc(docs.Calls, runtime.conversationId, member(key), agentId), json(call));
			return undefined;
		}, context);
		return call!;
	};
	return {
		async stored(key) {
			const call = await read(key);
			if (!call) return undefined;
			if (!call.status) return "live";
			return { agentId: call.agentId, status: call.status, result: call.result ?? null, error: call.error, tokens: call.tokens ?? 0, toolUses: call.toolUses ?? 0, worktree: call.worktree };
		},
		async run(key, prompt, options, start) {
			const held = await acquire(key);
			try {
				if (!held || runtime.signal.aborted) throw new Error("Workflow aborted");
				// One agent starts per event-loop pass: sixteen starting at once would stall the lead.
				const mine = creating.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
				creating = mine;
				await mine;
				const call = await read(key) ?? await create(key, options);
				start(call.agentId);
				const conversation = (await engine.harness.conversation(call.conversationId, context))!;
				const settled = await (await conversation.submit({ type: "input", content: framePrompt(input.request, prompt), requestId: `workflow:${key}` }, context)).wait(context);
				if (runtime.signal.aborted) throw new Error("Workflow aborted");
				const transcript = await scan(conversation, context);
				const spent = (await runtime.snapshot(D.UsageDoc, call.conversationId, context))?.models ?? {};
				const answer = text(transcript.filter((entry) => entry.kind === "pi.assistant").at(-1)?.model?.[0]);
				const kept = call.worktree && existsSync(call.worktree.path) ? await finishAgentWorktree(call.worktree).catch(() => call.worktree) : undefined;
				const outcome: CallOutcome = {
					agentId: call.agentId,
					status: settled.status === "done" ? "done" : "failed",
					result: settled.status === "done" ? answer : null,
					tokens: Object.values(spent).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0),
					toolUses: transcript.filter((entry) => entry.kind === "pi.tool-result").length,
				};
				if (settled.status !== "done") outcome.error = failure(settled);
				if (kept) outcome.worktree = { path: kept.path, branch: kept.branch };
				await writeFile(join(input.dir, `agent-${call.agentId}.md`), `${transcriptLog(transcript)}\n\n${answer}\n`).catch(() => {});
				await runtime.commit(async (tx) => {
					Object.assign(await tx.doc(docs.Calls, runtime.conversationId, member(key), call.agentId), json(outcome));
					return undefined;
				}, context);
				return outcome;
			} finally {
				if (held) release();
			}
		},
	};
}

async function modelContext(input: WorkflowInput): Promise<ModelContext> {
	const registry = host.models!;
	const model = input.lead && registry.find(input.lead.provider, input.lead.id);
	return { config: await loadKitConfig(input.cwd, getAgentDir()), registry, lead: model && input.lead ? { model, level: input.lead.level } : undefined };
}
