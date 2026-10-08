// Sandbox-only: `/polygon-reload` reloads every extension mid-run, as `/reload` does in the TUI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function polygonReload(pi: ExtensionAPI): void {
	pi.registerCommand("polygon-reload", { description: "Reload extensions (polygon only)", handler: (_args, ctx) => ctx.reload() });
}
