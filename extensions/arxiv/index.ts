import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateWithSkill, claimSurface } from "../shared/surface.ts";
import { ArxivService } from "./service.ts";
import { registerArxivTools } from "./tools.ts";

export default function arxivExtension(pi: ExtensionAPI): void {
	if (!claimSurface(pi, "arxiv")) return;
	registerArxivTools(pi, new ArxivService());
	activateWithSkill(pi, ["arxiv"], ["arxiv"]);
}
