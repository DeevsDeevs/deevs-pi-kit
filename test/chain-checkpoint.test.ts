import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerChainCommands } from "../extensions/chains/commands.ts";
import type { ChainService } from "../extensions/chains/service.ts";
import {
	CHAIN_CHECKPOINT_ENTRY,
	ChainCheckpointService,
	chainCheckpoints,
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
	});

	it("marks a new repository commit without treating ordinary edits as milestones", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const statuses: Array<string | undefined> = [];
		const heads = ["before\n", "before\n", "before\n", "after\n"];
		const pi = {
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			exec: async (_command: string, args: string[]) => args[0] === "merge-base"
				? { code: 0, stdout: "", stderr: "" }
				: { code: 0, stdout: heads.shift() ?? "after\n", stderr: "" },
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: { getBranch: () => branch },
			ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
		} as unknown as ExtensionContext;
		const service = new ChainCheckpointService(pi);
		service.restore(ctx);
		service.activate("kit", "main");
		await service.captureGitBeforeTurn("/tmp/project");
		await service.detectGitMutation("/tmp/project");
		expect(service.read().status).toBe("idle");
		await service.captureGitBeforeTurn("/tmp/project");
		await service.detectGitMutation("/tmp/project");

		expect(service.read().status).toBe("due");
		expect(service.read().dueReasons).toContain("repository HEAD advanced");
		expect(statuses.at(-1)).toBe("chain due");
		expect(service.beforeAgentStart("base")).toContain("checkpoint is due");
		service.due("Mission milestone recorded");
		expect(service.beforeAgentStart("base")).toContain("call chain_save before starting further substantive work");
	});

	it("forces one immediate Chain checkpoint when context reaches 80 percent", () => {
		const branch: Array<Record<string, unknown>> = [];
		const messages: Array<{ message: unknown; options: unknown }> = [];
		let compactCalls = 0;
		let percent = 79;
		let idle = true;
		const pi = {
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
		} as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: 80, contextWindow: 100, percent }),
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {} },
			isIdle: () => idle,
			hasPendingMessages: () => !idle,
			compact: () => { compactCalls++; },
		} as unknown as ExtensionContext;
		const service = new ChainCheckpointService(pi);
		service.activate("kit", "main");
		service.checkContextPressure(ctx);
		expect(service.read().status).toBe("idle");
		percent = 80;
		service.checkContextPressure(ctx);
		expect(service.read().dueReasons).toEqual(["context usage reached 80%"]);
		expect(service.beforeAgentStart("base")).toContain("before any other work");
		expect(service.blockTool("read")).toContain("chain_save before using any other tool");
		expect(service.blockTool("chain_save")).toBeUndefined();
		service.forceCheckpointTurn(ctx);
		service.forceCheckpointTurn(ctx);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		service.saved("kit", "main", "checkpoint.md");
		expect(service.blockTool("read")).toBeUndefined();
		percent = 90;
		idle = false;
		expect(service.maybeAutoCompact(ctx)).toBe(false);
		expect(service.maybeAutoCompact(ctx, true)).toBe(true);
		expect(service.maybeAutoCompact(ctx, true)).toBe(false);
		expect(compactCalls).toBe(1);
		percent = 95;
		const reloaded = new ChainCheckpointService(pi);
		reloaded.restore(ctx);
		reloaded.checkContextPressure(ctx);
		expect(reloaded.read().status).toBe("saved");
		reloaded.contextCompacted();
		reloaded.checkContextPressure(ctx);
		expect(reloaded.read().status).toBe("due");
	});

	it("compacts immediately after the 80% checkpoint is saved during an active turn", () => {
		const branch: Array<Record<string, unknown>> = [];
		const handlers = new Map<string, (...args: any[]) => unknown>();
		let compactCalls = 0;
		let percent = 80;
		const pi = {
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
			registerEntryRenderer() {},
		} as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }),
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {} }, isIdle: () => false, hasPendingMessages: () => true,
			compact: () => { compactCalls++; },
		} as unknown as ExtensionContext;
		const service = new ChainCheckpointService(pi);
		registerChainCheckpoint(pi, service);
		service.activate("kit", "main");
		service.checkContextPressure(ctx);
		handlers.get("tool_execution_start")!({ toolCallId: "save-1", args: { chain: "kit", branch: "main" } });
		percent = 90;
		handlers.get("tool_execution_end")!({ toolCallId: "save-1", toolName: "chain_save", isError: false, result: { details: { link: { filename: "checkpoint.md" } } } }, ctx);
		expect(service.read().status).toBe("saved");
		expect(compactCalls).toBe(1);
	});

	it("does not auto-compact a waived context-pressure checkpoint", () => {
		const branch: Array<Record<string, unknown>> = [];
		let compactCalls = 0;
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {} }, isIdle: () => true, hasPendingMessages: () => false,
			compact: () => { compactCalls++; },
		} as unknown as ExtensionContext;
		const service = new ChainCheckpointService(pi);
		service.activate("kit", "main");
		service.checkContextPressure(ctx);
		service.waive("user accepted risk");
		service.maybeAutoCompact(ctx);
		expect(compactCalls).toBe(0);
	});

	it("keeps colliding long Chain names separately visible in the dashboard", async () => {
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		const pi = { registerCommand(name: string, value: typeof command) { if (name === "chains") command = value; } } as unknown as ExtensionAPI;
		const chains = ["abcdefghijklmno-one-zzzzzz", "abcdefghijklmno-two-zzzzzz"].map((chain) => ({ chain, count: 1, branches: [], latest: { chain, branch: "main", filename: "latest.md", title: chain, nextStep: null, parent: null, createdAt: null, ageDays: 0, stale: false, bytes: 1 } }));
		registerChainCommands(pi, { list: async () => chains } as unknown as ChainService);
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

	it("exposes an explicit reasoned checkpoint waiver command", async () => {
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		const branch: Array<Record<string, unknown>> = [];
		const pi = {
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			registerCommand(name: string, value: typeof command) { if (name === "chain-waive") command = value; },
		} as unknown as ExtensionAPI;
		const checkpoint = new ChainCheckpointService(pi);
		checkpoint.activate("kit", "main");
		checkpoint.due("test due");
		const previous = chainCheckpoints.current;
		chainCheckpoints.current = checkpoint;
		try {
			const notices: string[] = [];
			const ctx = { ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
			registerChainCommands(pi, {} as ChainService);
			await command!.handler("documented exception", ctx);
			expect(checkpoint.read()).toMatchObject({ status: "saved", waiverReason: "documented exception" });
			expect(notices[0]).toContain("documented exception");
		} finally {
			chainCheckpoints.current = previous;
		}
	});

	it("does not checkpoint a sideways or backward HEAD move", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const heads = ["before\n", "after\n"];
		const pi = {
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			exec: async (_command: string, args: string[]) => args[0] === "merge-base"
				? { code: 1, stdout: "", stderr: "" }
				: { code: 0, stdout: heads.shift() ?? "after\n", stderr: "" },
		} as unknown as ExtensionAPI;
		const service = new ChainCheckpointService(pi);
		service.activate("kit", "main");
		await service.captureGitBeforeTurn("/tmp/project");
		await service.detectGitMutation("/tmp/project");
		expect(service.read().status).toBe("idle");
	});
});
