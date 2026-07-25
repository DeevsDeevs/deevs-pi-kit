import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { TODO_TOOL_NAME, type TodoState } from "./state.ts";
import type { TodoDetails, TodoListInput, TodoStatus } from "./types.ts";
import { formatTodoText, updateTodoWidget } from "./ui.ts";

const TodoItemSchema = Type.Object({
	id: Type.String({ description: "Stable short id, usually 1, 2, 3...; keep the same id when updating" }),
	title: Type.String({ description: "Concise action-oriented todo title" }),
	status: StringEnum(["pending", "in_progress", "done", "blocked"] as const, { description: "Current todo state" }),
	notes: Type.Optional(Type.String({ description: "Optional blocker, acceptance criterion, file path, or short context" })),
});

const TodoListSchema = Type.Object({
	operation: StringEnum(["read", "write", "clear"] as const, { description: "read current todos; write replaces the complete list; clear removes all todos" }),
	todos: Type.Optional(Type.Array(TodoItemSchema, { description: "Complete list for write; include all existing todos, not only changes" })),
});

export function registerTodoTools(pi: ExtensionAPI, state: TodoState): void {
	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Todo List",
		description: "Manage a compact session-scoped todo list for non-trivial multi-step work. Use for planning and progress tracking; avoid for trivial one-shot tasks.",
		promptSnippet: "Maintain a compact todo list for multi-step work.",
		promptGuidelines: [
			"Use for non-trivial multi-step implementation, review, research, or debugging work; do not use for one-step answers.",
			"Keep lists short and actionable, usually 3-8 items.",
			"Before starting a todo, write the complete list with that item marked in_progress; mark it done or blocked as soon as its outcome is known.",
			"Use blocked with a short notes reason instead of pretending progress is complete.",
			"write is a complete replacement: include every todo, preserving stable ids.",
		],
		parameters: TodoListSchema,
		async execute(_toolCallId, params: TodoListInput, _signal, _onUpdate, ctx) {
			if (params.operation === "read") return result("read", state, false, ctx);
			if (params.operation === "clear") {
				state.clear();
				updateTodoWidget(ctx, state.read(), state.stats());
				return result("clear", state, false, ctx, "Todos cleared.");
			}

			const validation = state.validate(params.todos);
			if (!validation.valid) {
				const details: TodoDetails = { operation: "write", todos: state.read(), stats: state.stats(), error: validation.errors.join("; ") };
				return { content: [{ type: "text" as const, text: `Todo validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}` }], details, isError: true };
			}
			state.write(params.todos ?? []);
			updateTodoWidget(ctx, state.read(), state.stats());
			return result("write", state, false, ctx);
		},
		renderCall(args: TodoListInput, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold(`${TODO_TOOL_NAME} `)) + theme.fg("muted", args.operation);
			if (args.todos) text += theme.fg("dim", ` (${args.todos.length})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.error) return new Text(theme.fg("error", `todo error: ${details.error}`), 0, 0);
			if (details.todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
			let text = theme.fg("success", "✓ ") + theme.fg("muted", `${details.stats.done}/${details.stats.total} done`);
			const visible = expanded ? details.todos : details.todos.slice(0, 5);
			for (const todo of visible) text += `\n  ${renderIcon(todo.status, theme)} ${theme.fg("accent", `${todo.id}.`)} ${renderTitle(todo.status, todo.title, theme)}`;
			if (!expanded && details.todos.length > visible.length) text += `\n${theme.fg("dim", `  … ${details.todos.length - visible.length} more`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.on("turn_end", async (_event, ctx) => updateTodoWidget(ctx, state.read(), state.stats()));
	pi.on("session_tree", async (_event, ctx) => updateTodoWidget(ctx, state.read(), state.stats()));
}

function result(operation: TodoDetails["operation"], state: TodoState, isError: boolean, ctx: ExtensionContext, overrideText?: string) {
	const todos = state.read();
	const stats = state.stats();
	updateTodoWidget(ctx, todos, stats);
	const text = overrideText ?? (todos.length ? formatTodoText(todos, stats) : "No todos.");
	const details: TodoDetails = { operation, todos, stats };
	return { content: [{ type: "text" as const, text }], details, isError };
}

function renderIcon(status: TodoStatus, theme: Theme): string {
	if (status === "done") return theme.fg("success", "✓");
	if (status === "in_progress") return theme.fg("warning", "◉");
	if (status === "blocked") return theme.fg("error", "!");
	return theme.fg("dim", "○");
}

function renderTitle(status: TodoStatus, title: string, theme: Theme): string {
	if (status === "done") return theme.fg("dim", title);
	if (status === "in_progress") return theme.fg("warning", title);
	if (status === "blocked") return theme.fg("error", title);
	return theme.fg("muted", title);
}
