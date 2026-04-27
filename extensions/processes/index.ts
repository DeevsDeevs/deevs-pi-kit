import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerProcessCommands } from "./commands.ts";
import { claimProcessSurface, getProcessService } from "./service.ts";
import { createProcessFooterStatus } from "./status.ts";
import { registerProcessTools } from "./tools.ts";

export default function deevsProcessesExtension(pi: ExtensionAPI): void {
	const service = getProcessService(pi);
	if (!claimProcessSurface(service)) return;
	registerProcessTools(pi, service.manager);
	registerProcessCommands(pi, service.manager, service.processUi);

	const footerStatus = createProcessFooterStatus(service.manager);
	pi.on("session_start", async (_event, ctx) => footerStatus.start(ctx));
	pi.on("session_shutdown", async (_event, ctx) => footerStatus.stop(ctx));
}
