import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectBackgroundBash } from "../processes/safety.ts";

export default function childSafetyRuntime(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;
		if (typeof command !== "string") return undefined;
		const reason = detectBackgroundBash(command);
		if (!reason) return undefined;
		return { block: true, reason };
	});
}
