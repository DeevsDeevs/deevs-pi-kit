import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateWithSkill } from "../shared/skill-tools.ts";
import { ArxivService } from "./service.ts";
import { registerArxivTools } from "./tools.ts";

const SURFACE = Symbol.for("deevs-pi-kit.arxiv-surface");

export default function arxivExtension(pi: ExtensionAPI): void {
	const slot = globalThis as { [SURFACE]?: { active: boolean } };
	if (slot[SURFACE]?.active) return;
	const surface = { active: true };
	slot[SURFACE] = surface;

	registerArxivTools(pi, new ArxivService());
	activateWithSkill(pi, "arxiv", "arxiv");

	pi.on("session_shutdown", async () => {
		surface.active = false;
	});
}
