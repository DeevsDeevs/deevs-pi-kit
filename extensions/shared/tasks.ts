import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TaskKind = "agent" | "workflow" | "job" | "monitor" | "collaborator";
export type TaskStatus = "running" | "completed" | "failed" | "killed" | "paused";

export interface RosterEntry {
	id: string;
	kind: TaskKind;
	name?: string;
	description: string;
	status: TaskStatus;
	/** `ctx.sessionManager.getSessionId()` of the lead session that owns the task. */
	ownerSession: string;
	startedAt: number;
	stop?: () => Promise<void>;
}

export interface TaskNotification {
	notificationId: string;
	taskId: string;
	kind: TaskKind;
	ownerSession: string;
	toolUseId?: string;
	outputFile?: string;
	status: "completed" | "failed" | "killed";
	summary: string;
	result?: string;
	usage?: { subagentTokens?: number; toolUses?: number; durationMs?: number };
	worktree?: { path: string; branch: string };
	limited?: string;
}

export interface NotificationSource {
	name: string;
	pending(ownerSession: string): Promise<TaskNotification[]>;
}

export const TASK_NOTIFICATION = "task-notification";

const AGENT_NOTE = "A task-notification fires each time this agent stops. A SendMessage to it resumes it, so the same task-id may notify more than once.";

interface TasksState {
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	installed: WeakSet<ExtensionAPI>;
	roster: Map<string, RosterEntry>;
	sources: Map<string, NotificationSource>;
	/** Notified but not yet seen in their owner's session file. */
	outstanding: Map<string, TaskNotification>;
	/** Sent in this session runtime; true when it went in as a steer that Esc can clear. */
	sent: Map<string, boolean>;
}

const TASKS = Symbol.for("pi-kit.tasks");
// SAFETY: This package exclusively owns the symbol-keyed slot and only ever stores TasksState in it.
const globalRegistry = globalThis as typeof globalThis & { [TASKS]?: TasksState };
const state: TasksState = globalRegistry[TASKS] ??= { installed: new WeakSet(), roster: new Map(), sources: new Map(), outstanding: new Map(), sent: new Map() };

export const tasks = {
	install(pi: ExtensionAPI): void {
		if (state.installed.has(pi)) return;
		state.installed.add(pi);
		state.pi = pi;
		pi.on("session_start", async (event, ctx) => {
			if (state.pi !== pi) return;
			if (event.reason !== "reload") state.sent.clear();
			state.ctx = ctx;
			await redeliver(ctx);
		});
		pi.on("agent_settled", async (_event, ctx) => {
			if (state.pi !== pi) return;
			state.ctx = ctx;
			for (const [id, steered] of state.sent) if (steered) state.sent.delete(id);
			await redeliver(ctx);
		});
		pi.on("session_shutdown", () => {
			if (state.pi === pi) state.ctx = undefined;
		});
	},
	register(entry: RosterEntry): void {
		state.roster.set(entry.id, entry);
	},
	update(id: string, patch: Partial<RosterEntry>): void {
		const entry = state.roster.get(id);
		if (entry) state.roster.set(id, { ...entry, ...patch });
	},
	remove(id: string): void {
		state.roster.delete(id);
	},
	list(ownerSession?: string): RosterEntry[] {
		return [...state.roster.values()].filter((entry) => ownerSession === undefined || entry.ownerSession === ownerSession);
	},
	find(idOrName: string, ownerSession?: string): RosterEntry | undefined {
		const entries = tasks.list(ownerSession);
		return entries.find((entry) => entry.id === idOrName)
			?? entries.filter((entry) => entry.name === idOrName).sort((a, b) => b.startedAt - a.startedAt)[0];
	},
	addSource(source: NotificationSource): void {
		state.sources.set(source.name, source);
	},
	async notify(notification: TaskNotification): Promise<void> {
		state.outstanding.set(notification.notificationId, notification);
		const ctx = state.ctx;
		if (ctx && activeSession() === notification.ownerSession) {
			if (deliveredIds(ctx).has(notification.notificationId)) state.outstanding.delete(notification.notificationId);
			else send(notification);
		}
		showHeld();
	},
};

async function redeliver(ctx: ExtensionContext): Promise<void> {
	const session = ctx.sessionManager.getSessionId();
	const pending = [...state.outstanding.values()].filter((notification) => notification.ownerSession === session);
	for (const source of state.sources.values()) {
		try {
			pending.push(...await source.pending(session));
		} catch {
			// One broken source must not block the others' reports.
		}
	}
	if (state.ctx !== ctx) return;
	const delivered = deliveredIds(ctx);
	for (const notification of pending) {
		if (delivered.has(notification.notificationId)) state.outstanding.delete(notification.notificationId);
		else send(notification);
	}
	showHeld();
}

function send(notification: TaskNotification): void {
	const { pi, ctx } = state;
	if (!pi || !ctx || state.sent.has(notification.notificationId)) return;
	try {
		const steered = !ctx.isIdle();
		pi.sendMessage({
			customType: TASK_NOTIFICATION,
			content: formatTaskNotification(notification),
			display: true,
			details: { notificationId: notification.notificationId },
		}, { triggerTurn: true, deliverAs: "steer" });
		state.sent.set(notification.notificationId, steered);
	} catch {
		// A stale pi after /reload or a session switch; the next session_start sends it again.
	}
}

function deliveredIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== TASK_NOTIFICATION) continue;
		// SAFETY: Session entries are untrusted; a non-string id only sits in the set and never equals a real one.
		const id = (entry.details as { notificationId?: string } | undefined)?.notificationId;
		if (id !== undefined) ids.add(id);
	}
	return ids;
}

function activeSession(): string | undefined {
	try {
		return state.ctx?.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function showHeld(): void {
	const session = activeSession();
	if (!session) return;
	const held = [...state.outstanding.values()].filter((notification) => notification.ownerSession !== session).length;
	try {
		state.ctx?.ui.setStatus("tasks", held ? `${held} held` : undefined);
	} catch {
		// A stale ctx has no status line to update.
	}
}

/** Neutralizes envelope markup inside interpolated text (A.5); syntax only. */
export function escapeMarkup(text: string): string {
	return text
		.replace(/<(\/?)(task-notification|system-reminder)/gi, "<\\$1$2")
		.replace(/\[(Workflow harness)/gi, "[\\$1");
}

export function formatTaskNotification(n: TaskNotification): string {
	const tag = (name: string, value: string | number | undefined): string[] => value === undefined ? [] : [`<${name}>${escapeMarkup(String(value))}</${name}>`];
	const usage = n.usage && [
		...tag("subagent_tokens", n.usage.subagentTokens),
		...tag("tool_uses", n.usage.toolUses),
		...tag("duration_ms", n.usage.durationMs),
	].join("");
	return [
		"<task-notification>",
		...tag("task-id", n.taskId),
		...tag("tool-use-id", n.toolUseId),
		...tag("output-file", n.outputFile),
		...tag("status", n.status),
		...tag("summary", n.summary),
		...tag("limited", n.limited),
		...(n.kind === "agent" ? [`<note>${AGENT_NOTE}</note>`] : []),
		...tag("result", n.result === undefined ? undefined : capResult(n.result, n.kind === "workflow" ? 8_000 : 100_000, n.outputFile)),
		...(usage ? [`<usage>${usage}</usage>`] : []),
		...(n.worktree ? [`<worktree>${tag("worktreePath", n.worktree.path)[0]}${tag("worktreeBranch", n.worktree.branch)[0]}</worktree>`] : []),
		"</task-notification>",
	].join("\n");
}

function capResult(text: string, cap: number, outputFile: string | undefined): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n... (truncated ${text.length - cap} chars${outputFile ? `, full result in ${outputFile}` : ""})`;
}

export function agentSummary(description: string, status: TaskNotification["status"], detail: { error?: string; byUser?: boolean } = {}): string {
	if (status === "completed") return `Agent "${description}" finished`;
	if (status === "failed") return `Agent "${description}" failed: ${detail.error ?? "unknown error"}`;
	return `Agent "${description}" was stopped${detail.byUser ? " by user" : ""}`;
}

export function workflowSummary(description: string, status: TaskNotification["status"], error?: string): string {
	if (status === "completed") return `Dynamic workflow "${description}" completed`;
	if (status === "failed") return `Dynamic workflow "${description}" failed: ${error ?? "unknown error"}`;
	return `Dynamic workflow "${description}" was stopped`;
}

export type JobEnd = { exitCode: number } | { error: string } | "stopped" | "interrupted";

export function jobSummary(description: string, end: JobEnd): string {
	const subject = `Background command "${description}"`;
	if (end === "stopped") return `${subject} was stopped`;
	if (end === "interrupted") return `${subject} was interrupted when Pi closed`;
	if ("error" in end) return `${subject} failed: ${end.error}`;
	return end.exitCode === 0 ? `${subject} completed (exit code 0)` : `${subject} failed with exit code ${end.exitCode}`;
}

export interface AgentLaunch {
	agentId: string;
	outputFile: string;
	model?: string;
	limits?: string;
	queued?: boolean;
	sharesCwd?: boolean;
}

export function agentLaunchedResult(launch: AgentLaunch): string {
	return [
		"Async agent launched successfully.",
		`agentId: ${launch.agentId} (internal ID; use SendMessage with to: '${launch.agentId}' to continue this agent)`,
		"It works in the background and you will be notified when it finishes. Until then you know nothing about its result: do not guess it, wait for it, or redo its work. Carry on with other work or answer the user.",
		`output_file: ${launch.outputFile}`,
		"Do not read this file while the agent runs; it is written when the agent finishes, and the notification carries the result.",
		...(launch.model ? [`model: ${launch.model}`] : []),
		...(launch.limits ? [`limits: ${launch.limits}`] : []),
		...(launch.queued ? ["Queued: 16 agents are running; this one starts when a slot frees."] : []),
		...(launch.sharesCwd ? ["Another agent that can write already works in this directory. For parallel code-writing agents, dispatch each with isolation: \"worktree\"."] : []),
	].join("\n");
}

export interface AgentForeground {
	text: string;
	agentId: string;
	worktree?: { path: string; branch: string };
	usage: { subagentTokens: number; toolUses: number; durationMs: number };
}

export function agentForegroundResult(result: AgentForeground): string {
	return [
		result.text || "(The agent finished without output.)",
		`agentId: ${result.agentId} (use SendMessage with to: '${result.agentId}' to continue this agent)`,
		...(result.worktree ? [`worktreePath: ${result.worktree.path}`, `worktreeBranch: ${result.worktree.branch}`] : []),
		`<usage>subagent_tokens: ${result.usage.subagentTokens}\ntool_uses: ${result.usage.toolUses}\nduration_ms: ${result.usage.durationMs}</usage>`,
	].join("\n");
}

export function agentTypeNotFound(type: string, available: string[]): string {
	return `Agent type '${type}' not found. Available agents: ${available.join(", ")}`;
}

export function taskStoppedResult(id: string, description: string, keptWorktrees: { path: string; branch: string }[] = []): string {
	const kept = keptWorktrees.map((worktree) => `${worktree.path} (${worktree.branch})`).join(", ");
	return `Successfully stopped task: ${id} (${description})${kept ? `\nKept worktrees with changes: ${kept}` : ""}`;
}

export function taskNotRunningResult(id: string, status: TaskStatus): string {
	return `Task ${id} is not running (status: ${status})`;
}

export interface WorkflowLaunch {
	taskId: string;
	summary: string;
	transcriptDir: string;
	scriptPath: string;
	runId: string;
}

export function workflowLaunchedResult(launch: WorkflowLaunch): string {
	return [
		`Workflow launched in background. Task ID: ${launch.taskId}`,
		`Summary: ${launch.summary}`,
		`Transcript dir: ${launch.transcriptDir}`,
		`Script file: ${launch.scriptPath} (edit it, then call Workflow with this scriptPath to iterate without resending the script)`,
		`Run ID: ${launch.runId}`,
		`To resume after editing the script: Workflow({scriptPath: "${launch.scriptPath}", resumeFromRunId: "${launch.runId}"}) — the longest unchanged prefix of agent() calls replays from cache; read journal.jsonl before trusting a cached result.`,
		"You will be notified when it completes. Use /agents to watch live progress.",
	].join("\n");
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const base36 = (length: number): string => Array.from({ length }, () => BASE36[randomInt(36)]).join("");

export const newAgentId = (): string => `a${randomBytes(8).toString("hex")}`;
export const newWorkflowTaskId = (): string => `w${base36(8)}`;
export const newBackgroundTaskId = (): string => `b${base36(8)}`;
export const newWorkflowRunId = (): string => `wf_${randomUUID().slice(0, 12)}`;
