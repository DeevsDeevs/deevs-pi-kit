import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import { registerProcessCommands } from "./commands.ts";
import { ProcessManager } from "./manager.ts";
import { ensureSupportedPlatform } from "./runner.ts";
import { detectBackgroundBash } from "./safety.ts";
import { registerProcessTools } from "./tools.ts";

export default function deevsProcessesExtension(pi: ExtensionAPI): void {
	const config = defaultConfig;
	const manager = new ProcessManager(config);

	registerProcessTools(pi, manager);
	registerProcessCommands(pi, manager);

	pi.on("session_start", async (_event, ctx) => {
		try {
			ensureSupportedPlatform();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.on("session_shutdown", async (event) => {
		await manager.shutdown(event.reason);
	});

	pi.on("tool_call", async (event) => {
		if (!config.safety.blockBackgroundBash) return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;

		const command = event.input.command;
		if (typeof command !== "string") return undefined;

		const reason = detectBackgroundBash(command);
		if (!reason) return undefined;

		return { block: true, reason };
	});
}
