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
} from "../extensions/chains/checkpoint.ts";

describe("Chain checkpoint state", () => {
	it("tracks active, due, saved, and waived states through replay", () => {
		let state = emptyChainCheckpoint();
		state = reduceChainCheckpoint(state, { type: "activate", chain: "kit", branch: "main", at: 1 });
		state = reduceChainCheckpoint(state, { type: "due", reason: "files changed", at: 2 });
		expect(state.status).toBe("due");
		state = reduceChainCheckpoint(state, { type: "saved", chain: "kit", branch: "main", link: "checkpoint.md", at: 3 });
		expect(state).toMatchObject({ status: "saved", lastLink: "checkpoint.md", dueReasons: [] });
		state = reduceChainCheckpoint(state, { type: "due", reason: "new decision", at: 4 });
		state = reduceChainCheckpoint(state, { type: "saved", chain: "kit", branch: "main", link: "stale.md", at: 2 });
		expect(state).toMatchObject({ status: "due", lastLink: "checkpoint.md", dueReasons: ["new decision"] });

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
	});

	it("forces one immediate Chain checkpoint when context reaches 80 percent", () => {
		const branch: Array<Record<string, unknown>> = [];
		let percent = 79;
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		const ctx = {
			getContextUsage: () => ({ tokens: 80, contextWindow: 100, percent }),
			sessionManager: { getBranch: () => branch },
			ui: { setStatus() {} },
		} as unknown as ExtensionContext;
		const service = new ChainCheckpointService(pi);
		service.activate("kit", "main");
		service.checkContextPressure(ctx);
		expect(service.read().status).toBe("idle");
		percent = 80;
		service.checkContextPressure(ctx);
		expect(service.read().dueReasons).toEqual(["context usage reached 80%"]);
		expect(service.beforeAgentStart("base")).toContain("before any other work");
		service.saved("kit", "main", "checkpoint.md");
		percent = 95;
		const reloaded = new ChainCheckpointService(pi);
		reloaded.restore(ctx);
		reloaded.checkContextPressure(ctx);
		expect(reloaded.read().status).toBe("saved");
		reloaded.contextCompacted();
		reloaded.checkContextPressure(ctx);
		expect(reloaded.read().status).toBe("due");
	});

	it("keeps colliding truncated Chain labels separately selectable", async () => {
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		const pi = { registerCommand(name: string, value: typeof command) { if (name === "chains") command = value; } } as unknown as ExtensionAPI;
		const chains = ["abcdefghijklmno-one-zzzzzz", "abcdefghijklmno-two-zzzzzz"].map((chain) => ({ chain, count: 1, branches: ["main"], latest: { branch: "main" } }));
		registerChainCommands(pi, { list: async () => chains } as unknown as ChainService);
		let labels: string[] = [];
		const ctx = { mode: "tui", ui: { select: async (_title: string, options: string[]) => { labels = options; return undefined; } } } as unknown as ExtensionContext;
		await command!.handler("", ctx);
		expect(labels).toHaveLength(2);
		expect(new Set(labels).size).toBe(2);
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
