// The only code that imports pi-durable. Agents run as durable conversations inside the lead's process: they survive
// /reload, pause when Pi exits and continue when their session reopens; their reports reach the lead exactly once.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, getAgentDir, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { guardBashCall } from "../../shared/guard.ts";
import { agentSummary, tasks, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";
import { addWorktree, agentWorktreeAt, finishAgentWorktree, git, type AgentWorktree } from "../../shared/worktree.ts";
import { PI_TOOLS, type PiToolName } from "../definitions.ts";
import { bunSqlite, lock, reap, unlock } from "./storage.ts";

type D = typeof Durable;
type Ctx = Parameters<Durable.Harness["close"]>[0];
type ConversationId = Durable.ConversationId;
// Documents hold strict JSON; these shapes are read and written through `json()`.
type OutboxDoc = { items: Durable.JsonObject[] };
type AgentsDoc = { agents: Record<string, Durable.JsonObject> };

/** One global throttle across every engine and Workflow: at most 16 agents run, the rest queue FIFO. */
export const AGENT_SLOTS = 16;
const SAFE_TOOLS = new Set<PiToolName>(["read", "grep", "find", "ls"]);
const FACTORIES = { read: createReadTool, grep: createGrepTool, find: createFindTool, ls: createLsTool, bash: createBashTool, edit: createEditTool, write: createWriteTool };
// ponytail: a structural chord Context that never cancels; import chord's BACKGROUND_CONTEXT if durable starts checking identity.
const CTX: Ctx = { abortSignal: undefined, value: () => undefined, toString: () => "pi-kit" };
const FailureDetail = Type.Object({ message: Type.String() });
const ObjectRoot = Type.Object({ type: Type.Literal("object"), properties: Type.Record(Type.String(), Type.Unknown()), required: Type.Optional(Type.Array(Type.String())) });
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;
const STRUCTURED_OUTPUT = "StructuredOutput";
const STRUCTURED_OUTPUT_CAP = 5;
const NUDGE = "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.";

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
	/** The run must end with a valid StructuredOutput call; its object, as JSON, is the result. */
	schema?: Durable.JsonObject;
}

/** `structuredError` is CC's error for a schema run that broke the StructuredOutput contract: `agent()` throws it. */
export type AgentOutcome = TaskNotification & { structuredError?: string };

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
	/** SendMessage text for a run its reporter has not placed yet; the reporter steers it in right after the prompt. */
	pending?: string[];
	schema?: Durable.JsonObject;
}
type OutboxItem = AgentOutcome & { silent?: boolean };
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
	/** Where a resumed run starts in its conversation, so its report counts only its own entries and tokens. */
	from?: { entries: number; tokens: number };
	structured?: boolean;
}

interface Kit {
	extension: Durable.Extension;
	tools: Record<PiToolName, Durable.ToolRegistration>;
	Outbox: Durable.ConversationDocToken<OutboxDoc>;
	Agents: Durable.ConversationDocToken<AgentsDoc>;
	Anchor: Durable.Task<null, { phase: "done" }, null, object>;
	Reporter: Durable.Task<ReporterInput, { phase: "run" }, null, object>;
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
interface Waiter { claimed: boolean; timedOut: boolean; resolve(n: AgentOutcome): void }
/** A reporter in this process. Messages steer its run only between the prompt's placement and `closing`; after that, SendMessage waits for the report and resumes. */
interface Live { placed: boolean; closing: boolean; early: string[]; inflight: Promise<unknown>[]; done: Promise<AgentOutcome | undefined> }
interface Host {
	/** The durable module stays loaded across /reload: a fresh copy would fail its own `instanceof` checks. */
	modules?: Promise<Modules>;
	engines: Map<string, Promise<Engine>>;
	models?: ModelRegistry;
	running: number;
	queue: { agentId: string; go(held: boolean): void }[];
	waiters: Map<string, Waiter>;
	live: Map<string, Live>;
}

const KEY = Symbol.for("pi-kit.agents");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores the host in it.
const slot = globalThis as typeof globalThis & { [KEY]?: Host };
const host: Host = slot[KEY] ??= { engines: new Map(), running: 0, queue: [], waiters: new Map(), live: new Map() };
host.live ??= new Map();

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
		installSchemas(D, engine.registry, engine.session, Object.values(agentRecords(await engine.harness.snapshot(engine.kit.Agents, engine.root.id, CTX))));
	}
}

/** On quit: close each harness, which aborts its tools and leaves work pending for the next start, then reap what survived and unlock. */
export async function closeAll(): Promise<void> {
	const engines = [...host.engines.values()];
	host.engines.clear();
	for (const pending of engines) {
		const engine = await pending.catch(() => undefined);
		if (!engine) continue;
		await engine.harness.close(CTX).catch(() => {});
		await reap(engine.dir);
		await unlock(join(engine.dir, "engine.lock"));
	}
}

export function queuedAhead(): boolean {
	return host.running >= AGENT_SLOTS;
}

/** Throws CC's error for a schema that `agent()` refuses before anything starts. */
export function checkSchema(schema: Durable.JsonObject): void {
	try {
		Compile(schema);
	} catch {
		throw new Error("agent({schema}) received an invalid JSON Schema");
	}
	const unusable = (why: string) => new Error(`agent({schema}) received an unusable JSON Schema — ${why}. The subagent was not started — fix the schema and call agent() again.`);
	if (!Value.Check(ObjectRoot, schema)) throw unusable("its root must be {type: 'object', properties: {...}}, with required a list of property names");
	const missing = (schema.required ?? []).filter((key) => !Object.hasOwn(schema.properties, key));
	if (missing.length) throw unusable(`required names ${missing.join(", ")}, which properties lacks`);
}

export async function launch(engine: Engine, spec: LaunchSpec): Promise<{ outputFile: string; done?: Promise<AgentOutcome> }> {
	if (spec.schema) checkSchema(spec.schema);
	const { D } = await host.modules!;
	const { agentId } = spec;
	const outputFile = join(engine.dir, "out", `${agentId}.md`);
	const startedAt = Date.now();
	const done = spec.foreground ? new Promise<AgentOutcome>((resolve) => host.waiters.set(agentId, { claimed: false, timedOut: false, resolve })) : undefined;
	const { kit, root } = engine;
	const structured = spec.schema && schemaExtension(D, engine.session, spec.schema);
	if (structured && !engine.registry.snapshot().extension(structured.name)) engine.registry.install(structured);
	await root.commit(async (tx) => {
		const anchor = await tx.createTask(kit.Anchor, null, BACKGROUND);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await D.configure(tx, child.id, {
			model: { provider: spec.model.provider, modelId: spec.model.id },
			thinkingLevel: spec.level,
			extensions: structured ? [kit.extension, structured] : [kit.extension],
			tools: [...spec.tools.map((name) => kit.tools[name]), ...(structured?.tools ?? [])],
			instructions: spec.instructions,
			cwd: spec.cwd,
		});
		const input: ReporterInput = { agentId, session: engine.session, conversationId: child.id, prompt: spec.prompt, requestId: `agent:${agentId}`, description: spec.description, toolUseId: spec.toolUseId, limits: spec.limits, startedAt, outputFile, worktree: spec.worktree, structured: !!structured };
		await tx.createTask(kit.Reporter, input, BACKGROUND);
		(await tx.doc(kit.Agents, root.id)).agents[agentId] = json({ name: spec.name, description: spec.description, conversationId: child.id, startedAt, status: "running", cwd: spec.cwd, writer: spec.writer, worktree: spec.worktree, schema: spec.schema });
	}, CTX);
	tasks.register({ id: agentId, kind: "agent", name: spec.name, description: spec.description, status: "running", ownerSession: engine.session, startedAt, stop: () => stop(engine, agentId) });
	return { outputFile, done };
}

/**
 * SendMessage: a running agent gets a steer at its next tool round, a queued one right after its prompt; a finished one is resumed
 * on its own conversation by a new reporter and notifies again. Nothing is submitted to an idle conversation from here, since that
 * would start a run outside its reporter and the throttle.
 */
export async function send(engine: Engine, agentId: string, message: string, toolUseId: string): Promise<"steered" | "resumed" | "refused"> {
	const record = await agentRecord(engine, agentId);
	if (record.stoppedBy === "user") return "refused";
	const conversation = (await engine.harness.conversation(record.conversationId, CTX))!;
	const live = host.live.get(agentId);
	if (live && !live.closing) {
		if (!live.placed) {
			live.early.push(message);
			return "steered";
		}
		const admitted = conversation.submit({ type: "input", content: message, requestId: `send:${randomUUID()}`, whenBusy: "steer" }, CTX);
		live.inflight.push(admitted.catch(() => undefined));
		await admitted;
		return "steered";
	}
	if (live) await live.done;
	const latest = await agentRecord(engine, agentId);
	const worktree = latest.status !== "running" && latest.worktree ? await reopenWorktree(latest.worktree) : undefined;
	const { D } = await host.modules!;
	const from = { entries: (await scan(conversation, CTX)).length, tokens: totalTokens(await engine.harness.snapshot(D.UsageDoc, record.conversationId, CTX)) };
	const outcome = await engine.root.commit(async (tx) => {
		const current = agentRecords(await tx.doc(engine.kit.Agents, engine.root.id))[agentId]!;
		// Its reporter has not started yet (just launched, or just reopened): it steers the message in after the prompt.
		if (current.status === "running") {
			(current.pending ??= []).push(message);
			return "steered" as const;
		}
		// A resumed run answers in text: the launch run's StructuredOutput call already settled the schema.
		if (current.schema) await D.configure(tx, record.conversationId, { extensions: [engine.kit.extension] });
		current.status = "running";
		current.stopped = false;
		if (worktree) current.worktree = worktree;
		const input: ReporterInput = { agentId, session: engine.session, conversationId: record.conversationId, prompt: message, requestId: `send:${randomUUID()}`, description: record.description, toolUseId, limits: {}, startedAt: Date.now(), outputFile: join(engine.dir, "out", `${agentId}.md`), worktree: current.worktree, from };
		await tx.createTask(engine.kit.Reporter, input, BACKGROUND);
		return "resumed" as const;
	}, CTX);
	if (outcome === "resumed") tasks.update(agentId, { status: "running" });
	return outcome;
}

async function agentRecord(engine: Engine, agentId: string): Promise<AgentRecord> {
	return agentRecords(await engine.harness.snapshot(engine.kit.Agents, engine.root.id, CTX))[agentId]!;
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

/** Aborts the agent and resolves with its report once its reporter in this process has committed it. */
export async function stop(engine: Engine, agentId: string, by?: "user"): Promise<TaskNotification | undefined> {
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
	return host.live.get(agentId)?.done;
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
	const records = agentRecords(await harness.snapshot(kit.Agents, root.id, CTX));
	installSchemas(D, registry, session, Object.values(records));
	for (const [id, record] of Object.entries(records)) {
		tasks.register({ id, kind: "agent", name: record.name, description: record.description, status: record.status, ownerSession: session, startedAt: record.startedAt, stop: () => stop(engine, id) });
	}
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
	const guard = D.hook(D.ToolTask, {
		beforeTool: async (call, api, context) => {
			if (call.name !== "bash") return undefined;
			const cwd = (await api.snapshot(D.AgentDoc, api.conversationId, context))?.cwd ?? process.cwd();
			const blocked = guardBashCall(String(call.arguments.command ?? ""), cwd, agentWorktreeAt(cwd, getAgentDir()) ?? project, project);
			return blocked ? { block: blocked.reason } : undefined;
		},
	});
	const extension = D.defineExtension({ name: "pi-kit", tasks: [Anchor, Reporter], tools: Object.values(tools), hooks: [guard] });
	return { extension, tools, Outbox, Agents, Anchor, Reporter };
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

/** One extension per distinct schema, shared by the agents of one `agent()` call site: the tool, and the hook that ends a run. */
function schemaExtension(D: D, session: string, schema: Durable.JsonObject): Durable.Extension {
	const tool = D.defineTool({
		name: STRUCTURED_OUTPUT,
		description: "Return your final answer by calling this tool exactly once; its parameters are the required shape. If a call is rejected, read the error and call it again with a corrected shape. After a successful call, end your turn.",
		// SAFETY: checkSchema compiled this JSON Schema; pi-ai validates calls against raw JSON Schema as it does TypeBox.
		parameters: schema as TSchema,
		replay: "safe",
		// SAFETY: pi-ai validated `args` against an object schema, so they are a JSON object.
		execute: async (args) => ({ content: [{ type: "text", text: "Structured output provided successfully" }], details: args as Durable.JsonObject, control: { terminate: true } }),
	});
	// `terminate` ends a run only when every call of the batch asks for it; a valid call batched with other tools, or the
	// cap's last failed call, ends it here: the request waits until the abort reaches this generation, so it is never sent.
	const end = D.hook(D.GenerationTask, {
		beforeRequest: async ({ messages }, api, context) => {
			const calls = structuredCalls(messages);
			const signal = context.abortSignal;
			if (signal && (calls.some((call) => !call.isError) || calls.length >= STRUCTURED_OUTPUT_CAP)) {
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
					abortRun(session, api.conversationId).catch(() => resolve());
				});
			}
			return undefined;
		},
	});
	return D.defineExtension({ name: `pi-kit.schema.${createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16)}`, tools: [tool], hooks: [end] });
}

/** Running schema agents need their StructuredOutput again after a reopen or /reload. */
function installSchemas(D: D, registry: Durable.Registry, session: string, records: AgentRecord[]): void {
	const schemas = new Map(records.flatMap((record) => (record.schema && record.status === "running" ? [[JSON.stringify(record.schema), record.schema] as const] : [])));
	for (const schema of schemas.values()) registry.install(schemaExtension(D, session, schema));
}

async function abortRun(session: string, conversationId: ConversationId): Promise<void> {
	const engine = await host.engines.get(session);
	await (await engine?.harness.conversation(conversationId, CTX))?.abort(CTX);
}

const structuredCalls = (messages: readonly Message[]) => messages.flatMap((message) => (message.role === "toolResult" && message.toolName === STRUCTURED_OUTPUT ? [message] : []));

/** `output` is the first valid call's object, as pi-ai validated it; `failed` holds each rejected call's error text. */
function structuredResult(transcript: readonly Durable.EntryRecord[]) {
	const calls = structuredCalls(transcript.flatMap((entry) => entry.model ?? []));
	const failed = calls.filter((call) => call.isError).map((call) => call.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"));
	return { output: calls.find((call) => !call.isError)?.details, failed };
}

/** CC's errors that make `agent()` throw: the failed-call cap, or no call even after the nudge. */
function structuredFailure(result: { failed: string[] }, settled: Durable.SettledSubmissionRecord | undefined): string | undefined {
	if (result.failed.length >= STRUCTURED_OUTPUT_CAP) return `agent({schema}): StructuredOutput retry cap (${STRUCTURED_OUTPUT_CAP}) exceeded — ${result.failed.length} failed calls with no valid output — last StructuredOutput error: ${result.failed.at(-1)!.slice(0, 600)}`;
	if (settled?.status === "done") return "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)";
	return undefined;
}

async function report(D: D, docs: Pick<Kit, "Outbox" | "Agents">, input: ReporterInput, runtime: Durable.TaskRuntime<ReporterInput, { phase: "run" }, null, object>, context: Ctx): Promise<void> {
	const engine = (await host.engines.get(input.session))!;
	const conversation = (await engine.harness.conversation(input.conversationId, context))!;
	const record = async () => agentRecords(await runtime.snapshot(docs.Agents, runtime.conversationId, context))[input.agentId];
	let finished: (n: TaskNotification | undefined) => void = () => {};
	const live: Live = { placed: false, closing: false, early: [], inflight: [], done: new Promise((resolve) => { finished = resolve; }) };
	host.live.set(input.agentId, live);
	let n: OutboxItem | undefined;
	let claimed = false;
	try {
		let settled: Durable.SettledSubmissionRecord | undefined;
		let limited: string | undefined;
		const held = await acquire(input.agentId);
		try {
			if (held && !(await record())?.stopped) {
				const submission = await conversation.submit({ type: "input", content: input.prompt, requestId: input.requestId }, context);
				live.placed = true;
				const pending = live.early.splice(0);
				if ((await record())?.pending) pending.push(...await engine.root.commit(async (tx) => {
					const current = agentRecords(await tx.doc(docs.Agents, engine.root.id))[input.agentId];
					const messages = current?.pending ?? [];
					if (current) delete current.pending;
					return messages;
				}, context));
				for (const message of pending) live.inflight.push(conversation.submit({ type: "input", content: message, requestId: `send:${randomUUID()}`, whenBusy: "steer" }, context));
				const turns = input.limits.maxTurns ? (await scan(conversation, context)).slice(input.from?.entries ?? 0).filter((entry) => entry.kind === "pi.assistant").length : 0;
				const unwatch = watchLimits(D, engine, input, turns, (limit) => {
					limited = limit;
					void conversation.abort(CTX);
				});
				try {
					const first = await submission.wait(context);
					settled = input.structured && first.status === "done" && !structuredResult((await scan(conversation, context)).slice(input.from?.entries ?? 0)).output
						? await (await conversation.submit({ type: "input", content: NUDGE, requestId: `${input.requestId}:nudge` }, context)).wait(context)
						: first;
				} finally {
					unwatch();
				}
			}
			// A steer that missed the last tool round runs on after the answer, in this slot; the report carries the last answer.
			await conversation.waitForIdle(context);
			live.closing = true;
			await Promise.all(live.inflight);
			await conversation.waitForIdle(context);
		} finally {
			if (held) release();
		}
		const transcript = await scan(conversation, context);
		const run = transcript.slice(input.from?.entries ?? 0);
		const tokens = totalTokens(await runtime.snapshot(D.UsageDoc, input.conversationId, context)) - (input.from?.tokens ?? 0);
		const lastText = run.filter((entry) => entry.kind === "pi.assistant").map((entry) => text(entry.model?.[0])).filter(Boolean).at(-1) ?? "";
		const so = input.structured ? structuredResult(run) : undefined;
		const structuredError = so && !so.output ? structuredFailure(so, settled) : undefined;
		if (settled?.status === "done" || so?.output) limited = undefined;
		const output = so ? (so.output ? JSON.stringify(so.output) : "") : settled?.status === "done" || limited ? lastText : "";
		const status = so?.output || settled?.status === "done" && !structuredError ? "completed"
			: structuredError ? "failed"
			: limited ? (output ? "completed" : "failed")
			: settled === undefined || settled.status === "unanswered" && settled.reason === "aborted" ? "killed" : "failed";
		const kept = input.worktree && existsSync(input.worktree.path) ? await finishAgentWorktree(input.worktree).catch(() => input.worktree) : undefined;
		const outcome: OutboxItem = {
			notificationId: `${input.agentId}:${String(runtime.taskId)}`,
			taskId: input.agentId,
			kind: "agent",
			ownerSession: input.session,
			toolUseId: input.toolUseId,
			outputFile: input.outputFile,
			status,
			summary: limited
				? `Agent "${input.description}" stopped at its ${limited} limit (partial result)`
				: agentSummary(input.description, status, { error: structuredError ?? failure(settled), byUser: (await record())?.stoppedBy === "user" }),
			result: output,
			usage: {
				subagentTokens: tokens,
				toolUses: run.filter((entry) => entry.kind === "pi.tool-result").length,
				durationMs: Date.now() - input.startedAt,
			},
		};
		if (limited) outcome.limited = limited;
		if (structuredError) outcome.structuredError = structuredError;
		if (kept) outcome.worktree = { path: kept.path, branch: kept.branch };
		await writeFile(input.outputFile, `${transcriptLog(transcript)}\n\n${output}\n`).catch(() => {});
		const waiter = host.waiters.get(input.agentId);
		await runtime.commit(async (tx) => {
			const current = agentRecords(await tx.doc(docs.Agents, runtime.conversationId))[input.agentId];
			if (current) {
				current.status = outcome.status;
				// Messages for a run that never started wait for the next resume.
				if (live.early.length) current.pending = [...current.pending ?? [], ...live.early];
			}
			if (waiter && !waiter.timedOut) waiter.claimed = true;
			claimed = Boolean(waiter?.claimed);
			(await tx.doc(docs.Outbox, runtime.conversationId)).items.push(json({ ...outcome, silent: claimed || undefined }));
			return { status: "terminal", outcome: { status: "completed", result: null } };
		}, context);
		tasks.update(input.agentId, { status: outcome.status });
		n = outcome;
	} finally {
		if (host.live.get(input.agentId) === live) host.live.delete(input.agentId);
		finished(n);
	}
	if (!claimed) return tasks.notify(n);
	host.waiters.get(input.agentId)?.resolve(n);
	host.waiters.delete(input.agentId);
}

/** `maxTurns`, `maxTokens` and `timeout` exist only when the user asked; the first one reached stops the agent. */
/** `turns` already taken counts toward `maxTurns`, so a run reopened after Pi exits keeps its count. */
function watchLimits(D: D, engine: Engine, input: ReporterInput, turns: number, hit: (limit: string) => void): () => void {
	const { maxTurns, maxTokens, timeout } = input.limits;
	if (!maxTurns && !maxTokens && !timeout) return () => {};
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
				if (totalTokens(usage) >= maxTokens) fire(`${maxTokens}-token`);
			});
		}
	});
	return () => {
		clearTimeout(timer);
		unsubscribe();
	};
}

function totalTokens(usage: { models?: Record<string, { totalTokens?: number }> } | undefined): number {
	return Object.values(usage?.models ?? {}).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0);
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
function json(value: AgentRecord | OutboxItem): Durable.JsonObject {
	return JSON.parse(JSON.stringify(value));
}

// Documents hold JsonObject, which no interface with optional fields can be asserted from directly.
// SAFETY: the kit writes the Outbox only through json() of an OutboxItem.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const outboxItems = (doc: OutboxDoc | undefined) => (doc?.items ?? []) as unknown as OutboxItem[];
// SAFETY: the kit writes Agents only through json() of an AgentRecord.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const agentRecords = (doc: AgentsDoc | undefined) => (doc?.agents ?? {}) as unknown as Record<string, AgentRecord>;
