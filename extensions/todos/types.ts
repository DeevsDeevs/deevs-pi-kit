export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";
export type TodoOperation = "read" | "write" | "clear";

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	notes?: string;
}

export interface TodoStats {
	total: number;
	pending: number;
	inProgress: number;
	done: number;
	blocked: number;
}

export interface TodoDetails {
	operation: TodoOperation;
	todos: TodoItem[];
	stats: TodoStats;
	error?: string;
}

export interface TodoListInput {
	operation: TodoOperation;
	todos?: TodoItem[];
}

export interface TodoValidationResult {
	valid: boolean;
	errors: string[];
}

export interface TodoPersistedState {
	todos: TodoItem[];
}
