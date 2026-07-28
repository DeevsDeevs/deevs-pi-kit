import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { showTextViewer } from "../shared/text-viewer.ts";
import type { TodoItem, TodoStats } from "./types.ts";

const WIDGET_ID = "deevs-todos";

export function updateTodoWidget(ctx: ExtensionContext | undefined, todos: TodoItem[], stats: TodoStats): void {
	if (!ctx?.hasUI) return;
	if (todos.length === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => new TodoWidget(todos, stats, theme));
}

export function clearTodoWidget(ctx: ExtensionContext | undefined): void {
	if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
}

export async function showTodoOverlay(ctx: ExtensionContext, todos: TodoItem[], stats: TodoStats): Promise<void> {
	await showTextViewer(ctx, "Todos", formatTodoText(todos, stats));
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
	const lines: string[] = [];
	const active = stats.inProgress ? `, ${stats.inProgress} active` : "";
	const blocked = stats.blocked ? `, ${stats.blocked} blocked` : "";
	lines.push(truncateToWidth(`${theme.fg("accent", " Todos ")} ${theme.fg("muted", `${stats.done}/${stats.total} done${active}${blocked}`)}`, width));
	const visible = [todos.find((todo) => todo.status === "in_progress"), todos.find((todo) => todo.status === "blocked")].filter((todo, index, values): todo is TodoItem => !!todo && values.indexOf(todo) === index);
	for (const todo of visible) lines.push(truncateToWidth(formatTodoLine(todo, theme), width));
	return lines;
}

class TodoWidget implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly todos: TodoItem[], private readonly stats: TodoStats, private readonly theme: Theme) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines = renderTodoWidgetLines(this.todos, this.stats, this.theme, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function formatTodoLine(todo: TodoItem, theme: Theme): string {
	const icon = iconFor(todo.status, theme);
	const id = theme.fg("accent", `${todo.id}.`);
	const title = todo.status === "done"
		? theme.fg("dim", theme.strikethrough ? theme.strikethrough(todo.title) : todo.title)
		: todo.status === "in_progress"
			? theme.fg("warning", todo.title)
			: todo.status === "blocked"
				? theme.fg("error", todo.title)
				: theme.fg("text", todo.title);
	return `  ${icon} ${id} ${title}`;
}

function iconFor(status: string, theme: Theme): string {
	if (status === "done") return theme.fg("success", "✓");
	if (status === "in_progress") return theme.fg("warning", "◉");
	if (status === "blocked") return theme.fg("error", "!");
	return theme.fg("dim", "○");
}

function plainIcon(status: string): string {
	if (status === "done") return "[x]";
	if (status === "in_progress") return "[*]";
	if (status === "blocked") return "[!]";
	return "[ ]";
}
