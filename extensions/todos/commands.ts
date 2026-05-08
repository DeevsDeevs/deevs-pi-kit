import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TODO_CUSTOM_TYPE, type TodoState } from "./state.ts";
import type { TodoPersistedState } from "./types.ts";
import { clearTodoWidget, showTodoOverlay, updateTodoWidget } from "./ui.ts";

export function registerTodoCommands(pi: ExtensionAPI, state: TodoState, setContext: (ctx: ExtensionContext) => void): void {
	pi.registerCommand("todos", {
		description: "Show or clear the session todo list: /todos [clear]",
		handler: async (args, ctx) => {
			setContext(ctx);
			const action = args.trim().toLowerCase();
			if (action === "clear") {
				state.clear();
				pi.appendEntry<TodoPersistedState>(TODO_CUSTOM_TYPE, { todos: [] });
				clearTodoWidget(ctx);
				ctx.ui.notify("Todos cleared.", "info");
				return;
			}
			if (action && action !== "show" && action !== "list") {
				ctx.ui.notify("Usage: /todos [show|list|clear]", "warning");
				return;
			}
			const todos = state.read();
			const stats = state.stats();
			updateTodoWidget(ctx, todos, stats);
			await showTodoOverlay(ctx, todos, stats);
		},
	});
}
