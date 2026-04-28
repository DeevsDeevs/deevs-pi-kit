import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWikiCommands } from "./commands.ts";
import { WikiService } from "./service.ts";
import { registerWikiTools } from "./tools.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.wiki-surface");

interface WikiSurfaceState { active: boolean }
interface GlobalWithWikiSurface { [SURFACE_KEY]?: WikiSurfaceState }

export default function wikiExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithWikiSurface;
	const existing = globalState[SURFACE_KEY];
	if (existing?.active) return;
	const surfaceState: WikiSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const service = new WikiService(process.cwd());
	registerWikiTools(pi, service);
	registerWikiCommands(pi, service);

	pi.on("session_start", async (_event, ctx) => {
		service.setCwd(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		surfaceState.active = false;
	});
}
