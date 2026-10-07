import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChainCommands } from "./commands.ts";
import { ChainCheckpointService, registerChainCheckpoint } from "./checkpoint.ts";
import { ChainService } from "./service.ts";
import { registerChainTools } from "./register.ts";
import { claimSurface } from "../shared/surface.ts";

export default function chainsExtension(pi: ExtensionAPI): void {
	if (!claimSurface(pi, "chains")) return;

	const service = new ChainService(process.cwd());
	const checkpoints = new ChainCheckpointService(pi);
	registerChainTools(pi, service);
	registerChainCommands(pi, service, checkpoints);
	registerChainCheckpoint(pi, checkpoints);

	pi.on("session_start", async (_event, ctx) => {
		service.setCwd(ctx.cwd);
	});
}
