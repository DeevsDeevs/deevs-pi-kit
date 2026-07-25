import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChainCommands } from "./commands.ts";
import { ChainCheckpointService, chainCheckpoints, registerChainCheckpoint } from "./checkpoint.ts";
import { ChainService } from "./service.ts";
import { registerChainTools } from "./tools.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.chains-surface");

interface ChainsSurfaceState {
	active: boolean;
}

interface GlobalWithChainsSurface {
	[SURFACE_KEY]?: ChainsSurfaceState;
}

export default function chainsExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithChainsSurface;
	const existing = globalState[SURFACE_KEY];
	if (existing?.active) return;
	const surfaceState: ChainsSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const service = new ChainService(process.cwd());
	const checkpoints = new ChainCheckpointService(pi);
	chainCheckpoints.current = checkpoints;
	registerChainTools(pi, service);
	registerChainCommands(pi, service);
	registerChainCheckpoint(pi, checkpoints);

	pi.on("session_start", async (_event, ctx) => {
		service.setCwd(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		if (chainCheckpoints.current === checkpoints) chainCheckpoints.current = undefined;
		surfaceState.active = false;
	});
}
