import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStats } from "./types.ts";

const WIDGET_ID = "deevs-todos";
const MAX_WIDGET_TODOS = 8;

export function updateTodoWidget(ctx: ExtensionContext | undefined, todos: TodoItem[], stats: TodoStats): void {
	if (!ctx?.hasUI) return;
	if (todos.length === 0) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: Theme) => new TodoWidget(todos, stats, theme));
}

export function clearTodoWidget(ctx: ExtensionContext | undefined): void {
	if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
}

export async function showTodoOverlay(ctx: ExtensionContext, todos: TodoItem[], stats: TodoStats): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(formatTodoText(todos, stats), "info");
		return;
	}
	await ctx.ui.custom<void>((_tui: any, theme: Theme, _kb: any, done) => new TodoOverlay(todos, stats, theme, () => done(undefined)), {
		overlay: true,
		overlayOptions: { width: "70%", minWidth: 48, maxHeight: "80%", anchor: "center", margin: 1 },
	});
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

class TodoWidget implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly todos: TodoItem[], private readonly stats: TodoStats, private readonly theme: Theme) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines: string[] = [];
		const active = this.stats.inProgress ? `, ${this.stats.inProgress} active` : "";
		const blocked = this.stats.blocked ? `, ${this.stats.blocked} blocked` : "";
		lines.push(truncateToWidth(`${this.theme.fg("accent", " Todos ")} ${this.theme.fg("muted", `${this.stats.done}/${this.stats.total} done${active}${blocked}`)}`, width));
		for (const todo of this.todos.slice(0, MAX_WIDGET_TODOS)) lines.push(truncateToWidth(formatTodoLine(todo, this.theme), width));
		if (this.todos.length > MAX_WIDGET_TODOS) lines.push(truncateToWidth(this.theme.fg("dim", `  … ${this.todos.length - MAX_WIDGET_TODOS} more`), width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

class TodoOverlay implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly todos: TodoItem[], private readonly stats: TodoStats, private readonly theme: Theme, private readonly done: () => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) this.done();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const lines: string[] = [];
		lines.push(truncateToWidth(this.header(width), width));
		lines.push("");
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No todos for this session.")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${this.theme.fg("muted", `${this.stats.done}/${this.stats.total} done · ${this.stats.pending} pending · ${this.stats.inProgress} active · ${this.stats.blocked} blocked`)}`, width));
			lines.push("");
			for (const todo of this.todos) {
				lines.push(truncateToWidth(formatTodoLine(todo, this.theme), width));
				if (todo.notes) lines.push(truncateToWidth(`      ${this.theme.fg("dim", todo.notes)}`, width));
			}
		}
		lines.push("");
		lines.push(truncateToWidth(`  ${this.theme.fg("dim", "Press q or Escape to close · /todos clear to reset")}`, width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private header(width: number): string {
		const title = this.theme.fg("accent", this.theme.bold(" Todo List "));
		const left = this.theme.fg("borderMuted", "─".repeat(3));
		const right = this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 16)));
		return `${left}${title}${right}`;
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
