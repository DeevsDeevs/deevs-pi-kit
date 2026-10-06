import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export type TaskKind = "agent" | "workflow" | "job" | "monitor" | "collaborator";
export type TaskStatus = "running" | "completed" | "failed" | "killed" | "paused";

export interface RosterEntry {
	id: string;
	kind: TaskKind;
	name?: string;
	description: string;
	status: TaskStatus;
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

const TASK_NOTIFICATION = "task-notification";
const RESULT_LIMIT = 100_000;
const Delivered = Type.Object({ type: Type.Literal("custom_message"), customType: Type.Literal(TASK_NOTIFICATION), details: Type.Object({ notificationId: Type.String() }) });
const NOTE = "A task-notification fires each time this agent stops; a later message can resume it, so the same task-id may notify more than once.";

interface State {
	roster: Map<string, RosterEntry>;
	sources: Map<string, NotificationSource>;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	session?: string;
	/** Sent in this process since the last check against the session file. */
	sent: Set<string>;
}

// Pi loads each extension with its own module graph; one roster must serve them all, across /reload.
const KEY = Symbol.for("pi-kit.tasks");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores this state in it.
const slot = globalThis as typeof globalThis & { [KEY]?: State };
const state: State = slot[KEY] ??= { roster: new Map(), sources: new Map(), sent: new Set() };

export const tasks = {
	install(pi: ExtensionAPI): void {
		state.pi = pi;
		const latest = () => state.pi === pi;
		pi.on("session_start", async (_event, ctx) => {
			state.ctx = ctx;
			state.session = ctx.sessionManager.getSessionId();
			if (!latest()) return;
			state.sent.clear();
			await redeliver();
		});
		pi.on("agent_settled", async (_event, ctx) => {
			state.ctx = ctx;
			if (!latest()) return;
			state.sent.clear();
			await redeliver();
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
		return entries.find((entry) => entry.id === idOrName) ?? entries.filter((entry) => entry.name === idOrName).at(-1);
	},
	addSource(source: NotificationSource): void {
		state.sources.set(source.name, source);
	},
	async notify(n: TaskNotification): Promise<void> {
		if (n.ownerSession !== state.session || state.sent.has(n.notificationId) || delivered().has(n.notificationId)) return;
		send(n);
	},
};

function send(n: TaskNotification): void {
	if (!state.pi) return;
	state.sent.add(n.notificationId);
	state.pi.sendMessage({ customType: TASK_NOTIFICATION, content: formatTaskNotification(n), display: true, details: { notificationId: n.notificationId } }, { triggerTurn: true, deliverAs: "steer" });
}

/** The session file is the ack: a notification counts as delivered once its id is among the session's custom messages. */
function delivered(): Set<string> {
	const ids = new Set<string>();
	for (const entry of state.ctx?.sessionManager.getEntries() ?? []) if (Value.Check(Delivered, entry)) ids.add(entry.details.notificationId);
	return ids;
}

async function redeliver(): Promise<void> {
	const session = state.session;
	if (!session) return;
	const done = delivered();
	for (const source of state.sources.values()) {
		for (const n of await source.pending(session).catch(() => [])) if (!done.has(n.notificationId) && !state.sent.has(n.notificationId)) send(n);
	}
}

/** Appendix A.5. Results are escaped at the markup level so they cannot open harness frames. */
export function formatTaskNotification(n: TaskNotification): string {
	const usage = n.usage && `<usage><subagent_tokens>${n.usage.subagentTokens ?? 0}</subagent_tokens><tool_uses>${n.usage.toolUses ?? 0}</tool_uses><duration_ms>${n.usage.durationMs ?? 0}</duration_ms></usage>`;
	return [
		"<task-notification>",
		`<task-id>${n.taskId}</task-id>`,
		n.toolUseId && `<tool-use-id>${n.toolUseId}</tool-use-id>`,
		n.outputFile && `<output-file>${n.outputFile}</output-file>`,
		`<status>${n.status}</status>`,
		`<summary>${escapeMarkup(n.summary)}</summary>`,
		n.limited && `<limited>${escapeMarkup(n.limited)}</limited>`,
		n.kind === "agent" && `<note>${NOTE}</note>`,
		n.result !== undefined && `<result>${escapeMarkup(n.result.slice(0, RESULT_LIMIT))}</result>`,
		usage,
		n.worktree && `<worktree><worktreePath>${n.worktree.path}</worktreePath><worktreeBranch>${n.worktree.branch}</worktreeBranch></worktree>`,
		"</task-notification>",
	].filter(Boolean).join("\n");
}

function escapeMarkup(text: string): string {
	return text.replace(/<(\/?)(task-notification|system-reminder)/g, "<\\$1$2").replace(/\[Workflow harness/g, "[\\Workflow harness");
}
