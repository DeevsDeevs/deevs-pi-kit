import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SILENT_TURNS = 5;
const MAX_REMINDERS = 3;
const USER_CHANNEL_TOOLS = new Set(["ask_user"]);
export const SILENT_TURN_REMINDER = "<system-reminder>\nThe user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.\n</system-reminder>";

/** After 5 assistant turns in a row without text for the user, one hidden reminder; at most 3 between user messages. */
export function remindSilentTurns(pi: ExtensionAPI): void {
	let silent = 0;
	let reminders = 0;
	const reset = (): void => {
		silent = 0;
		reminders = 0;
	};
	pi.on("session_start", reset);
	pi.on("input", reset);
	pi.on("turn_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (spoke(event.message)) {
			silent = 0;
			return;
		}
		if (++silent < SILENT_TURNS || reminders >= MAX_REMINDERS || !event.toolResults.length) return;
		silent = 0;
		reminders++;
		return { entries: [...event.entries, { type: "custom_message", customType: "silent-turn-reminder", content: SILENT_TURN_REMINDER, display: false }] };
	});
}

function spoke(message: AssistantMessage): boolean {
	return message.content.some((block) => (block.type === "text" && block.text.trim() !== "") || (block.type === "toolCall" && USER_CHANNEL_TOOLS.has(block.name)));
}
