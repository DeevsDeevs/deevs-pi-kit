import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateWithSkill, claimSurface } from "../shared/surface.ts";
import { WikiService } from "./service.ts";
import { registerWikiTools } from "./tools.ts";

export default function wikiExtension(pi: ExtensionAPI): void {
	if (!claimSurface(pi, "wiki")) return;
	const service = new WikiService(process.cwd());
	registerWikiTools(pi, service);
	activateWithSkill(pi, "wiki", "wiki");
	pi.on("session_start", async (_event, ctx) => {
		service.setCwd(ctx.cwd);
	});
}
