import { expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { remindSilentTurns, SILENT_TURN_REMINDER } from "../extensions/subagents/silent-turns.ts";

type Handler = (event: Record<string, unknown>) => { entries?: Array<{ content?: unknown; display?: boolean }> } | undefined;

function lead() {
	const handlers = new Map<string, Handler>();
	remindSilentTurns({ on(name: string, handler: Handler) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
	const turn = (...content: Array<Record<string, unknown>>) => handlers.get("turn_end")!({ message: { role: "assistant", content }, toolResults: [{}], entries: [] })?.entries ?? [];
	return { turn, input: () => handlers.get("input")!({}) };
}

const tool = (name = "bash") => ({ type: "toolCall", id: "t", name, arguments: {} });
const silentTurns = (count: number, turn: ReturnType<typeof lead>["turn"]) => Array.from({ length: count }, () => turn(tool()).length);

it("reminds once after five silent turns, hidden and wrapped", () => {
	const { turn } = lead();
	expect(silentTurns(4, turn)).toEqual([0, 0, 0, 0]);
	expect(turn({ type: "thinking", thinking: "hmm" }, tool())).toEqual([{ type: "custom_message", customType: "silent-turn-reminder", content: SILENT_TURN_REMINDER, display: false }]);
	expect(SILENT_TURN_REMINDER).toMatch(/^<system-reminder>\n[\s\S]+\n<\/system-reminder>$/);
});

it("restarts the count on text or ask_user, and caps reminders at three between user messages", () => {
	const { turn, input } = lead();
	silentTurns(4, turn);
	turn({ type: "text", text: "Found it." }, tool());
	expect(silentTurns(4, turn)).toEqual([0, 0, 0, 0]);
	turn(tool("ask_user"));
	expect(silentTurns(20, turn).filter(Boolean)).toHaveLength(3);
	input();
	expect(silentTurns(5, turn)).toEqual([0, 0, 0, 0, 1]);
});
