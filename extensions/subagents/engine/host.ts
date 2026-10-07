// What the engine's agents and workflow runs share in this process: the host kept across /reload, the agent throttle,
// where an agent works, and readers of a durable transcript.
import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ResolvedModel } from "../../shared/models.ts";
import type { TaskNotification } from "../../shared/tasks.ts";
import { createAgentWorktree, gitTopLevel, type AgentWorktree } from "../../shared/worktree.ts";
import { workerPrompt, type AgentType, type PiToolName } from "../definitions.ts";
import type { Progress } from "../workflow/run.ts";
import type { BackgroundHost, backgroundTasks, BackgroundDoc, OutboxDoc } from "./background.ts";
import type { CliWorker } from "./cli.ts";
import type { CliInput, ReporterInput } from "./index.ts";
import type { WorkflowInput } from "./workflow.ts";

export type D = typeof Durable;
export type Ctx = Parameters<Durable.Harness["close"]>[0];
export type ConversationId = Durable.ConversationId;
// Documents hold strict JSON; these shapes are written through `json()`.
export type AgentsDoc = { agents: Record<string, Durable.JsonObject> };
export type WorkflowsDoc = { workflows: Record<string, Durable.JsonObject> };

/** Claude Code's workflow concurrency: CPUs − 2, at least 2 and at most 16. */
export const agentSlots = (cpus = availableParallelism()): number => Math.min(16, Math.max(2, cpus - 2));
/** One global throttle across every engine and Workflow: at most AGENT_SLOTS agents run, the rest queue FIFO. */
export const AGENT_SLOTS = agentSlots();
// ponytail: a structural chord Context that never cancels; import chord's BACKGROUND_CONTEXT if durable starts checking identity.
export const CTX: Ctx = { abortSignal: undefined, value: () => undefined, toString: () => "pi-kit" };
export const FailureDetail = Type.Object({ message: Type.String() });
export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;
export interface Kit {
	extension: Durable.Extension;
	tools: Record<PiToolName, Durable.ToolRegistration>;
	Outbox: Durable.ConversationDocToken<OutboxDoc>;
	Agents: Durable.ConversationDocToken<AgentsDoc>;
	Workflows: Durable.ConversationDocToken<WorkflowsDoc>;
	Calls: Durable.ConversationDocFamilyToken<Durable.JsonObject, string>;
	Anchor: Durable.Task<null, { phase: "done" }, null, object>;
	Reporter: Durable.Task<ReporterInput, { phase: "run" }, null, object>;
	CliTask: Durable.Task<CliInput, { phase: "run" }, null, object>;
	Workflow: Durable.Task<WorkflowInput, { phase: "run" }, null, object>;
	Background: Durable.ConversationDocToken<BackgroundDoc>;
	Job: ReturnType<typeof backgroundTasks>["Job"];
	Monitor: ReturnType<typeof backgroundTasks>["Monitor"];
}

export interface Engine {
	session: string;
	dir: string;
	project: string;
	harness: Durable.Harness;
	root: Durable.Conversation;
	registry: Durable.Registry;
	kit: Kit;
	/** Touches the storage folder while this Pi holds the engine. */
	heartbeat: NodeJS.Timeout;
}

export interface Modules { D: D; openStorage(file: string): Promise<Durable.Storage> }
export interface Waiter { claimed: boolean; timedOut: boolean; resolve(n: TaskNotification): void }
/** A reporter in this process. Messages steer its run only between the prompt's placement and `closing`; after that, SendMessage waits for the report and resumes. */
export interface Live { placed: boolean; closing: boolean; inflight: Promise<unknown>[]; done: Promise<TaskNotification | undefined> }
export interface Host extends BackgroundHost {
	/** The durable module stays loaded across /reload: a fresh copy would fail its own `instanceof` checks. */
	modules?: Promise<Modules>;
	engines: Map<string, Promise<Engine>>;
	models?: ModelRegistry;
	running: number;
	/** Agents whose run Pi closed mid-way: durable continues it at once, so it holds a slot before its reporter asks. */
	reserved: Set<string>;
	queue: { agentId: string; go(held: boolean): void }[];
	waiters: Map<string, Waiter>;
	live: Map<string, Live>;
	/** Live progress of each workflow run, by its task id: the widget and /agents read it across /reload. */
	workflows: Map<string, Progress>;
	/** Running CLI workers by agentId, for TaskStop. */
	workers: Map<string, ChildProcess>;
	/** By session, the user's request that started the current turn, snapshotted by Workflow at launch. */
	requests: Map<string, string>;
}

const KEY = Symbol.for("pi-kit.agents");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores the host in it.
const slot = globalThis as typeof globalThis & { [KEY]?: Host };
export const host: Host = slot[KEY] ??= { engines: new Map(), running: 0, reserved: new Set(), queue: [], waiters: new Map(), closing: false, closed: new Map(), live: new Map(), workflows: new Map(), workers: new Map(), requests: new Map() };
// A host kept by /reload from an older kit version.
host.live ??= new Map();
host.workflows ??= new Map();
host.workers ??= new Map();
host.reserved ??= new Set();
host.requests ??= new Map();
host.closed ??= new Map();
export const userRequests = host.requests;

export function queuedAhead(): boolean {
	return host.running >= AGENT_SLOTS;
}

export interface Placement { writer: boolean; worktree?: AgentWorktree; cwd: string }

/** Where an agent works. Claude workers bypass permissions, so a Claude writer in a repository always gets its own worktree. */
export async function placeAgent(type: AgentType, resolved: ResolvedModel, requested: string, agentId: string, isolation: "worktree" | undefined): Promise<Placement> {
	const writer = type.tools.includes("edit") || type.tools.includes("write");
	const isolate = (isolation ?? type.isolation) === "worktree" || resolved.harness === "claude" && writer && await gitTopLevel(requested) !== undefined;
	const worktree = isolate ? await createAgentWorktree({ cwd: requested, agentId, agentDir: getAgentDir() }) : undefined;
	return { writer, worktree, cwd: worktree ? join(worktree.path, relative(worktree.repoRoot, realpathSync(requested))) : requested };
}

/** The worker of a `claude:` or `codex:` model. */
export function cliWorker(engine: Engine, type: AgentType, resolved: Extract<ResolvedModel, { harness: "claude" | "codex" }>, at: Placement, agentId: string, schema?: Durable.JsonObject): CliWorker {
	return { harness: resolved.harness, model: resolved.model, level: resolved.level, cwd: at.cwd, instructions: workerPrompt(type, at.cwd, at.worktree, true), tools: type.tools, writer: at.writer, schema, dir: join(engine.dir, "cli", agentId) };
}

export function totalTokens(usage: { models?: Record<string, { totalTokens?: number }> } | undefined): number {
	return Object.values(usage?.models ?? {}).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0);
}

export function acquire(agentId: string): Promise<boolean> {
	if (host.reserved.delete(agentId)) return Promise.resolve(true);
	if (host.running < AGENT_SLOTS) {
		host.running++;
		return Promise.resolve(true);
	}
	return new Promise((go) => host.queue.push({ agentId, go }));
}

/** A freed slot passes straight to the oldest queued agent. */
export function release(): void {
	// A slot over the limit (reserved for a resumed run) is given back, not handed to the queue.
	const next = host.running <= AGENT_SLOTS ? host.queue.shift() : undefined;
	if (next) next.go(true);
	else host.running--;
}

export async function scan(conversation: Durable.Conversation, context: Ctx): Promise<Durable.EntryRecord[]> {
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

export function text(message: Message | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function transcriptLog(entries: readonly Durable.EntryRecord[]): string {
	return entries.flatMap((entry) => (entry.model ?? []).flatMap((message) => {
		if (message.role === "assistant") return message.content.flatMap((block) => block.type === "toolCall" ? [`→ ${block.name} ${JSON.stringify(block.arguments).slice(0, 300)}`] : block.type === "text" && block.text ? [block.text] : []);
		if (message.role === "toolResult") return [`← ${message.isError ? "error " : ""}${message.content.flatMap((block) => (block.type === "text" ? [block.text.slice(0, 300)] : [])).join("")}`];
		return [];
	})).join("\n");
}

export function failure(settled: Durable.SettledSubmissionRecord | undefined): string {
	if (settled?.status !== "unanswered") return "no answer";
	return Value.Check(FailureDetail, settled.detail) ? settled.detail.message : settled.reason;
}
