import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoDetails, TodoItem, TodoPersistedState, TodoStats } from "./types.ts";

export const TODO_TOOL_NAME = "todo_list";
// The removed /todos clear command wrote this entry; sessions saved before then still carry it.
const TODO_CUSTOM_TYPE = "deevs-todos-state";
const MAX_TODOS = 40;
const MAX_TITLE_LENGTH = 120;
const MAX_NOTES_LENGTH = 1000;

export class TodoState {
	private todos: TodoItem[] = [];

	read(): TodoItem[] {
		return this.todos.map((todo) => ({ ...todo }));
	}

	write(todos: TodoItem[]): void {
		this.todos = todos.map(normalizeTodo);
	}

	clear(): void {
		this.todos = [];
	}

	stats(): TodoStats {
		return {
			total: this.todos.length,
			pending: this.todos.filter((todo) => todo.status === "pending").length,
			inProgress: this.todos.filter((todo) => todo.status === "in_progress").length,
			done: this.todos.filter((todo) => todo.status === "done").length,
			blocked: this.todos.filter((todo) => todo.status === "blocked").length,
		};
	}

	loadFromSession(ctx: ExtensionContext): void {
		this.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role === "toolResult" && msg.toolName === TODO_TOOL_NAME) {
					// SAFETY: only this tool writes these results; the array check skips older or damaged entries.
					const details = msg.details as TodoDetails | undefined;
					if (Array.isArray(details?.todos)) this.write(details.todos);
				}
			} else if (entry.type === "custom" && entry.customType === TODO_CUSTOM_TYPE) {
				// SAFETY: only this extension writes this entry type; the array check skips older or damaged entries.
				const data = entry.data as TodoPersistedState | undefined;
				if (Array.isArray(data?.todos)) this.write(data.todos);
			}
		}
	}
}

/** The limits the tool schema cannot express; Pi has already checked each item's shape and status against it. */
export function validateTodos(todos: TodoItem[] | undefined): string[] {
	if (!todos) return ["todos must be an array for write"];
	const errors: string[] = [];
	if (todos.length > MAX_TODOS) errors.push(`too many todos: ${todos.length}; max ${MAX_TODOS}`);
	const ids = new Set<string>();
	todos.forEach((todo, index) => {
		const prefix = `todo ${index + 1}`;
		if (!todo.id) errors.push(`${prefix}: id is required and must be a string`);
		else if (ids.has(todo.id)) errors.push(`${prefix}: duplicate id ${todo.id}`);
		else ids.add(todo.id);
		if (!todo.title) errors.push(`${prefix}: title is required and must be a string`);
		else if (todo.title.trim().length > MAX_TITLE_LENGTH) errors.push(`${prefix}: title exceeds ${MAX_TITLE_LENGTH} chars`);
		if (todo.notes && todo.notes.length > MAX_NOTES_LENGTH) errors.push(`${prefix}: notes exceed ${MAX_NOTES_LENGTH} chars`);
	});
	return errors;
}

function normalizeTodo(todo: TodoItem): TodoItem {
	const normalized: TodoItem = {
		id: todo.id.trim(),
		title: todo.title.replace(/\s+/g, " ").trim(),
		status: todo.status,
	};
	const notes = todo.notes?.trim();
	if (notes) normalized.notes = notes;
	return normalized;
}
