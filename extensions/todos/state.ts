import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TodoDetails, TodoItem, TodoPersistedState, TodoStats, TodoValidationResult } from "./types.ts";

export const TODO_TOOL_NAME = "todo_list";
export const TODO_CUSTOM_TYPE = "deevs-todos-state";
const MAX_TODOS = 40;
const MAX_TITLE_LENGTH = 120;
const MAX_NOTES_LENGTH = 1000;
const VALID_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);

export class TodoState {
	private todos: TodoItem[] = [];

	read(): TodoItem[] {
		return this.todos.map(cloneTodo);
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

	validate(todos: TodoItem[] | undefined): TodoValidationResult {
		const errors: string[] = [];
		if (!Array.isArray(todos)) return { valid: false, errors: ["todos must be an array for write"] };
		if (todos.length > MAX_TODOS) errors.push(`too many todos: ${todos.length}; max ${MAX_TODOS}`);

		const ids = new Set<string>();
		for (let index = 0; index < todos.length; index++) {
			const todo = todos[index] as Partial<TodoItem> | undefined;
			const prefix = `todo ${index + 1}`;
			if (!todo || typeof todo !== "object") {
				errors.push(`${prefix}: must be an object`);
				continue;
			}
			if (!todo.id || typeof todo.id !== "string") errors.push(`${prefix}: id is required and must be a string`);
			else if (ids.has(todo.id)) errors.push(`${prefix}: duplicate id ${todo.id}`);
			else ids.add(todo.id);

			if (!todo.title || typeof todo.title !== "string") errors.push(`${prefix}: title is required and must be a string`);
			else if (todo.title.trim().length > MAX_TITLE_LENGTH) errors.push(`${prefix}: title exceeds ${MAX_TITLE_LENGTH} chars`);

			if (!todo.status || !VALID_STATUSES.has(todo.status)) errors.push(`${prefix}: status must be pending, in_progress, done, or blocked`);
			if (todo.notes !== undefined && typeof todo.notes !== "string") errors.push(`${prefix}: notes must be a string when provided`);
			else if (todo.notes && todo.notes.length > MAX_NOTES_LENGTH) errors.push(`${prefix}: notes exceed ${MAX_NOTES_LENGTH} chars`);
		}
		return { valid: errors.length === 0, errors };
	}

	loadFromSession(ctx: ExtensionContext): void {
		this.clear();
		for (const entry of ctx.sessionManager.getBranch() as Array<any>) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg?.role === "toolResult" && msg.toolName === TODO_TOOL_NAME) {
					const details = msg.details as TodoDetails | undefined;
					if (Array.isArray(details?.todos)) this.write(details.todos);
				}
			} else if (entry.type === "custom" && entry.customType === TODO_CUSTOM_TYPE) {
				const data = entry.data as TodoPersistedState | undefined;
				if (Array.isArray(data?.todos)) this.write(data.todos);
			}
		}
	}
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

function cloneTodo(todo: TodoItem): TodoItem {
	return { ...todo };
}
