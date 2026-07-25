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
			return new Text(`${theme.fg("toolTitle", theme.bold("cron"))} ${theme.fg("accent", input.action)}${target ? ` ${theme.fg("muted", target)}` : ""}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as CronDetails | undefined;
			if (details?.task) return new Text(`${theme.fg("success", "scheduled")} ${renderTask(details.task, expanded, theme)}`, 0, 0);
			if (details?.tasks) {
				const rows = details.tasks.map((task) => renderTask(task, expanded, theme));
				return new Text(rows.length ? `${theme.fg("muted", `${rows.length} scheduled`)}\n${rows.join("\n")}` : theme.fg("dim", "No scheduled tasks"), 0, 0);
			}
			if (details?.deletedId) return new Text(`${theme.fg("success", "deleted")} ${theme.fg("accent", details.deletedId)}`, 0, 0);
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
			let [action, id] = args.trim().split(/\s+/, 2);
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
			if (!action && ctx.mode === "tui") {
				if (!tasks.length) return ctx.ui.notify("No cron tasks scheduled.", "info");
				const choices = new Map<string, string>(tasks.map((task) => [`${task.recurring ? "recurring" : "one-shot"} · ${task.id} · ${task.cron}`, task.id]));
				const chosen = await ctx.ui.select("Cron", [...choices.keys()]);
				if (!chosen) return;
				const chosenId = choices.get(chosen);
				if (!chosenId) return;
				action = chosenId;
				id = chosenId;
				const next = await ctx.ui.select(`Cron ${id}`, ["View details", "Delete task"]);
				if (!next) return;
				if (next === "Delete task") {
					const confirm = await ctx.ui.select(`Delete Cron ${id}?`, ["Keep task", "Delete task"]);
					if (confirm !== "Delete task") return;
					manager.delete(id!);
					ctx.ui.notify(`Deleted cron task ${id}.`, "info");
					return;
				}
			}
			const selected = action ? tasks.filter((task) => task.id === action || `${task.cron} ${task.prompt}`.toLowerCase().includes(action.toLowerCase())) : tasks;
			if (!selected.length && ctx.mode === "tui") {
				ctx.ui.notify(action ? `No cron tasks match ${JSON.stringify(action)}.` : "No cron tasks scheduled.", action ? "warning" : "info");
				return;
			}
			await showTextViewer(ctx, selected.length ? `Cron · ${selected.length} scheduled` : "Cron", formatList(selected));
		},
	});

	pi.registerMessageRenderer(CRON_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { taskId?: string; cron?: string; prompt?: string; recurring?: boolean; coalescedCount?: number; stale?: boolean } | undefined;
		const header = `${theme.fg(details?.stale ? "warning" : "accent", "cron fired")} · ${theme.fg("muted", details?.taskId ?? "unknown")} · ${details?.cron ?? "unknown schedule"}`;
		const count = details?.coalescedCount ?? 1;
		if (!expanded) return new Text(`${header}${count > 1 ? theme.fg("warning", ` · ${count} coalesced`) : ""}${details?.stale ? theme.fg("warning", " · final stale fire") : ""}`, 0, 0);
		return new Text([
			header,
			theme.fg("dim", `${details?.recurring ? "recurring" : "one-shot"} · ${count} occurrence${count === 1 ? "" : "s"}${details?.stale ? " · final stale fire" : ""}`),
			details?.prompt ? `${theme.fg("muted", "prompt")} ${details.prompt}` : "",
		].filter(Boolean).join("\n"), 0, 0);
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
		`${task.id}  ${task.humanSchedule}`,
		`  ${task.recurring ? "recurring" : "one-shot"}${task.stale ? " · stale final fire" : ""} · next ${task.nextFireAt === null ? "none" : formatLocalTime(task.nextFireAt)}`,
		`  ${task.cron}`,
		`  ${JSON.stringify(includePrompt ? task.prompt : preview(task.prompt))}`,
	].join("\n");
}

function renderTask(task: CronTaskView, expanded: boolean, theme: Theme): string {
	let text = `${theme.fg("accent", task.id)} · ${task.recurring ? "recurring" : "one-shot"} · ${theme.fg("muted", task.humanSchedule)}`;
	if (expanded) text += `\n  ${theme.fg("muted", "next")} ${task.nextFireAt === null ? "none" : formatLocalTime(task.nextFireAt)}\n  ${theme.fg("muted", "prompt")} ${task.prompt}`;
	return text;
}

function preview(value: string): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= 200) return value;
	let end = 200;
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
	return `${bytes.subarray(0, end).toString("utf8")}…`;
}

