import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getProcessService } from "../processes/service.ts";
import { applyAgentsSettings, loadAgentsSettings, saveAgentsSettings } from "./config.ts";
import { registerSubagentCommands } from "./commands.ts";
import { SubagentManager } from "./manager.ts";
import { registerSubagentTools } from "./tools.ts";
import { createSubagentsUi } from "./ui.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.subagents-surface");

interface SubagentsSurfaceState {
	active: boolean;
	unsubscribeStatus?: () => void;
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
	const ui = createSubagentsUi(subagentManager, (ctx) => saveAgentsSettings(ctx.cwd, subagentManager.settings));

	registerSubagentTools(pi, subagentManager);
	registerSubagentCommands(pi, subagentManager, ui);

	pi.on("session_start", async (_event, ctx) => {
		applyAgentsSettings(subagentManager.settings, await loadAgentsSettings(ctx.cwd));
		subagentManager.setContext(ctx);
		surfaceState.unsubscribeStatus?.();
		const updateStatus = () => updateFooterStatus(ctx, subagentManager);
		surfaceState.unsubscribeStatus = subagentManager.onChange(updateStatus);
		updateStatus();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		surfaceState.unsubscribeStatus?.();
		surfaceState.unsubscribeStatus = undefined;
		ctx.ui.setStatus("subagents", undefined);
		surfaceState.active = false;
	});
}

function updateFooterStatus(ctx: ExtensionContext, manager: SubagentManager): void {
	const status = manager.status({ includeCompleted: false });
	const running = status.runs.length;
	const groups = status.groups.length;
	const queued = status.groups.reduce((count, group) => count + group.pending.length, 0);
	if (running === 0 && groups === 0 && queued === 0) {
		ctx.ui.setStatus("subagents", undefined);
		return;
	}
	const parts = [`subagents: ${running} running`];
	if (queued > 0) parts.push(`${queued} queued`);
	if (groups > 0) parts.push(`${groups} group${groups === 1 ? "" : "s"}`);
	ctx.ui.setStatus("subagents", ctx.ui.theme.fg("accent", parts.join(" / ")));
}
