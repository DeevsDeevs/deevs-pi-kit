// The only code that imports pi-durable. Agents run as durable conversations inside the lead's process: they survive
// /reload, pause when Pi exits and continue when their session reopens; their reports reach the lead exactly once.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupSessionResources, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, getAgentDir, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { guardBashCall } from "../../shared/guard.ts";
import { trySignalGroup } from "../../shared/process-group.ts";
import { agentSummary, recent, sessionAcks, tasks, type RosterEntry, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";
import { addWorktree, agentWorktreeAt, finishAgentWorktree, git, type AgentWorktree } from "../../shared/worktree.ts";
import { PI_TOOLS, type PiToolName } from "../definitions.ts";
import { cliAnswer, CONTINUE, newProgress as newCliProgress, spawnWorker, type CliExit, type CliWorker } from "./cli.ts";
import { backgroundTasks, decoded, firstLook, json, outboxItems, post, pruneOutbox, unsent, type BackgroundDoc, type BackgroundRecord, type JobInput, type MonitorInput, type OutboxDoc, type OutboxItem } from "./background.ts";
import { acquire, BACKGROUND, CTX, failure, host, release, scan, text, totalTokens, transcriptLog, type AgentsDoc, type ConversationId, type Ctx, type D, type Engine, type Kit, type Live, type Modules, type WorkflowsDoc } from "./host.ts";
import { bunSqlite, lock, prune, reap, SETTLED, unlock } from "./storage.ts";
import { abortWorkflowTask, installSchemas, registerWorkflow, runWorkflowTask, workflowRecords, type WorkflowInput } from "./workflow.ts";

export { cliWorker, placeAgent, queuedAhead, userRequests } from "./host.ts";
export { checkSchema, launchWorkflow, workflowProgress } from "./workflow.ts";

const SAFE_TOOLS = new Set<PiToolName>(["read", "grep", "find", "ls"]);
const FACTORIES = { read: createReadTool, grep: createGrepTool, find: createFindTool, ls: createLsTool, bash: createBashTool, edit: createEditTool, write: createWriteTool };

export interface Limits { maxTurns?: number; maxTokens?: number; timeout?: number }

interface LaunchBase {
	agentId: string;
	description: string;
	prompt: string;
	name?: string;
	cwd: string;
	writer: boolean;
	toolUseId: string;
	foreground: boolean;
	worktree?: AgentWorktree;
}
/** A Pi model runs in-process on a durable conversation; a `claude:` or `codex:` model runs as that CLI. */
export type LaunchSpec = LaunchBase & ({
	cli?: undefined;
	model: Model<Api>;
	level?: ModelThinkingLevel;
	tools: PiToolName[];
	instructions: string;
	limits: Limits;
} | { cli: CliWorker });

interface AgentRecord {
	name?: string;
	description: string;
	/** A Pi agent's conversation; a CLI worker has `cli` and the CLI's own session instead. */
	conversationId?: ConversationId;
	cli?: CliWorker;
	sessionId?: string;
	/** SendMessages to a running CLI worker, delivered by resume when its run ends. */
	queued?: string[];
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
}
export interface RunInput {
	agentId: string;
	session: string;
	prompt: string;
	description: string;
	toolUseId: string;
	startedAt: number;
	outputFile: string;
	worktree?: AgentWorktree;
}
export interface ReporterInput extends RunInput {
	conversationId: ConversationId;
	requestId: string;
	limits: Limits;
	/** Where a resumed run starts in its conversation, so its report counts only its own entries and tokens. */
	from?: { entries: number; tokens: number };
}
export interface CliInput extends RunInput {
	worker: CliWorker;
}

tasks.addSource({
	name: "agents",
	async pending(session, answered) {
		const engine = await host.engines.get(session)?.catch(() => undefined);
		if (!engine) return [];
		return outboxItems(await engine.harness.snapshot(engine.kit.Outbox, engine.root.id, CTX)).filter(unsent(answered));
	},
});

/** Opens (once) the engine of the context's session; its storage lives under the agent dir, per project and session. */
export function ensureEngine(ctx: ExtensionContext): Promise<Engine> {
	host.models = ctx.modelRegistry;
	const session = ctx.sessionManager.getSessionId();
	let engine = host.engines.get(session);
	if (!engine) {
		engine = open(session, ctx.cwd, sessionAcks(ctx));
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
	host.closing = false;
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
		installSchemas(D, engine.registry, engine.session, workflowRecords(await engine.harness.snapshot(engine.kit.Workflows, engine.root.id, CTX)));
	}
}

/** On quit: close each harness, which aborts its tools and leaves work pending for the next start, then reap what survived and unlock. The roster has let go of the quitting session by then, so its acks come from `ctx`. */
export async function closeAll(ctx?: ExtensionContext): Promise<void> {
	const onScreen = ctx && { session: ctx.sessionManager.getSessionId(), acks: sessionAcks(ctx) };
	host.closing = true;
	const engines = [...host.engines.values()];
	host.engines.clear();
	for (const pending of engines) {
		const engine = await pending.catch(() => undefined);
		if (!engine) continue;
		clearInterval(engine.heartbeat);
		const idle = await settled(engine, onScreen?.session === engine.session ? onScreen.acks : undefined).catch(() => false);
		await engine.harness.close(CTX).catch(() => {});
		await reap(`PI_KIT_OWNER=${engine.dir}`);
		if (idle) await writeFile(join(engine.dir, SETTLED), "").catch(() => {});
		await unlock(join(engine.dir, "engine.lock"));
	}
	// Pi releases only the lead's provider session; an agent's, such as its cached openai-codex WebSocket, would hold the event loop open for its 5 min idle TTL, so print mode would not exit.
	cleanupSessionResources();
	host.closing = false;
}

/** Nothing running or paused, and every report in the session file: only such a store may be pruned. */
async function settled({ harness, kit, root, session }: Engine, acks: ReturnType<typeof sessionAcks> | undefined): Promise<boolean> {
	await root.commit(async (tx) => pruneOutbox(await tx.doc(kit.Outbox, root.id), session, acks), CTX);
	const records = [agentRecords(await harness.snapshot(kit.Agents, root.id, CTX)), workflowRecords(await harness.snapshot(kit.Workflows, root.id, CTX)), backgroundRecords(await harness.snapshot(kit.Background, root.id, CTX))].flatMap(Object.values);
	return records.every((record) => record.status !== "running") && outboxItems(await harness.snapshot(kit.Outbox, root.id, CTX)).length === 0;
}

export async function launch(engine: Engine, spec: LaunchSpec): Promise<{ outputFile: string; done?: Promise<TaskNotification> }> {
	const { D } = await host.modules!;
	const { agentId } = spec;
	const outputFile = agentOutput(engine, agentId);
	const startedAt = Date.now();
	const done = spec.foreground ? new Promise<TaskNotification>((resolve) => host.waiters.set(agentId, { claimed: false, timedOut: false, resolve })) : undefined;
	const { kit, root } = engine;
	const record: AgentRecord = { name: spec.name, description: spec.description, startedAt, status: "running", cwd: spec.cwd, writer: spec.writer, worktree: spec.worktree };
	await root.commit(async (tx) => {
		if (spec.cli) {
			const cliRecord: AgentRecord = { ...record, cli: spec.cli };
			await tx.createTask(kit.CliTask, { ...cliInput({ session: engine.session, outputFile }, agentId, cliRecord, spec.prompt, spec.toolUseId), startedAt }, BACKGROUND);
			(await tx.doc(kit.Agents, root.id)).agents[agentId] = json(cliRecord);
			return;
		}
		const anchor = await tx.createTask(kit.Anchor, null, BACKGROUND);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
		await D.configure(tx, child.id, {
			model: { provider: spec.model.provider, modelId: spec.model.id },
			thinkingLevel: spec.level,
			extensions: [kit.extension],
			tools: spec.tools.map((name) => kit.tools[name]),
			instructions: spec.instructions,
			cwd: spec.cwd,
		});
		const input: ReporterInput = { agentId, session: engine.session, conversationId: child.id, prompt: spec.prompt, requestId: `agent:${agentId}`, description: spec.description, toolUseId: spec.toolUseId, limits: spec.limits, startedAt, outputFile, worktree: spec.worktree };
		await tx.createTask(kit.Reporter, input, BACKGROUND);
		(await tx.doc(kit.Agents, root.id)).agents[agentId] = json({ ...record, conversationId: child.id });
	}, CTX);
	registerAgent(engine, agentId, record);
	return { outputFile, done };
}

/** An agent of the session's open store that a reopen left off the roster (it lists only the 20 finished most recently started), by id or newest name. */
export async function storedAgent(ctx: ExtensionContext, idOrName: string): Promise<RosterEntry | undefined> {
	const engine = await host.engines.get(ctx.sessionManager.getSessionId())?.catch(() => undefined);
	const records = engine ? Object.entries(agentRecords(await engine.harness.snapshot(engine.kit.Agents, engine.root.id, CTX))) : [];
	const found = records.find(([id]) => id === idOrName) ?? records.filter(([, record]) => record.name === idOrName).sort(([, a], [, b]) => b.startedAt - a.startedAt)[0];
	if (!engine || !found) return undefined;
	registerAgent(engine, ...found);
	return tasks.find(found[0], engine.session, "agent");
}

function registerAgent(engine: Engine, id: string, record: AgentRecord): void {
	tasks.register({ id, kind: "agent", name: record.name, description: record.description, status: record.status, ownerSession: engine.session, startedAt: record.startedAt, stop: () => stop(engine, id) });
}

/**
 * SendMessage: a running agent gets a steer at its next tool round, a queued one right after its prompt, a running CLI worker
 * gets it by resume once its run ends; a finished one is resumed on its own conversation by a new reporter and notifies again.
 * Nothing is submitted to an idle conversation from here, since that would start a run outside its reporter and the throttle.
 */
export async function send(engine: Engine, agentId: string, message: string, toolUseId: string): Promise<"steered" | "queued" | "resumed" | "refused"> {
	const record = await agentRecord(engine, agentId);
	if (record.stoppedBy === "user") return "refused";
	if (!record.conversationId) return sendCli(engine, agentId, message, toolUseId);
	const conversationId = record.conversationId;
	const conversation = (await engine.harness.conversation(conversationId, CTX))!;
	const live = host.live.get(agentId);
	if (live?.placed && !live.closing) {
		const admitted = conversation.submit({ type: "input", content: message, requestId: `send:${randomUUID()}`, whenBusy: "steer" }, CTX);
		live.inflight.push(admitted.catch(() => undefined));
		await admitted;
		return "steered";
	}
	if (live?.closing) await live.done;
	const latest = await agentRecord(engine, agentId);
	const worktree = latest.status !== "running" && latest.worktree ? await reopenWorktree(latest.worktree) : undefined;
	const { D } = await host.modules!;
	const from = { entries: (await scan(conversation, CTX)).length, tokens: totalTokens(await engine.harness.snapshot(D.UsageDoc, conversationId, CTX)) };
	const outcome = await engine.root.commit(async (tx) => {
		const current = agentRecords(await tx.doc(engine.kit.Agents, engine.root.id))[agentId]!;
		if (current.stoppedBy === "user") return "refused" as const;
		// Its reporter has not placed the prompt yet (queued, just launched or reopened): it steers `pending` in right after.
		if (current.status === "running") {
			if (host.live.get(agentId)?.placed) return "placed" as const;
			current.pending = [...current.pending ?? [], message];
			return "steered" as const;
		}
		current.status = "running";
		current.stopped = false;
		if (worktree) current.worktree = worktree;
		const input: ReporterInput = { agentId, session: engine.session, conversationId, prompt: message, requestId: `send:${randomUUID()}`, description: record.description, toolUseId, limits: {}, startedAt: Date.now(), outputFile: agentOutput(engine, agentId), worktree: current.worktree, from };
		await tx.createTask(engine.kit.Reporter, input, BACKGROUND);
		return "resumed" as const;
	}, CTX);
	if (outcome === "placed") return send(engine, agentId, message, toolUseId);
	if (outcome === "resumed") tasks.update(agentId, { status: "running" });
	return outcome;
}

async function sendCli(engine: Engine, agentId: string, message: string, toolUseId: string): Promise<"queued" | "resumed"> {
	const outcome = await engine.root.commit(async (tx) => {
		const current = agentRecords(await tx.doc(engine.kit.Agents, engine.root.id))[agentId]!;
		if (current.status === "running") {
			current.queued = [...current.queued ?? [], message];
			return "queued" as const;
		}
		current.status = "running";
		current.stopped = false;
		await tx.createTask(engine.kit.CliTask, cliInput({ session: engine.session, outputFile: agentOutput(engine, agentId) }, agentId, current, message, toolUseId), BACKGROUND);
		return "resumed" as const;
	}, CTX);
	if (outcome === "resumed") tasks.update(agentId, { status: "running" });
	return outcome;
}

const agentOutput = (engine: Engine, agentId: string): string => join(engine.dir, "out", `${agentId}.md`);

function cliInput(at: Pick<RunInput, "session" | "outputFile">, agentId: string, record: AgentRecord, prompt: string, toolUseId: string): CliInput {
	return { agentId, session: at.session, prompt, description: record.description, toolUseId, startedAt: Date.now(), outputFile: at.outputFile, worktree: record.worktree, worker: record.cli! };
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

/** The end of a Pi agent's transcript, its newest 20 entries, for /agents <id>; undefined for a Claude Code or Codex worker, which keeps its own. */
export async function transcriptTail(engine: Engine, agentId: string): Promise<string | undefined> {
	const { conversationId } = await agentRecord(engine, agentId);
	const conversation = conversationId === undefined ? undefined : await engine.harness.conversation(conversationId, CTX);
	return conversation ? transcriptLog([...(await conversation.entries({}, 20, undefined, CTX)).items].reverse()) : undefined;
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
	const worker = host.workers.get(agentId)?.pid;
	if (worker) trySignalGroup(worker, "SIGKILL");
	if (conversationId !== undefined) await (await engine.harness.conversation(conversationId, CTX))?.abort(CTX);
	return host.live.get(agentId)?.done;
}

type Launch<T> = Omit<T, "session" | "owner" | "outputFile" | "startedAt">;

/** `job_start`: the command runs in its own process group; its exit code and report are committed together. Returns the log. */
export const startJob = (engine: Engine, input: Launch<JobInput>): Promise<string> => startBackground(engine, "job", input);

/** Monitor: a path, url or cron watch looks first, so it reports what changes from now on. Returns the log and that look. */
/** The first look comes before `engine()`, so a bad cron, path or URL opens no store. */
export async function startMonitor(engine: () => Promise<Engine>, input: Omit<Launch<MonitorInput>, "seen">, signal: AbortSignal | undefined): Promise<{ outputFile: string; baseline?: string }> {
	const look = await firstLook(input.source, input.target, signal ?? new AbortController().signal);
	return { outputFile: await startBackground(await engine(), "monitor", { ...input, seen: look.seen }), baseline: look.baseline };
}

async function startBackground(engine: Engine, kind: "job" | "monitor", launch: Launch<JobInput> | Launch<MonitorInput>): Promise<string> {
	const { kit, root } = engine;
	const input = { ...launch, session: engine.session, owner: engine.dir, outputFile: join(engine.dir, "out", `${launch.id}.log`), startedAt: Date.now() };
	await writeFile(input.outputFile, "");
	const record: BackgroundRecord = { kind, description: input.description, startedAt: input.startedAt, status: "running", taskId: 0 };
	// Listed before the commit: a quick command can settle, and update its row, before the commit returns.
	registerBackground(engine, input.id, record, "timeout" in input && input.timeout ? input.startedAt + input.timeout : undefined);
	try {
		await root.commit(async (tx) => {
			// SAFETY: the kind picks the task whose input this is.
			const taskId = kind === "job" ? await tx.createTask(kit.Job, input as JobInput, BACKGROUND) : await tx.createTask(kit.Monitor, input as MonitorInput, BACKGROUND);
			(await tx.doc(kit.Background, root.id)).tasks[input.id] = json({ ...record, taskId: Number(taskId) });
		}, CTX);
	} catch (error) {
		tasks.remove(input.id);
		throw error;
	}
	return input.outputFile;
}

function registerBackground(engine: Engine, id: string, record: BackgroundRecord, deadline?: number): void {
	tasks.register({ id, kind: record.kind, description: record.description, status: record.status, ownerSession: engine.session, startedAt: record.startedAt, deadline, stop: () => stopBackground(engine, id) });
}

/** TaskStop of a job or monitor: the run is signalled (its process group killed), then its abort handler settles it. */
async function stopBackground(engine: Engine, id: string): Promise<void> {
	const record = backgroundRecords(await engine.harness.snapshot(engine.kit.Background, engine.root.id, CTX))[id];
	if (!record) return;
	// SAFETY: taskId was stored from the TaskId this harness created.
	await engine.harness.abortTask(record.taskId as Durable.TaskId, CTX);
}

async function open(session: string, cwd: string, acks: ReturnType<typeof sessionAcks>): Promise<Engine> {
	const dir = await storageDir(cwd, session);
	// The folder's mtime is its last heartbeat or unlock: about when Pi last held this engine.
	const from = await stat(dir).then((info) => info.mtimeMs, () => undefined);
	await mkdir(join(dir, "out"), { recursive: true });
	await lock(join(dir, "engine.lock"));
	await rm(join(dir, SETTLED), { force: true });
	let harness: Durable.Harness | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	try {
		await reap(`PI_KIT_OWNER=${dir}`);
		const { D, openStorage } = await (host.modules ??= loadModules());
		const registry = D.createRegistry();
		const kit = buildKit(D, dir, cwd);
		registry.install(kit.extension);
		harness = await D.Harness.open(await openStorage(join(dir, "engine.sqlite")), {
			models: modelsAdapter(),
			registry,
			// pi-durable's default 3 retries back off about 14 s; 5 ride out about a minute of 429s from many agents on one account.
			settings: { retry: { maxRetries: 5 }, progress: { partialIntervalMs: 500, outputIntervalMs: 500 } },
			onReport: () => {},
		}, CTX);
		heartbeat = setInterval(() => void utimes(dir, new Date(), new Date()).catch(() => {}), 30_000);
		heartbeat.unref();
		return await resume({ session, dir, project: cwd, harness, root: await harness.root(CTX), registry, kit, heartbeat }, D, from, acks);
	} catch (error) {
		clearInterval(heartbeat);
		await harness?.close(CTX).catch(() => {});
		await unlock(join(dir, "engine.lock"));
		throw error;
	}
}

/** Lists the session's tasks on the roster, holds the slots of runs Pi closed mid-way, then lets durable continue them. */
async function resume(engine: Engine, D: D, from: number | undefined, acks: ReturnType<typeof sessionAcks>): Promise<Engine> {
	const { session, harness, root, registry, kit } = engine;
	const records = agentRecords(await harness.snapshot(kit.Agents, root.id, CTX));
	const workflows = workflowRecords(await harness.snapshot(kit.Workflows, root.id, CTX));
	installSchemas(D, registry, session, workflows);
	void prune(join(getAgentDir(), "pi-kit")).catch(() => {});
	const background = backgroundRecords(await harness.snapshot(kit.Background, root.id, CTX));
	const shown = new Set(recent([records, workflows, background].flatMap((doc) => Object.entries(doc).map(([id, record]) => ({ id, ...record })))).map((entry) => entry.id));
	for (const [id, record] of Object.entries(records)) if (shown.has(id)) registerAgent(engine, id, record);
	for (const [id, record] of Object.entries(workflows)) if (shown.has(id)) registerWorkflow(engine, id, record);
	for (const [id, record] of Object.entries(background)) if (shown.has(id)) registerBackground(engine, id, record);
	// ponytail: a resumed run takes its slot without waiting; reopening a session while another fills the 16 exceeds them until the extra runs end.
	const unsettled = new Set((await harness.inspect(CTX)).submissions.map((submission) => submission.conversationId));
	for (const [id, record] of Object.entries(records)) {
		if (record.status !== "running" || record.conversationId === undefined || !unsettled.has(record.conversationId)) continue;
		host.running++;
		host.reserved.add(id);
	}
	host.closed.set(session, { from, to: Date.now() });
	await root.commit(async (tx) => pruneOutbox(await tx.doc(kit.Outbox, root.id), session), CTX);
	harness.resume();
	const undelivered = outboxItems(await harness.snapshot(kit.Outbox, root.id, CTX)).filter((item) => !acks.delivered.has(item.notificationId));
	for (const item of undelivered.filter(unsent(acks.answered))) await tasks.notify(item);
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
		phases: { run: (task, runtime, context) => report(D, { Outbox, Agents }, task.input, runtime, context).catch(failRun({ Outbox, Agents }, task.input, runtime, context)) },
		abort: terminal("aborted"),
	});
	const CliTask: Kit["CliTask"] = D.defineTask<CliInput, { phase: "run" }, null>({
		name: "pi-kit.cli-worker",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, context) => runCli({ Outbox, Agents, CliTask }, owner, task.input, runtime, context).catch(failRun({ Outbox, Agents }, task.input, runtime, context)) },
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
			const blocked = guardBashCall(String(call.arguments.command ?? ""), cwd, agentWorktreeAt(cwd, getAgentDir()) ?? project, project);
			return blocked ? { block: blocked.reason } : undefined;
		},
	});
	const Background = D.defineDoc<BackgroundDoc>({ kind: "pi-kit.background", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ tasks: {} }) });
	const { Job, Monitor } = backgroundTasks(D, { Outbox, Background }, host);
	const extension = D.defineExtension({ name: "pi-kit", tasks: [Anchor, Reporter, CliTask, Job, Monitor, Workflow], tools: Object.values(tools), hooks: [guard] });
	return { extension, tools, Outbox, Agents, Workflows, Calls, Anchor, Reporter, CliTask, Background, Job, Monitor, Workflow };
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
	let finished: (n: TaskNotification | undefined) => void = () => {};
	const live: Live = { placed: false, closing: false, inflight: [], done: new Promise((resolve) => { finished = resolve; }) };
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
				// SendMessage steers a placed run itself, so this drain, committed after `placed`, misses no pending message.
				const pending = await engine.root.commit(async (tx) => {
					const current = agentRecords(await tx.doc(docs.Agents, engine.root.id))[input.agentId];
					const messages = [...current?.pending ?? []];
					if (current) delete current.pending;
					return messages;
				}, context);
				for (const message of pending) live.inflight.push(conversation.submit({ type: "input", content: message, requestId: `send:${randomUUID()}`, whenBusy: "steer" }, context));
				const turns = input.limits.maxTurns ? (await scan(conversation, context)).slice(input.from?.entries ?? 0).filter((entry) => entry.kind === "pi.assistant").length : 0;
				const unwatch = watchLimits(D, engine, input, turns, (limit) => {
					limited = limit;
					void conversation.abort(CTX);
				});
				try {
					settled = await submission.wait(context);
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
		if (settled?.status === "done") limited = undefined;
		const output = settled?.status === "done" || limited ? lastText : "";
		const status = settled?.status === "done" ? "completed"
			: limited ? (output ? "completed" : "failed")
			: settled === undefined || settled.status === "unanswered" && settled.reason === "aborted" ? "killed" : "failed";
		const outcome: Outcome = {
			status,
			summary: agentSummary(input.description, status, { error: failure(settled), byUser: (await record())?.stoppedBy === "user", limited }),
			result: output,
			usage: {
				subagentTokens: tokens,
				toolUses: run.filter((entry) => entry.kind === "pi.tool-result").length,
				durationMs: Date.now() - input.startedAt,
			},
		};
		if (limited) outcome.limited = limited;
		({ n, claimed } = await commitReport(docs, input, runtime, context, transcriptLog(transcript), outcome));
	} finally {
		if (host.live.get(input.agentId) === live) host.live.delete(input.agentId);
		finished(n);
	}
	await deliver(input.agentId, n, claimed);
}

type Outcome = Pick<TaskNotification, "summary" | "result" | "usage" | "limited"> & Required<Pick<TaskNotification, "status">>;
type RunRuntime = Pick<Durable.TaskRuntime<unknown, { phase: "run" }, null, object>, "taskId" | "conversationId" | "commit" | "signal">;

/** Commits a run's report: the record's status, the notification in the Outbox and, for a CLI worker with queued messages, its next run. */
async function commitReport(docs: Pick<Kit, "Outbox" | "Agents"> & { CliTask?: Kit["CliTask"] }, input: RunInput, runtime: RunRuntime, context: Ctx, log: string, outcome: Outcome): Promise<{ n: OutboxItem; claimed: boolean }> {
	const kept = input.worktree && existsSync(input.worktree.path) ? await finishAgentWorktree(input.worktree).catch(() => input.worktree) : undefined;
	const n: OutboxItem = { notificationId: `${input.agentId}:${String(runtime.taskId)}`, taskId: input.agentId, kind: "agent", ownerSession: input.session, toolUseId: input.toolUseId, outputFile: input.outputFile, ...outcome };
	if (kept) n.worktree = { path: kept.path, branch: kept.branch };
	await writeFile(input.outputFile, `${log}\n\n${outcome.result}\n`).catch(() => {});
	const waiter = host.waiters.get(input.agentId);
	let next = false;
	await runtime.commit(async (tx) => {
		const record = agentRecords(await tx.doc(docs.Agents, runtime.conversationId))[input.agentId];
		if (record?.queued?.length && docs.CliTask && !record.stopped) {
			await tx.createTask(docs.CliTask, cliInput(input, input.agentId, record, record.queued.join("\n\n"), input.toolUseId), BACKGROUND);
			record.queued = [];
			next = true;
		} else if (record) record.status = outcome.status;
		if (waiter && !waiter.timedOut) waiter.claimed = true;
		post(await tx.doc(docs.Outbox, runtime.conversationId), { ...n, silent: waiter?.claimed || undefined });
		return { status: "terminal", outcome: { status: "completed", result: null } };
	}, context);
	tasks.update(input.agentId, { status: next ? "running" : outcome.status });
	return { n, claimed: Boolean(waiter?.claimed) };
}

/** A run that threw, other than because Pi is closing, still reports: durable would end it silently and leave the lead waiting. */
const failRun = (docs: Pick<Kit, "Outbox" | "Agents">, input: RunInput, runtime: RunRuntime, context: Ctx) => async (error: Error): Promise<void> => {
	if (host.closing || runtime.signal.aborted) throw error;
	const { n, claimed } = await commitReport(docs, input, runtime, context, "", {
		status: "failed",
		summary: agentSummary(input.description, "failed", { error: error instanceof Error ? error.message : String(error) }),
		result: "",
		usage: { subagentTokens: 0, toolUses: 0, durationMs: Date.now() - input.startedAt },
	});
	await deliver(input.agentId, n, claimed);
};

/** The report goes to the foreground call that waits for it, or to the lead. */
async function deliver(agentId: string, n: OutboxItem, claimed: boolean): Promise<void> {
	if (!claimed) return tasks.notify(n);
	host.waiters.get(agentId)?.resolve(n);
	host.waiters.delete(agentId);
}

/**
 * A Claude Code or Codex worker. The intent is memoed before the spawn and the CLI's session id at its first event, so after
 * Pi closed, the reaper having killed the old process group, the run resumes that session, or starts again if none began.
 */
async function runCli(docs: Pick<Kit, "Outbox" | "Agents" | "CliTask">, owner: string, input: CliInput, runtime: Durable.TaskRuntime<CliInput, { phase: "run" }, null, object>, context: Ctx): Promise<void> {
	const record = async () => agentRecords(await runtime.snapshot(docs.Agents, runtime.conversationId, context))[input.agentId];
	const intent = await runtime.memo<{ prompt: string; resume: string | null }>("intent", { prompt: input.prompt, resume: (await record())?.sessionId ?? null }, context);
	const interrupted = await runtime.memo<string>("session", context);
	const run = interrupted ? { resume: interrupted, prompt: CONTINUE } : { resume: intent.resume ?? undefined, prompt: intent.prompt };
	const worktree = input.worktree && await reopenWorktree(input.worktree);
	const progress = newCliProgress();
	let exit: CliExit | undefined;
	const held = await acquire(input.agentId);
	try {
		if (held && !(await record())?.stopped) {
			exit = await spawnWorker(input, owner, run, progress, runtime.signal, host.workers, async (session) => {
				await runtime.memo("session", session, context);
				await runtime.commit(async (tx) => {
					const current = agentRecords(await tx.doc(docs.Agents, runtime.conversationId))[input.agentId];
					if (current) current.sessionId = session;
					return undefined;
				}, context);
			});
		}
	} finally {
		if (held) release();
	}
	// Quitting Pi kills the worker before the harness closes; the run is not over, and resumes with the session.
	if (host.closing || runtime.signal.aborted) {
		await new Promise((resolve) => (runtime.signal.aborted ? resolve(undefined) : runtime.signal.addEventListener("abort", resolve, { once: true })));
		throw new Error("Pi closed while the worker ran.");
	}
	const stopped = (await record())?.stopped;
	const answer = await cliAnswer(input.worker, exit, progress);
	const status = !exit || stopped ? "killed" : answer.ok ? "completed" : "failed";
	const { n, claimed } = await commitReport(docs, { ...input, worktree }, runtime, context, progress.log.join("\n"), {
		status,
		summary: agentSummary(input.description, status, { error: answer.error, byUser: (await record())?.stoppedBy === "user" }),
		result: status === "completed" ? answer.text : "",
		usage: { subagentTokens: progress.tokens, toolUses: progress.toolUses, durationMs: Date.now() - input.startedAt },
	});
	await deliver(input.agentId, n, claimed);
}

/**
 * `maxTurns`, `maxTokens` and `timeout` exist only when the user asked; the first one reached stops the agent.
 * `turns` already taken counts toward `maxTurns`, so a run reopened after Pi exits keeps its count.
 */
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

const agentRecords = (doc: AgentsDoc | undefined) => decoded<Record<string, AgentRecord>>(doc?.agents) ?? {};
const backgroundRecords = (doc: BackgroundDoc | undefined) => decoded<Record<string, BackgroundRecord>>(doc?.tasks) ?? {};
