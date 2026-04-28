import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerArxivCommands } from "./commands.ts";
import { ArxivService } from "./service.ts";
import { registerArxivTools } from "./tools.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.arxiv-surface");

interface ArxivSurfaceState { active: boolean }
interface GlobalWithArxivSurface { [SURFACE_KEY]?: ArxivSurfaceState }

export default function arxivExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithArxivSurface;
	const existing = globalState[SURFACE_KEY];
	if (existing?.active) return;
	const surfaceState: ArxivSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const service = new ArxivService();
	registerArxivTools(pi, service);
	registerArxivCommands(pi, service);

	pi.on("session_shutdown", async () => {
		surfaceState.active = false;
	});
}
