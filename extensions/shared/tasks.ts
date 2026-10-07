import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { migrateLegacyConfig } from "./config.ts";

export type TaskKind = "agent" | "workflow" | "job" | "monitor" | "collaborator";
export type TaskStatus = "running" | "completed" | "failed" | "killed";

export interface RosterEntry {
	id: string;
	kind: TaskKind;
	name?: string;
	description: string;
	status: TaskStatus;
	/** `ctx.sessionManager.getSessionId()` of the lead session that owns the task. */
	ownerSession: string;
	startedAt: number;
	/** Resolves once stopped; an agent's report carries the worktree it kept. */
	stop?: () => Promise<{ worktree?: { path: string; branch: string } } | undefined | void>;
	/** Set by kinds that take messages through their own channel (collaborators); returns the result line. */
	send?: (message: string, images: string[]) => Promise<string>;
}

export interface TaskNotification {
	notificationId: string;
	taskId: string;
	kind: TaskKind;
	ownerSession: string;
	toolUseId?: string;
	outputFile?: string;
	/** Absent on a monitor event that does not end its watch. */
	status?: "completed" | "failed" | "killed";
	summary: string;
	/** Replaces the agent note; a job says here that its log was cut. */
	note?: string;
	event?: string;
	/** `closed from <t1> to <t2>`: the event caught up on what changed while Pi was closed. */
	caughtUp?: string;
	result?: string;
	usage?: { agentCount?: number; agentsDone?: number; agentsError?: number; agentsSkipped?: number; agentsEmptyResult?: number; subagentTokens?: number; toolUses?: number; durationMs?: number };
	worktree?: { path: string; branch: string };
	limited?: string;
	/** Workflow runs: `recovery` when one failed, `diagnostics` when one completed, and the agents that failed. */
	recovery?: string;
	diagnostics?: string;
	failures?: string;
}

export interface NotificationSource {
	name: string;
	/** `answered` holds the tool calls whose results the owner session saved. */
	pending(ownerSession: string, answered: Set<string>): Promise<TaskNotification[]>;
}

export const TASK_NOTIFICATION = "task-notification";

/** The kit is proven on Pi 1.0.4, the release the polygon runs. */
export function oldPiWarning(version: string): string | undefined {
	return version.localeCompare("1.0.4", undefined, { numeric: true }) < 0 ? `pi-kit: needs Pi 1.0.4 or newer, and this is Pi ${version}; update Pi.` : undefined;
}

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
	/** By session: settles once the engine has put the session's resumed tasks on the roster. */
	resumed?: Map<string, { done: Promise<void>; resolve(): void }>;
	/** Shown by the first session start; print mode, whose notify does nothing, has the console copy. */
	oldPi?: string;
}

const TASKS = Symbol.for("pi-kit.tasks");
// SAFETY: This package exclusively owns the symbol-keyed slot and only ever stores TasksState in it.
const globalRegistry = globalThis as typeof globalThis & { [TASKS]?: TasksState };
const state: TasksState = globalRegistry[TASKS] ??= { installed: new WeakSet(), roster: new Map(), sources: new Map(), outstanding: new Map(), sent: new Map() };

export const tasks = {
	/** The kit's start-up: the roster's delivery hooks, the one legacy-config migration per session, and the Pi version warning. */
	install(pi: ExtensionAPI): void {
		if (state.installed.has(pi)) return;
		if (!state.pi) {
			state.oldPi = oldPiWarning(VERSION);
			if (state.oldPi) console.warn(state.oldPi);
		}
		state.installed.add(pi);
		state.pi = pi;
		pi.on("session_start", async (event, ctx) => {
			if (state.pi !== pi) return;
			if (event.reason !== "reload") state.sent.clear();
			if (state.oldPi) ctx.ui.notify(state.oldPi, "warning");
			state.oldPi = undefined;
			state.ctx = ctx;
			await redeliver(ctx);
			if (ctx.isProjectTrusted()) await migrateLegacyConfig(ctx.cwd);
		});
		pi.on("agent_settled", async (_event, ctx) => {
			if (state.pi !== pi) return;
			state.ctx = ctx;
			for (const [id, steered] of state.sent) if (steered) state.sent.delete(id);
			const before = new Set(state.sent.keys());
			await redeliver(ctx);
			// Print mode exits once its run settles: as CC's -p does, it first waits for the next report of a task still running, whose turn then runs.
			if (ctx.mode === "print" || ctx.mode === "json") await nextReport(ctx.sessionManager.getSessionId(), before);
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
	find(idOrName: string, ownerSession?: string, kind?: TaskKind): RosterEntry | undefined {
		const entries = tasks.list(ownerSession).filter((entry) => kind === undefined || entry.kind === kind);
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
			const { delivered } = sessionAcks(ctx);
			if (delivered.has(notification.notificationId)) state.outstanding.delete(notification.notificationId);
			// A monitor's next event waits while its last one is still on the way; the next redelivery merges what waited.
			else if (notification.kind !== "monitor" || !inFlight(notification.taskId, delivered)) send(notification, [notification.notificationId]);
		}
		showHeld();
	},
	/** What the owner session's file already acknowledges, when that session is on screen. */
	acks(ownerSession: string): ReturnType<typeof sessionAcks> | undefined {
		return state.ctx && activeSession() === ownerSession ? sessionAcks(state.ctx) : undefined;
	},
	/** Settles once the engine has resumed the session's tasks; at once when no engine delivers tasks. */
	resumed(session: string): Promise<void> {
		return state.pi ? resumeGate(session).done : Promise.resolve();
	},
	markResumed(session: string): void {
		resumeGate(session).resolve();
	},
	/** Whether the owner session's lead could take a new turn now; a session not on screen counts as idle (its reports are held). */
	idle(ownerSession: string): boolean {
		try {
			return !state.ctx || activeSession() !== ownerSession || (state.ctx.isIdle() && !state.ctx.hasPendingMessages());
		} catch {
			return true;
		}
	},
};

function resumeGate(session: string): { done: Promise<void>; resolve(): void } {
	const gates = state.resumed ??= new Map();
	let resolve = () => {};
	if (!gates.has(session)) gates.set(session, { done: new Promise<void>((settle) => { resolve = settle; }), resolve: () => resolve() });
	return gates.get(session)!;
}

/** Waits until a notification beyond `before` is sent, or no agent, workflow or job of the session runs. */
async function nextReport(session: string, before: Set<string>): Promise<void> {
	const running = () => tasks.list(session).some((task) => task.status === "running" && task.kind !== "monitor" && task.kind !== "collaborator");
	while (running() && [...state.sent.keys()].every((id) => before.has(id))) await new Promise((resolve) => setTimeout(resolve, 200));
}

function inFlight(taskId: string, delivered: Set<string>): boolean {
	return [...state.outstanding.values()].some((n) => n.taskId === taskId && state.sent.has(n.notificationId) && !delivered.has(n.notificationId));
}

/** Undelivered events of one monitor become one notification that acks all of their ids. */
function mergeEvents(pending: TaskNotification[]): [TaskNotification, string[]][] {
	const out: [TaskNotification, string[]][] = [];
	const open = new Map<string, [TaskNotification, string[]]>();
	for (const n of pending) {
		const merged = n.kind === "monitor" ? open.get(n.taskId) : undefined;
		if (!merged) {
			const entry: [TaskNotification, string[]] = [n, [n.notificationId]];
			out.push(entry);
			if (n.kind === "monitor") open.set(n.taskId, entry);
			continue;
		}
		const [first] = merged;
		merged[0] = { ...n, notificationId: first.notificationId, event: [first.event, n.event].filter(Boolean).join("\n"), caughtUp: first.caughtUp ?? n.caughtUp };
		merged[1].push(n.notificationId);
	}
	return out;
}

async function redeliver(ctx: ExtensionContext): Promise<void> {
	const session = ctx.sessionManager.getSessionId();
	const pending = [...state.outstanding.values()].filter((notification) => notification.ownerSession === session);
	const { answered } = sessionAcks(ctx);
	for (const source of state.sources.values()) {
		try {
			pending.push(...await source.pending(session, answered));
		} catch {
			// One broken source must not block the others' reports.
		}
	}
	if (state.ctx !== ctx) return;
	const { delivered } = sessionAcks(ctx);
	const fresh = new Map<string, TaskNotification>();
	for (const notification of pending) {
		if (delivered.has(notification.notificationId)) state.outstanding.delete(notification.notificationId);
		else if (!state.sent.has(notification.notificationId)) fresh.set(notification.notificationId, notification);
	}
	for (const [notification, ids] of mergeEvents([...fresh.values()])) send(notification, ids);
	showHeld();
}

function send(notification: TaskNotification, ids: string[]): void {
	const { pi, ctx } = state;
	if (!pi || !ctx || state.sent.has(notification.notificationId)) return;
	try {
		const steered = !ctx.isIdle();
		pi.sendMessage({
			customType: TASK_NOTIFICATION,
			content: formatTaskNotification(notification),
			display: true,
			details: { notificationId: notification.notificationId, notificationIds: ids.length > 1 ? ids : undefined },
		}, { triggerTurn: true, deliverAs: "steer" });
		for (const id of ids) state.sent.set(id, steered);
	} catch {
		// A stale pi after /reload or a session switch; the next session_start sends it again.
	}
}

/** What the session file acknowledges: the notifications it holds, and the tool calls whose results it saved. */
export function sessionAcks(ctx: ExtensionContext) {
	const delivered = new Set<string>();
	const answered = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
		if (entry.type !== "custom_message" || entry.customType !== TASK_NOTIFICATION) continue;
		// SAFETY: Session entries are untrusted; a non-string id only sits in the set and never equals a real one.
		const details = entry.details as { notificationId?: string; notificationIds?: string[] } | undefined;
		if (details?.notificationId !== undefined) delivered.add(details.notificationId);
		if (Array.isArray(details?.notificationIds)) for (const id of details.notificationIds) delivered.add(id);
	}
	return { delivered, answered };
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

export const systemReminder = (text: string): string => `<system-reminder>\n${text}\n</system-reminder>`;

/** Neutralizes envelope markup inside interpolated text (A.5); syntax only. */
export function escapeMarkup(text: string): string {
	return text
		.replace(/<(\/?)(task-notification|system-reminder)/gi, "<\\$1$2")
		.replace(/\[(Workflow harness)/gi, "[\\$1");
}

export function formatTaskNotification(n: TaskNotification): string {
	const tag = (name: string, value: string | number | undefined): string[] => value === undefined ? [] : [`<${name}>${escapeMarkup(String(value))}</${name}>`];
	const usage = n.usage && [
		...tag("agent_count", n.usage.agentCount),
		...tag("agents_done", n.usage.agentsDone),
		...tag("agents_error", n.usage.agentsError),
		...tag("agents_skipped", n.usage.agentsSkipped),
		...tag("agents_empty_result", n.usage.agentsEmptyResult),
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
		...tag("note", n.note ?? (n.kind === "agent" ? AGENT_NOTE : undefined)),
		...tag("recovery", n.recovery),
		...tag("event", n.event),
		...tag("caught_up", n.caughtUp),
		...tag("result", n.result === undefined ? undefined : capResult(n.result, n.kind === "workflow" ? 8_000 : 100_000, n.outputFile)),
		...tag("diagnostics", n.diagnostics),
		...tag("failures", n.failures),
		...(usage ? [`<usage>${usage}</usage>`] : []),
		...(n.worktree ? [`<worktree>${tag("worktreePath", n.worktree.path)[0]}${tag("worktreeBranch", n.worktree.branch)[0]}</worktree>`] : []),
		"</task-notification>",
	].join("\n");
}

function capResult(text: string, cap: number, outputFile: string | undefined): string {
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n... (truncated ${text.length - cap} chars${outputFile ? `, full result in ${outputFile}` : ""})`;
}

/** `limited` names the limit that stopped the run, whatever its status. */
export function agentSummary(description: string, status: TaskNotification["status"], detail: { error?: string; byUser?: boolean; limited?: string } = {}): string {
	if (detail.limited) return `Agent "${description}" stopped at its ${detail.limited} limit (partial result)`;
	if (status === "completed") return `Agent "${description}" finished`;
	if (status === "failed") return `Agent "${description}" failed: ${detail.error ?? "unknown error"}`;
	return `Agent "${description}" was stopped${detail.byUser ? " by user" : ""}`;
}

export function workflowSummary(description: string, status: TaskNotification["status"], error?: string): string {
	if (status === "completed") return `Dynamic workflow "${description}" completed`;
	if (status === "failed") return `Dynamic workflow "${description}" failed: ${error ?? "unknown error"}`;
	return `Dynamic workflow "${description}" was stopped`;
}

export function workflowDiagnostics(transcriptDir: string, scriptPath: string, runId: string): string {
	return [
		`Per-agent results: ${transcriptDir}/journal.jsonl holds one {"type":"result",...} line per finished agent with its full return value.`,
		"If the result above is empty or unexpected, Read this file BEFORE diagnosing; do not assume the agents returned something.",
		`To re-run with edited post-processing: Workflow({scriptPath: '${scriptPath}', resumeFromRunId: '${runId}'}): the longest unchanged prefix of agent() calls replays from cache.`,
	].join("\n");
}

export function workflowRecovery(transcriptDir: string, scriptPath: string, runId: string): string {
	return `To resume after editing the script, call: Workflow({scriptPath: '${scriptPath}', resumeFromRunId: '${runId}'})\nAgent transcripts: ${transcriptDir}`;
}

export type JobEnd = { exitCode: number } | { error: string } | "stopped" | "interrupted";

export function jobSummary(description: string, end: JobEnd): string {
	const subject = `Background command "${description}"`;
	if (end === "stopped") return `${subject} was stopped`;
	if (end === "interrupted") return `${subject} was interrupted when Pi closed`;
	if ("error" in end) return `${subject} failed: ${end.error}`;
	return end.exitCode === 0 ? `${subject} completed (exit code 0)` : `${subject} failed with exit code ${end.exitCode}`;
}

export function agentLaunchedResult(launch: { agentId: string; outputFile: string; model?: string; limits?: string; queued?: boolean; sharesCwd?: boolean }): string {
	return [
		"Async agent launched successfully.",
		`agentId: ${launch.agentId} (internal ID; use SendMessage with to: '${launch.agentId}' to continue this agent)`,
		"It works in the background and you will be notified when it finishes. Until then you know nothing about its result: do not guess it, wait for it, or redo its work. Carry on with other work or answer the user.",
		`output_file: ${launch.outputFile}`,
		"Do not read this file while the agent runs; it is written when the agent finishes, and the notification carries the result.",
		...(launch.model ? [`Model: ${launch.model}`] : []),
		...(launch.limits ? [`Limits: ${launch.limits}`] : []),
		...(launch.queued ? ["Queued: 16 agents are running; this one starts when a slot frees."] : []),
		...(launch.sharesCwd ? ["Another agent that can write already works in this directory. For parallel code-writing agents, dispatch each with isolation: \"worktree\"."] : []),
	].join("\n");
}

/** `limited` is the summary of a run its limit stopped. */
export function agentForegroundResult(result: { text: string; agentId: string; limited?: string; limits?: string; worktree?: { path: string; branch: string }; usage: { subagentTokens: number; toolUses: number; durationMs: number } }): string {
	return [
		result.text || "(The agent finished without output.)",
		`agentId: ${result.agentId} (use SendMessage with to: '${result.agentId}' to continue this agent)`,
		...(result.limited ? [`Limited: ${result.limited}`] : []),
		...(result.limits ? [`Limits: ${result.limits}`] : []),
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

export const taskNotFound = (id: string): string => `No task found with ID: ${id}`;

export function jobLaunchedResult(id: string, outputFile: string, timeout?: number): string {
	return [
		`Command running in background with ID: ${id}. Output is being written to: ${outputFile}`,
		"You will be notified when it exits. Do not poll, sleep or wait for it; keep working, and read the output file once the notification arrives.",
		...(timeout ? [`Timeout: ${timeout} ms`] : []),
	].join("\n");
}

export function monitorStartedResult(id: string, baseline: string | undefined, until: string): string {
	return `Monitor started (task ${id}${baseline ? `; ${baseline}` : ""}). It runs until ${until}. You will be notified on each event. Keep working; do not poll or sleep. An event is not the user's reply.`;
}

export const monitorSummary = (description: string): string => `Monitor event: "${description}"`;
export const MONITOR_FLOODED = "[Monitor stopped — too much output. Arm it again with a tighter filter.]";
export const monitorExpired = (seconds: number, events: number): string => `[Monitor expired after ${seconds}s with ${events} events delivered. Re-arm it if you still need the watch.]`;
export const monitorSuppressed = (dropped: number, event: string): string => (dropped ? `[${dropped} events suppressed — output rate too high]\n${event}` : event);

export const unknownAgentResult = (to: string, known: string[]): string => `No agent named '${to}'. Known agents: ${known.join(", ") || "none"}`;

/** SendMessage's result; `refused` is its error. */
export function sendMessageResult(to: string, outcome: "steered" | "queued" | "resumed" | "refused"): string {
	if (outcome === "refused") return `Agent "${to}" was stopped by the user and was not resumed. Start a new agent for this work only if the user explicitly asks for it.`;
	if (outcome === "steered") return `Message queued for delivery to ${to} at its next tool round.`;
	return outcome === "queued" ? `Message queued for delivery to ${to} when its current run ends.` : `Resuming agent ${to}`;
}

export function workflowLaunchedResult(launch: { taskId: string; summary: string; transcriptDir: string; scriptPath: string; runId: string }): string {
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
