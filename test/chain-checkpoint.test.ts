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
		expect(statuses.at(-1)).toBe("chain!");
		expect(service.reminder()).toContain("checkpoint is due");
		service.due("milestone recorded");
		expect(service.reminder()).toContain("save a chain link before starting further substantive work");
	});

	it("reminds once at 85 percent context through a prompt section and never blocks a tool", () => {
		const branch: Array<Record<string, unknown>> = [];
		const handlers = new Map<string, (...args: any[]) => unknown>();
		let percent = 85;
		const pi = {
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
			on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
			registerEntryRenderer() {},
		} as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }),
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {} },
		} as unknown as ExtensionContext;
		const service = new ChainCheckpointService(pi);
		registerChainCheckpoint(pi, service);
		service.activate("kit", "main");
		expect(handlers.has("tool_call")).toBe(false);

		let current: string | undefined;
		const sent: string[] = [];
		const run = (): string | undefined => {
			const event = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
			expect(handlers.get("before_agent_start")!(event, ctx)).toBeUndefined();
			const section = event.systemPromptOptions.sections.chain_checkpoint;
			if (section !== current && section !== undefined) sent.push(section);
			current = section;
			return section;
		};
		run();
		run();
		percent = 50;
		run();
		percent = 85;
		run();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("Context reached 80%");
		expect(service.read().dueReasons).toEqual(["context usage reached 80%"]);

		handlers.get("tool_execution_start")!({ toolCallId: "save", toolName: "chain", args: { action: "save", chain: "kit", branch: "main" } });
		handlers.get("tool_execution_end")!({ toolCallId: "save", toolName: "chain", isError: false, result: { details: { link: { filename: "checkpoint.md" } } } }, ctx);
		expect(branch.at(-1)?.data).toMatchObject({ type: "saved", chain: "kit", branch: "main", link: "checkpoint.md" });
		expect(run()).toBeUndefined();
		expect(sent).toHaveLength(1);

		percent = 50;
		handlers.get("session_compact")!({}, ctx);
		expect(service.read()).toMatchObject({ status: "saved", contextPressureHandled: false });
		expect(run()).toContain("Load this Chain before rediscovery");

		handlers.get("tool_execution_start")!({ toolCallId: "fork", toolName: "chain", args: { action: "fork", chain: "kit", branch: "alt" } });
		handlers.get("tool_execution_end")!({ toolCallId: "fork", toolName: "chain", isError: false, result: {} }, ctx);
		expect(service.read()).toMatchObject({ chain: "kit", branch: "alt", status: "due", dueCodes: ["branch_created"] });
		expect(replayChainCheckpoint([{ type: "custom", customType: CHAIN_CHECKPOINT_ENTRY, data: { type: "due", reason: "r", code: "bogus", at: 1 } }]).dueCodes).toEqual(["other"]);
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
