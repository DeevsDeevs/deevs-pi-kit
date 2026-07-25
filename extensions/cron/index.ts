import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { showTextViewer } from "../shared/text-viewer.ts";
import { formatLocalTime } from "./cron.ts";
import { CRON_MESSAGE_TYPE, CronManager, type CronTaskView } from "./manager.ts";

const CronSchema = Type.Object({
	action: StringEnum(["create", "list", "delete"] as const),
	cron: Type.Optional(Type.String({ description: "Five-field local-time cron expression for create" })),
	prompt: Type.Optional(Type.String({ description: "Prompt to inject when the schedule fires; maximum 8 KiB" })),
	recurring: Type.Optional(Type.Boolean({ description: "Repeat until deleted/stale; default true. False fires once." })),
	id: Type.Optional(Type.String({ description: "Cron task id for delete" })),
});

type CronInput = {
	action: "create" | "list" | "delete";
	cron?: string;
	prompt?: string;
	recurring?: boolean;
	id?: string;
};

interface CronDetails {
	action: CronInput["action"];
	task?: CronTaskView;
	tasks?: CronTaskView[];
	deletedId?: string;
}

export default function cronExtension(pi: ExtensionAPI): void {
	const manager = new CronManager(pi);

	pi.registerTool({
		name: "cron",
		label: "Cron",
		description: "Create, list, or delete process-local schedules for the current Pi session. Fires while the session is open or when that same session resumes; not an OS scheduler.",
		promptSnippet: "Schedule a prompt in the current Pi session with cron create/list/delete actions.",
		promptGuidelines: [
			"Use cron only when the user requests a reminder or recurring action in this Pi session.",
			"Cron uses five local-time fields and cannot wake a closed Pi process; overdue fires coalesce when the same session resumes.",
			"Use recurring=false for one-shot reminders and cron action=delete to cancel a schedule.",
		],
		parameters: CronSchema,
		async execute(_toolCallId, input: CronInput): Promise<AgentToolResult<CronDetails>> {
			if (input.action === "create") {
				if (!input.cron || !input.prompt) throw new Error("cron create requires cron and prompt.");
				const task = manager.create({ cron: input.cron, prompt: input.prompt, recurring: input.recurring });
				return { content: [{ type: "text" as const, text: formatTask(task, true) }], details: { action: "create", task } };
			}
			if (input.action === "delete") {
				if (!input.id) throw new Error("cron delete requires id.");
				const task = manager.delete(input.id);
				return { content: [{ type: "text" as const, text: `Deleted cron task ${task.id}.` }], details: { action: "delete", deletedId: task.id } };
			}
			const tasks = manager.list();
			return { content: [{ type: "text" as const, text: formatList(tasks) }], details: { action: "list", tasks } };
		},
		renderCall(input: CronInput, theme: Theme) {
			const target = input.action === "create" ? input.cron ?? "invalid" : input.action === "delete" ? input.id ?? "invalid" : "";
			return new Text(theme.fg("toolTitle", theme.bold(`cron ${input.action} `)) + theme.fg("muted", target), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as CronDetails | undefined;
			if (details?.task) return new Text(renderTask(details.task, expanded, theme), 0, 0);
			if (details?.tasks) return new Text(details.tasks.length ? details.tasks.map((task) => renderTask(task, expanded, theme)).join("\n") : theme.fg("dim", "No cron tasks"), 0, 0);
			if (details?.deletedId) return new Text(theme.fg("success", `deleted ${details.deletedId}`), 0, 0);
			return new Text(theme.fg("dim", "Cron operation finished"), 0, 0);
		},
	});

	pi.registerCommand("cron", {
		description: "Browse or delete current-session cron tasks",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trimStart();
			const deleting = value.startsWith("delete ");
			const idPrefix = deleting ? value.slice(7) : value;
			return manager.list().map((task) => task.id).filter((id) => id.startsWith(idPrefix)).map((id) => ({ value: deleting ? `delete ${id}` : id, label: id }));
		},
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/, 2);
			if (action === "delete" && !id) {
				ctx.ui.notify("Usage: /cron delete <id>", "warning");
				return;
			}
			if (action === "delete" && id) {
				try {
					manager.delete(id);
					ctx.ui.notify(`Deleted cron task ${id}.`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			const tasks = manager.list();
			const selected = action ? tasks.filter((task) => task.id === action || `${task.cron} ${task.prompt}`.toLowerCase().includes(action.toLowerCase())) : tasks;
			await showTextViewer(ctx, "Cron", formatList(selected));
		},
	});

	pi.registerMessageRenderer(CRON_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { taskId?: string; cron?: string; recurring?: boolean; coalescedCount?: number; stale?: boolean } | undefined;
		const header = `${theme.fg("warning", "cron fired")} ${theme.fg("accent", details?.taskId ?? "unknown")} ${theme.fg("muted", details?.cron ?? "")}`;
		if (!expanded) return new Text(`${header}${details?.coalescedCount && details.coalescedCount > 1 ? ` · ${details.coalescedCount} coalesced` : ""}${details?.stale ? " · stale final fire" : ""}`, 0, 0);
		const content = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		return new Text(`${header}\n${theme.fg("dim", content)}`, 0, 0);
	});

	pi.on("session_start", (_event, ctx) => manager.restore(ctx));
	pi.on("agent_settled", () => manager.tick());
	pi.on("message_start", (event) => manager.messageStarted(event.message));
	pi.on("session_shutdown", () => manager.dispose());
}

function formatList(tasks: CronTaskView[]): string {
	if (!tasks.length) return "No cron tasks scheduled.";
	return tasks.map((task) => formatTask(task, false)).join("\n\n");
}

function formatTask(task: CronTaskView, includePrompt: boolean): string {
	return [
		`${task.id} · ${task.humanSchedule} · ${task.recurring ? "recurring" : "one-shot"}${task.stale ? " · stale" : ""}`,
		`cron: ${task.cron}`,
		`next: ${task.nextFireAt === null ? "none" : formatLocalTime(task.nextFireAt)}`,
		`prompt: ${JSON.stringify(includePrompt ? task.prompt : preview(task.prompt))}`,
	].join("\n");
}

function renderTask(task: CronTaskView, expanded: boolean, theme: Theme): string {
	let text = `${theme.fg(task.stale ? "warning" : "success", task.recurring ? "recurring" : "one-shot")} ${theme.fg("accent", task.id)} · ${theme.fg("muted", task.humanSchedule)}`;
	if (expanded) text += `\n${task.cron}\nnext ${task.nextFireAt === null ? "none" : formatLocalTime(task.nextFireAt)}\n${task.prompt}`;
	return text;
}

function preview(value: string): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= 200) return value;
	let end = 200;
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
	return `${bytes.subarray(0, end).toString("utf8")}…`;
}

