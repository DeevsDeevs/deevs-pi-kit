import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTodoCommands } from "./commands.ts";
import { TodoState } from "./state.ts";
import { registerTodoTools } from "./tools.ts";
import { clearTodoWidget, updateTodoWidget } from "./ui.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.todos-surface");

interface TodosSurfaceState { active: boolean }
interface GlobalWithTodosSurface { [SURFACE_KEY]?: TodosSurfaceState }

export default function todosExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithTodosSurface;
	const existing = globalState[SURFACE_KEY];
	if (existing?.active) return;
	const surfaceState: TodosSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const state = new TodoState();
	let currentCtx: ExtensionContext | undefined;
	const setContext = (ctx: ExtensionContext) => {
		currentCtx = ctx;
	};
	const restore = (ctx: ExtensionContext) => {
		setContext(ctx);
		state.loadFromSession(ctx);
		updateTodoWidget(ctx, state.read(), state.stats());
	};

	registerTodoTools(pi, state);
	registerTodoCommands(pi, state, setContext);

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("turn_start", async (_event, ctx) => setContext(ctx));
	pi.on("session_shutdown", async () => {
		clearTodoWidget(currentCtx);
		surfaceState.active = false;
	});
}
