import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hcExtension from "../extensions/hc/index.ts";

afterEach(() => vi.unstubAllEnvs());

function start(append: string): string | undefined {
	let handler: ((event: { systemPromptOptions: { appendSystemPrompt: string } }) => void) | undefined;
	hcExtension({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	if (!handler) return undefined;
	const event = { systemPromptOptions: { appendSystemPrompt: append } };
	handler(event);
	handler(event);
	return event.systemPromptOptions.appendSystemPrompt;
}

it("appends the hc line once inside an hc terminal, and nothing outside one", () => {
	vi.stubEnv("HC_TERMINAL_ID", "");
	expect(start("")).toBeUndefined();
	vi.stubEnv("HC_TERMINAL_ID", "mac/t2");
	const line = "You run inside hc (`mac/t2`). For long-running work or other machines, load the `hc` skill; to run other agents (pi, Claude Code, Codex), the `hc-flow` skill.";
	expect(start("")).toBe(line);
	expect(start("user text")).toBe(`user text\n\n${line}`);
});
