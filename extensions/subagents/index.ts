import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getProcessService } from "../processes/service.ts";
import { registerSubagentCommands } from "./commands.ts";
import { SubagentManager } from "./manager.ts";
import { registerSubagentTools } from "./tools.ts";
import { createSubagentsUi } from "./ui.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.subagents-surface");

interface SubagentsSurfaceState {
	active: boolean;
}

interface GlobalWithSubagentsSurface {
	[SURFACE_KEY]?: SubagentsSurfaceState;
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithSubagentsSurface;
	const existing = globalState[SURFACE_KEY];
	if (existing?.active) return;
	const surfaceState: SubagentsSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const { manager: processManager } = getProcessService(pi);
	const subagentManager = new SubagentManager(pi, processManager);
	const ui = createSubagentsUi(subagentManager);

	registerSubagentTools(pi, subagentManager);
	registerSubagentCommands(pi, subagentManager, ui);

	pi.on("session_start", async (_event, ctx) => {
		subagentManager.setContext(ctx);
	});

	pi.on("session_shutdown", async () => {
		surfaceState.active = false;
	});
}
