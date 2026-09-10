import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMessagingMcp } from "../../extensions/runtime/mcp/pi.ts";

// Transport-only probe. Production loads the same registrar through Runtime's default entry.
export default function (pi: ExtensionAPI): void {
	pi.registerFlag("runtime-mcp-descriptor", { type: "string", description: "Private test descriptor" });
	registerMessagingMcp(pi, fileURLToPath(import.meta.url), async () => {
		const path = pi.getFlag("runtime-mcp-descriptor");
		if (typeof path !== "string") throw new Error("Missing test descriptor");
		return path;
	});
}
