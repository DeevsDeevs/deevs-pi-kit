import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TodoState } from "./state.ts";
import { registerTodoTools } from "./tools.ts";
import { clearTodoWidget, updateTodoWidget } from "./ui.ts";

const SURFACE = Symbol.for("deevs-pi-kit.todos-surface");

export default function todosExtension(pi: ExtensionAPI): void {
	const global = globalThis as { [SURFACE]?: { active: boolean } };
	if (global[SURFACE]?.active) return;
	const surface = { active: true };
	global[SURFACE] = surface;

	const state = new TodoState();
	let currentCtx: ExtensionContext | undefined;
	const restore = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		state.loadFromSession(ctx);
		updateTodoWidget(ctx, state);
	};

	registerTodoTools(pi, state);

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("turn_start", async (_event, ctx) => {
		currentCtx = ctx;
	});
	pi.on("turn_end", async (_event, ctx) => updateTodoWidget(ctx, state));
	pi.on("session_shutdown", async () => {
		clearTodoWidget(currentCtx);
		surface.active = false;
	});
}
