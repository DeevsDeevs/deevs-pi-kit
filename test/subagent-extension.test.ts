import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/subagents/index.ts";
import { getSubagentService } from "../extensions/subagents/registry.ts";

describe("Subagent extension surface", () => {
	it("registers only the compact public model tools", async () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
		const pi = {
			registerTool(tool: { name: string }) { tools.push(tool.name); },
			registerCommand(name: string) { commands.push(name); },
			on(event: string, handler: (...args: never[]) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;

		subagentsExtension(pi);
		expect(tools).toEqual(["subagent", "subagent_wait"]);
		expect(commands).toEqual(["agents"]);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler();
	});

	it("keeps the newest runtime registered when an older reload instance shuts down", async () => {
		const shutdowns: Array<() => void> = [];
		const makePi = () => ({
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: () => void) { if (event === "session_shutdown") shutdowns.push(handler); },
		}) as unknown as ExtensionAPI;
		subagentsExtension(makePi());
		const first = getSubagentService();
		subagentsExtension(makePi());
		const second = getSubagentService();
		expect(second).not.toBe(first);
		await shutdowns[0]?.();
		expect(getSubagentService()).toBe(second);
		await shutdowns[1]?.();
		expect(() => getSubagentService()).toThrow("not initialized");
	});

});
