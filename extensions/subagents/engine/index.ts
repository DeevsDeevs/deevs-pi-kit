// The only code that imports pi-durable. Agents run as durable conversations inside the lead's process: they survive
// /reload, pause when Pi exits and continue when their session reopens; their reports reach the lead exactly once.
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel, ToolResultMessage } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, getAgentDir, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { guardBashCall } from "../../shared/guard.ts";
import { tasks, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";
import type { PiToolName } from "../definitions.ts";
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

export interface Limits { maxTurns?: number; maxTokens?: number; timeout?: number }

export interface LaunchSpec {
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
}
type OutboxItem = TaskNotification & { silent?: boolean };
interface ReporterInput {
	agentId: string;
	session: string;
	conversationId: ConversationId;
	prompt: string;
	description: string;
	toolUseId: string;
	limits: Limits;
	startedAt: number;
	outputFile: string;
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
}

const KEY = Symbol.for("pi-kit.agents");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores the host in it.
const slot = globalThis as typeof globalThis & { [KEY]?: Host };
const host: Host = slot[KEY] ??= { engines: new Map(), running: 0, queue: [], waiters: new Map() };

tasks.addSource({
	name: "agents",
	async pending(session) {
		const engine = await host.engines.get(session)?.catch(() => undefined);
		if (!engine) return [];
		const items = (await engine.harness.snapshot(engine.kit.Outbox, engine.root.id, CTX))?.items ?? [];
		return (items as unknown as OutboxItem[]).filter((item) => !item.silent);
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

/** At session start: resume a session's paused agents only when it has a store; other sessions' stores stay untouched. */
export async function resumeSession(ctx: ExtensionContext): Promise<void> {
	host.models = ctx.modelRegistry;
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
		engine.kit = buildKit(D, engine.dir);
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

export async function launch(engine: Engine, spec: LaunchSpec): Promise<{ agentId: string; outputFile: string; done?: Promise<TaskNotification> }> {
	const { D } = await host.modules!;
	const agentId = `a${randomBytes(8).toString("hex")}`;
	const outputFile = join(engine.dir, "out", `${agentId}.md`);
	const startedAt = Date.now();
	const done = spec.foreground ? new Promise<TaskNotification>((resolve) => host.waiters.set(agentId, { claimed: false, timedOut: false, resolve })) : undefined;
	const { kit, root } = engine;
	await root.commit(async (tx) => {
		const background = { ownership: { kind: "conversation" }, background: true } as const;
		const anchor = await tx.createTask(kit.Anchor, null, background);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await D.configure(tx, child.id, {
			model: { provider: spec.model.provider, modelId: spec.model.id },
			...(spec.level ? { thinkingLevel: spec.level } : {}),
			tools: spec.tools.map((name) => kit.tools[name]),
			instructions: spec.instructions,
			cwd: spec.cwd,
		});
		const input: ReporterInput = { agentId, session: engine.session, conversationId: child.id, prompt: spec.prompt, description: spec.description, toolUseId: spec.toolUseId, limits: spec.limits, startedAt, outputFile };
		await tx.createTask(kit.Reporter, input, background);
		(await tx.doc(kit.Agents, root.id)).agents[agentId] = json<AgentRecord>({ name: spec.name, description: spec.description, conversationId: child.id, startedAt, status: "running", cwd: spec.cwd, writer: spec.writer });
	}, CTX);
	tasks.register({ id: agentId, kind: "agent", name: spec.name, description: spec.description, status: "running", ownerSession: engine.session, startedAt, stop: () => stop(engine, agentId) });
	return { agentId, outputFile, done };
}

/** Running writers in `cwd`: another one there means parallel edits to the same tree. */
export async function writersIn(engine: Engine, cwd: string): Promise<number> {
	const agents = (await engine.harness.snapshot(engine.kit.Agents, engine.root.id, CTX))?.agents ?? {};
	return Object.values(agents as unknown as Record<string, AgentRecord>).filter((record) => record.status === "running" && record.writer && record.cwd === cwd).length;
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

export async function stop(engine: Engine, agentId: string): Promise<void> {
	let conversationId: ConversationId | undefined;
	await engine.root.commit(async (tx) => {
		const record = (await tx.doc(engine.kit.Agents, engine.root.id)).agents[agentId] as unknown as AgentRecord | undefined;
		if (!record) return;
		record.stopped = true;
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
	const kit = buildKit(D, dir);
	registry.install(kit.extension);
	const harness = await D.Harness.open(await openStorage(join(dir, "engine.sqlite")), {
		models: modelsAdapter(),
		registry,
		settings: { progress: { partialIntervalMs: 500, outputIntervalMs: 500 } },
		onReport: () => {},
	}, CTX);
	const root = await harness.root(CTX);
	const engine: Engine = { session, dir, harness, root, registry, kit };
	const agents = (await harness.snapshot(kit.Agents, root.id, CTX))?.agents ?? {};
	for (const [id, record] of Object.entries(agents as unknown as Record<string, AgentRecord>)) {
		tasks.register({ id, kind: "agent", name: record.name, description: record.description, status: record.status, ownerSession: session, startedAt: record.startedAt, stop: () => stop(engine, id) });
	}
	harness.resume();
	const items = (await harness.snapshot(kit.Outbox, root.id, CTX))?.items ?? [];
	for (const item of items as unknown as OutboxItem[]) if (!item.silent) await tasks.notify(item);
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
		return { D, openStorage: (file) => SqliteStorage.open(bunSqlite(Database, file) as unknown as Parameters<typeof SqliteStorage.open>[0]) };
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
	return {
		getModel: (provider: string, id: string) => registry().find(provider, id),
		streamSimple: (...args: Parameters<ModelRegistry["streamSimple"]>) => registry().streamSimple(...args),
		completeSimple: (...args: Parameters<ModelRegistry["streamSimple"]>) => registry().streamSimple(...args).result(),
		fetchDeferred: () => { throw new Error("Deferred model calls are not available to kit agents."); },
		cancelDeferred: async () => {},
	} as unknown as Durable.HarnessOptions["models"];
}

function buildKit(D: D, owner: string): Kit {
	const Outbox = D.defineDoc<OutboxDoc>({ kind: "pi-kit.outbox", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: [] }) });
	const Agents = D.defineDoc<AgentsDoc>({ kind: "pi-kit.agents", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ agents: {} }) });
	const terminal = <S extends { phase: string }>(status: "completed" | "aborted") => (_task: unknown, runtime: Durable.TaskRuntime<unknown, S, null, object>, context: Ctx) =>
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
	const tools = Object.fromEntries(Object.keys(FACTORIES).map((name) => [name, piTool(D, name as PiToolName, owner)])) as Record<PiToolName, Durable.ToolRegistration>;
	const guard = D.hook(D.ToolTask, {
		beforeTool: async (call, api, context) => {
			if (call.name !== "bash") return undefined;
			const cwd = (await api.snapshot(D.AgentDoc, api.conversationId, context))?.cwd ?? process.cwd();
			const blocked = guardBashCall(String(call.arguments.command ?? ""), cwd);
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
	const shape = make(process.cwd());
	return D.defineTool({
		name,
		description: shape.description,
		parameters: shape.parameters,
		replay: SAFE_TOOLS.has(name) ? "safe" : "unsafe",
		...(shape.prepareArguments ? { prepareArguments: shape.prepareArguments } : {}),
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
	let settled: Durable.SettledSubmissionRecord | undefined;
	let limited: string | undefined;
	const held = await acquire(input.agentId);
	try {
		const stopped = ((await runtime.snapshot(docs.Agents, runtime.conversationId, context))?.agents[input.agentId] as AgentRecord | undefined)?.stopped;
		if (held && !stopped) {
			const submission = await conversation.submit({ type: "input", content: input.prompt, requestId: `agent:${input.agentId}` }, context);
			const unwatch = watchLimits(D, engine, input, (limit) => {
				limited = limit;
				void conversation.abort(CTX);
			});
			settled = await submission.wait(context).finally(unwatch);
		}
	} finally {
		if (held) release();
	}
	const transcript = await scan(conversation, context);
	const usage = (await runtime.snapshot(D.UsageDoc, input.conversationId, context))?.models ?? {};
	const answer = settled?.status === "done" ? transcript.find((entry) => entry.id === settled.answer) : undefined;
	const lastText = text(transcript.filter((entry) => entry.kind === "pi.assistant").at(-1)?.model?.[0]);
	const output = answer ? text(answer.model?.[0]) : limited ? lastText : "";
	const quote = `Agent "${input.description}"`;
	const n: OutboxItem = {
		notificationId: `${input.agentId}:${String(runtime.taskId)}`,
		taskId: input.agentId,
		kind: "agent",
		ownerSession: input.session,
		toolUseId: input.toolUseId,
		outputFile: input.outputFile,
		...(answer
			? { status: "completed", summary: `${quote} finished` }
			: limited
				? { status: output ? "completed" : "failed", summary: `${quote} stopped at its ${limited} limit (partial result)`, limited }
				: settled === undefined || settled.status === "unanswered" && settled.reason === "aborted"
					? { status: "killed", summary: `${quote} was stopped` }
					: { status: "failed", summary: `${quote} failed: ${failure(settled)}` }),
		result: output,
		usage: {
			subagentTokens: Object.values(usage).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0),
			toolUses: transcript.filter((entry) => entry.kind === "pi.tool-result").length,
			durationMs: Date.now() - input.startedAt,
		},
	};
	await writeFile(input.outputFile, `${transcriptLog(transcript)}\n\n${output}\n`).catch(() => {});
	const waiter = host.waiters.get(input.agentId);
	await runtime.commit(async (tx) => {
		const record = (await tx.doc(docs.Agents, runtime.conversationId)).agents[input.agentId];
		if (record) record.status = n.status;
		if (waiter && !waiter.timedOut) waiter.claimed = true;
		(await tx.doc(docs.Outbox, runtime.conversationId)).items.push(json<OutboxItem>({ ...n, silent: waiter?.claimed || undefined }));
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
	return entries;
}

function text(message: Message | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return (message as AssistantMessage).content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function transcriptLog(entries: readonly Durable.EntryRecord[]): string {
	return entries.flatMap((entry) => (entry.model ?? []).flatMap((message) => {
		if (message.role === "assistant") return message.content.flatMap((block) => block.type === "toolCall" ? [`→ ${block.name} ${JSON.stringify(block.arguments).slice(0, 300)}`] : block.type === "text" && block.text ? [block.text] : []);
		if (message.role === "toolResult") return [`← ${(message as ToolResultMessage).isError ? "error " : ""}${(message as ToolResultMessage).content.flatMap((block) => (block.type === "text" ? [block.text.slice(0, 300)] : [])).join("")}`];
		return [];
	})).join("\n");
}

function failure(settled: Durable.SettledSubmissionRecord | undefined): string {
	if (settled?.status !== "unanswered") return "no answer";
	const detail = settled.detail as { message?: unknown } | undefined;
	return typeof detail?.message === "string" ? detail.message : settled.reason;
}

/** Documents hold strict JSON: optional fields that are `undefined` are dropped. */
function json<T>(value: T): Durable.JsonObject {
	return JSON.parse(JSON.stringify(value)) as Durable.JsonObject;
}
