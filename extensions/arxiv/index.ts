import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ArxivService } from "./service.ts";
import { registerArxivTools } from "./tools.ts";

const SURFACE = Symbol.for("deevs-pi-kit.arxiv-surface");

export default function arxivExtension(pi: ExtensionAPI): void {
	const global = globalThis as { [SURFACE]?: { active: boolean } };
	if (global[SURFACE]?.active) return;
	const surface = { active: true };
	global[SURFACE] = surface;

	registerArxivTools(pi, new ArxivService());

	pi.on("session_shutdown", async () => {
		surface.active = false;
	});
}
