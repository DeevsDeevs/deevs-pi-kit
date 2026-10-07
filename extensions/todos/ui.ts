import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoState } from "./state.ts";
import type { TodoItem, TodoStats, TodoStatus } from "./types.ts";

const WIDGET_ID = "deevs-todos";

export function updateTodoWidget(ctx: ExtensionContext, state: TodoState): void {
	if (!ctx.hasUI) return;
	const todos = state.read();
	const stats = state.stats();
	ctx.ui.setWidget(WIDGET_ID, todos.length ? (_tui, theme) => ({ render: (width) => renderTodoWidgetLines(todos, stats, theme, width), invalidate() {} }) : undefined);
}

export function clearTodoWidget(ctx: ExtensionContext | undefined): void {
	if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
}

export function formatTodoText(todos: TodoItem[], stats: TodoStats): string {
	if (todos.length === 0) return "No todos.";
	const lines = [`Todos: ${stats.done}/${stats.total} done (${stats.pending} pending, ${stats.inProgress} in progress, ${stats.blocked} blocked)`];
	for (const todo of todos) {
		const notes = todo.notes ? ` — ${todo.notes}` : "";
		lines.push(`${plainIcon(todo.status)} ${todo.id}. ${todo.title} [${todo.status}]${notes}`);
	}
	return lines.join("\n");
}

export function renderTodoWidgetLines(todos: TodoItem[], stats: TodoStats, theme: Theme, width: number): string[] {
	const active = stats.inProgress ? `, ${stats.inProgress} active` : "";
	const blocked = stats.blocked ? `, ${stats.blocked} blocked` : "";
	const lines = [truncateToWidth(`${theme.fg("accent", " Todos ")} ${theme.fg("muted", `${stats.done}/${stats.total} done${active}${blocked}`)}`, width)];
	for (const status of ["in_progress", "blocked"] as const) {
		const todo = todos.find((candidate) => candidate.status === status);
		if (todo) lines.push(truncateToWidth(formatTodoLine(todo, theme), width));
	}
	return lines;
}

function todoIcon(status: TodoStatus, theme: Theme): string {
	if (status === "done") return theme.fg("success", "✓");
	if (status === "in_progress") return theme.fg("warning", "◉");
	if (status === "blocked") return theme.fg("error", "!");
	return theme.fg("dim", "○");
}

export function formatTodoLine(todo: TodoItem, theme: Theme): string {
	const id = theme.fg("accent", `${todo.id}.`);
	const title = todo.status === "done"
		? theme.fg("dim", theme.strikethrough(todo.title))
		: todo.status === "in_progress"
			? theme.fg("warning", todo.title)
			: todo.status === "blocked"
				? theme.fg("error", todo.title)
				: theme.fg("text", todo.title);
	return `  ${todoIcon(todo.status, theme)} ${id} ${title}`;
}

function plainIcon(status: TodoStatus): string {
	if (status === "done") return "[x]";
	if (status === "in_progress") return "[*]";
	if (status === "blocked") return "[!]";
	return "[ ]";
}
