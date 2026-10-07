import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerChainCommands } from "../extensions/chains/commands.ts";
import type { ChainService } from "../extensions/chains/service.ts";
import {
	CHAIN_CHECKPOINT_ENTRY,
	ChainCheckpointService,
	emptyChainCheckpoint,
	reduceChainCheckpoint,
	replayChainCheckpoint,
	registerChainCheckpoint,
} from "../extensions/chains/checkpoint.ts";

describe("Chain checkpoint state", () => {
	it("tracks active, due, saved, and waived states through replay", () => {
		let state = emptyChainCheckpoint();
		state = reduceChainCheckpoint(state, { type: "activate", chain: "kit", branch: "main", at: 1 });
		state = reduceChainCheckpoint(state, { type: "due", reason: "files changed", at: 2 });
		expect(state.status).toBe("due");
		state = reduceChainCheckpoint(state, { type: "saved", chain: "kit", branch: "main", link: "checkpoint.md", at: 3 });
		expect(state).toMatchObject({ status: "saved", dueReasons: [] });
		state = reduceChainCheckpoint(state, { type: "due", reason: "new decision", at: 4 });
		state = reduceChainCheckpoint(state, { type: "saved", chain: "kit", branch: "main", link: "stale.md", at: 2 });
		expect(state).toMatchObject({ status: "due", dueReasons: ["new decision"] });

		const replayed = replayChainCheckpoint([
			{ type: "custom", customType: CHAIN_CHECKPOINT_ENTRY, data: { type: "activate", chain: "kit", branch: "main", at: 1 } },
			{ type: "custom", customType: CHAIN_CHECKPOINT_ENTRY, data: { type: "due", reason: "review adjudicated", at: 2 } },
		]);
		expect(replayed).toMatchObject({ chain: "kit", branch: "main", status: "due", dueReasons: ["review adjudicated"] });
		// Sessions recorded before the waiver command was removed still replay their waivers.
		expect(replayChainCheckpoint([
			{ type: "custom", customType: CHAIN_CHECKPOINT_ENTRY, data: { type: "due", reason: "review adjudicated", at: 2 } },
			{ type: "custom", customType: CHAIN_CHECKPOINT_ENTRY, data: { type: "waived", reason: "old", at: 3 } },
		])).toMatchObject({ status: "saved", dueReasons: [] });
	});

	it("rejects malformed persisted operations instead of casting them into state", () => {
		const replayed = replayChainCheckpoint([
			{ type: "custom", customType: CHAIN_CHECKPOINT_ENTRY, data: { type: "saved", chain: "kit", branch: "main", link: { unsafe: true }, at: 1 } },
		]);
		expect(replayed).toEqual(emptyChainCheckpoint());
	});

	it("reminds once per 80% crossing, also across a reload, with chain loaded, never blocks a tool, and gives a commit or fork no reminder", () => {
		const branch: Array<Record<string, unknown>> = [];
		const handlers = new Map<string, (...args: any[]) => unknown>();
		let percent = 85;
		let active = ["read"];
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (tools: string[]) => { active = tools; },
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
			registerEntryRenderer() {},
		} as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }),
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {} },
		} as unknown as ExtensionContext;
		const load = () => {
			const service = new ChainCheckpointService(pi);
			registerChainCheckpoint(pi, service);
			handlers.get("session_start")!({}, ctx);
			return service;
		};
		const run = (): string | undefined => {
			const event = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
			expect(handlers.get("before_agent_start")!(event, ctx)).toBeUndefined();
			return event.systemPromptOptions.sections.chain_checkpoint;
		};
		const chain = (toolCallId: string, args: Record<string, string>, result: unknown = {}) => {
			handlers.get("tool_execution_start")!({ toolCallId, toolName: "chain", args });
			handlers.get("tool_execution_end")!({ toolCallId, toolName: "chain", isError: false, result }, ctx);
		};
		let service = load();
		expect(handlers.has("tool_call")).toBe(false);
		expect(handlers.has("turn_start")).toBe(false);
		expect(run()).toContain("context reached 80%");
		expect(active).toEqual(["read", "chain"]);
		expect(run()).toBeUndefined();
		service = load();
		expect(run()).toBeUndefined();
		percent = 50;
		expect(run()).toBeUndefined();
		percent = 85;
		expect(run()).toContain("context reached 80%");
		expect(service.read()).toMatchObject({ status: "due", reminded: true, dueReasons: ["context usage reached 80%"] });

		chain("save", { action: "save", chain: "kit", branch: "main" }, { details: { link: { filename: "checkpoint.md" } } });
		expect(branch.at(-1)?.data).toMatchObject({ type: "saved", chain: "kit", branch: "main", link: "checkpoint.md" });
		chain("fork", { action: "fork", chain: "kit", branch: "alt" });
		expect(service.read()).toMatchObject({ chain: "kit", branch: "alt", status: "saved" });
		expect(run()).toBeUndefined();

		percent = 50;
		handlers.get("session_compact")!({}, ctx);
		expect(service.read()).toMatchObject({ status: "saved", contextPressureHandled: false });
		expect(run()).toContain("Load it before rediscovery");
		expect(run()).toBeUndefined();
	});

	it("keeps colliding long Chain names separately visible in the dashboard", async () => {
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		const pi = { registerCommand(name: string, value: typeof command) { if (name === "chains") command = value; } } as unknown as ExtensionAPI;
		const chains = ["abcdefghijklmno-one-zzzzzz", "abcdefghijklmno-two-zzzzzz"].map((chain) => ({ chain, count: 1, branches: [], latest: { chain, branch: "main", filename: "latest.md", title: chain, nextStep: null, parent: null, createdAt: null, ageDays: 0, stale: false, bytes: 1 } }));
		registerChainCommands(pi, { list: async () => chains } as unknown as ChainService, new ChainCheckpointService(pi));
		let rendered = "";
		const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: { custom: async (factory: any) => { rendered = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, () => undefined).render(100).join("\n"); } },
		} as unknown as ExtensionContext;
		await command!.handler("", ctx);
		expect(rendered).toContain(chains[0]!.chain);
		expect(rendered).toContain(chains[1]!.chain);
	});
});
