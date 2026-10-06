import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WikiService } from "./service.ts";
import { registerWikiTools } from "./tools.ts";

const SURFACE = Symbol.for("deevs-pi-kit.wiki-surface");

export default function wikiExtension(pi: ExtensionAPI): void {
	const global = globalThis as { [SURFACE]?: { active: boolean } };
	if (global[SURFACE]?.active) return;
	const surface = { active: true };
	global[SURFACE] = surface;

	const service = new WikiService(process.cwd());
	registerWikiTools(pi, service);

	pi.on("session_start", async (_event, ctx) => {
		service.setCwd(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		surface.active = false;
	});
}
