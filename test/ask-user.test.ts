import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUserExtension from "../extensions/ask-user/index.ts";

function askUserTool(): { execute: (...args: unknown[]) => Promise<{ details: unknown }> } {
	let tool: ReturnType<typeof askUserTool> | undefined;
	askUserExtension({ registerTool(value: typeof tool) { tool = value; } } as unknown as ExtensionAPI);
	return tool!;
}

describe("ask_user mode behavior", () => {
	it("uses native RPC dialogs with the abort signal and no timeout instead of a TUI overlay", async () => {
		const tool = askUserTool();
		const calls: Array<{ method: string; options?: unknown }> = [];
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select(_title: string, _values: string[], options?: unknown) { calls.push({ method: "select", options }); return Promise.resolve("Yes"); },
				input() { calls.push({ method: "input" }); return Promise.resolve("typed"); },
				custom() { throw new Error("RPC must not open a TUI overlay"); },
			},
		} as unknown as ExtensionContext;
		const signal = new AbortController().signal;
		const result = await tool.execute("call", { questions: [{ question: "Proceed?", options: ["Yes", "No"] }] }, signal, undefined, ctx);
		expect((result.details as { cancelled: boolean }).cancelled).toBe(false);
		expect(calls[0]).toEqual({ method: "select", options: { signal } });
	});

	it.each([1, 2])("uses the same TUI overlay for %i question(s)", async (count) => {
		const tool = askUserTool();
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom(factory: (...args: unknown[]) => { handleInput(data: string): void }) {
					return new Promise((resolve) => {
						const component = factory(
							{ requestRender() {} },
							{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
							{},
							resolve,
						);
						for (let index = 0; index < count; index++) component.handleInput("\r");
					});
				},
			},
		} as unknown as ExtensionContext;
		const questions = Array.from({ length: count }, (_, index) => ({ question: `Question ${index + 1}?`, options: ["Yes", "No"] }));
		const result = await tool.execute("call", { questions }, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ cancelled: false, answers: questions.map((question) => ({ question: question.question, answer: "Yes" })) });
	});

	it("closes a TUI overlay when abort wins the factory race", async () => {
		const tool = askUserTool();
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				custom(factory: (...args: unknown[]) => unknown) {
					return new Promise((resolve) => setTimeout(() => factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						resolve,
					), 10));
				},
			},
		} as unknown as ExtensionContext;
		const controller = new AbortController();
		const pending = tool.execute("call", { questions: [{ question: "Proceed?", options: ["Yes"] }] }, controller.signal, undefined, ctx);
		controller.abort();
		await expect(pending).resolves.toMatchObject({ details: { cancelled: true, answers: [] } });
	});

	it("stops the RPC question sequence when aborted during a dialog", async () => {
		const tool = askUserTool();
		let selections = 0;
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select(_title: string, _values: string[], options?: { signal?: AbortSignal }) {
					selections++;
					return new Promise<undefined>((resolve) => options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
				},
				input() { throw new Error("input must not open after abort"); },
				custom() { throw new Error("RPC must not open a TUI overlay"); },
			},
		} as unknown as ExtensionContext;
		const controller = new AbortController();
		const pending = tool.execute("call", { questions: [{ question: "First?", options: ["Yes"] }, { question: "Second?", options: ["Yes"] }] }, controller.signal, undefined, ctx);
		controller.abort();
		const result = await pending;
		expect((result.details as { cancelled: boolean }).cancelled).toBe(true);
		expect(selections).toBe(1);
	});
});
