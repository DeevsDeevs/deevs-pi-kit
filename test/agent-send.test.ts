import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newAgentId, tasks } from "../extensions/shared/tasks.ts";
import { closeAll, ensureEngine, launch, send, startJob } from "../extensions/subagents/engine/index.ts";
import { SETTLED } from "../extensions/subagents/engine/storage.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-send-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-kit-send-cwd-"));
const faux = createFauxCore({ provider: "faux", models: [{ id: "m" }] });
// SAFETY: the engine reads only these members of the context.
const ctx = {
	cwd,
	isProjectTrusted: () => false,
	modelRegistry: { find: (_provider: string, id: string) => faux.getModel(id), streamSimple: faux.streamSimple },
	sessionManager: { getSessionId: () => "s", getEntries: () => [] },
} as unknown as ExtensionContext;

afterAll(closeAll);

describe("SendMessage to an agent", () => {
	it("steers a message sent before the prompt is placed in right after it, and reports once", async () => {
		const asked: string[] = [];
		const answer = (text: string): FauxResponseStep => (context) => {
			asked.push(context.messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : [])).join("|"));
			return fauxAssistantMessage(text);
		};
		faux.setResponses([answer("first"), answer("second")]);
		const engine = await ensureEngine(ctx);
		const agentId = newAgentId();
		const { done } = await launch(engine, { agentId, description: "d", prompt: "task", model: faux.getModel(), tools: ["read"], instructions: "", cwd, writer: false, toolUseId: "t", limits: {}, foreground: true });
		expect(await send(engine, agentId, "steer", "t2")).toBe("steered");
		const report = await done!;
		expect([report.status, report.result]).toEqual(["completed", "second"]);
		expect(asked.at(-1)).toContain("steer");
	});

	it("sends a foreground report again after a restart only while its Agent result is unsaved, then prunes it", async () => {
		faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("other")]);
		const foreground = async (toolUseId: string) => {
			const agentId = newAgentId();
			const { done } = await launch(await ensureEngine(ctx), { agentId, description: "d", prompt: "task", model: faux.getModel(), tools: ["read"], instructions: "", cwd, writer: false, toolUseId, limits: {}, foreground: true });
			await done;
			return () => sent.filter((id) => id.startsWith(`${agentId}:`));
		};
		const sent: string[] = [];
		const saved = await foreground("fg");
		const unsaved = await foreground("fg2");
		let start: ((event: object, context: ExtensionContext) => Promise<void>) | undefined;
		tasks.install({ on: (name: string, handler: typeof start) => { if (name === "session_start") start = handler; }, sendMessage: (message: { details: { notificationId: string } }) => sent.push(message.details.notificationId) } as unknown as ExtensionAPI);
		const reopen = async (entries: object[]) => {
			await closeAll();
			const restarted = { ...ctx, isIdle: () => true, ui: { setStatus() {} }, sessionManager: { getSessionId: () => "s", getEntries: () => entries } } as unknown as ExtensionContext;
			await start!({ reason: "startup" }, restarted);
			await ensureEngine(restarted);
		};
		await reopen([{ type: "message", message: { role: "toolResult", toolCallId: "fg" } }]);
		expect([saved(), unsaved()].map((ids) => ids.length)).toEqual([0, 1]);
		// The Outbox dropped the saved one at that open, so it stays unsent once the session no longer shows its result.
		await reopen([]);
		expect(saved()).toEqual([]);
	}, 30_000);

	it("reports a run that throws as failed instead of leaving the agent running", async () => {
		const engine = await ensureEngine(ctx);
		const agentId = newAgentId();
		const notRepo = mkdtempSync(join(tmpdir(), "pi-kit-send-norepo-"));
		const worktree = { path: join(notRepo, "gone"), branch: "agent/x", repoRoot: notRepo, base: "HEAD" };
		const cli = { harness: "claude" as const, model: "m", cwd, instructions: "", tools: [], writer: false, dir: join(engine.dir, "cli", agentId) };
		const { done } = await launch(engine, { agentId, description: "d", prompt: "task", cwd, writer: false, toolUseId: "t3", foreground: true, worktree, cli });
		const report = await done!;
		expect([report.status, report.summary.startsWith('Agent "d" failed: ')]).toEqual(["failed", true]);
		expect(tasks.find(agentId)?.status).toBe("failed");
	});

	it("closes a store settled only when nothing runs and the Outbox is empty, and reopening unsettles it", async () => {
		const idle = { ...ctx, sessionManager: { getSessionId: () => "idle", getEntries: () => [] } } as unknown as ExtensionContext;
		const settled = async () => existsSync(join((await ensureEngine(idle)).dir, SETTLED));
		const dir = (await ensureEngine(idle)).dir;
		await closeAll();
		expect(existsSync(join(dir, SETTLED))).toBe(true);
		expect(await settled()).toBe(false);
		await startJob(await ensureEngine(idle), { id: "j1", command: "sleep 30", description: "d", cwd, toolUseId: "t" });
		await closeAll();
		expect(existsSync(join(dir, SETTLED))).toBe(false);
	});

	it("puts running tasks and the 20 finished most recently started back on the roster at reopen", async () => {
		const many = { ...ctx, sessionManager: { getSessionId: () => "many", getEntries: () => [] } } as unknown as ExtensionContext;
		const engine = await ensureEngine(many);
		for (let i = 0; i < 22; i++) await startJob(engine, { id: `quick${i}`, command: "true", description: "d", cwd, toolUseId: "t" });
		await startJob(engine, { id: "slow", command: "sleep 30", description: "d", cwd, toolUseId: "t" });
		await vi.waitFor(() => expect(tasks.list("many").filter((task) => task.status !== "running")).toHaveLength(22), { timeout: 10_000 });
		await closeAll();
		for (const task of tasks.list("many")) tasks.remove(task.id);
		await ensureEngine(many);
		const ids = tasks.list("many").map((task) => task.id);
		expect([ids.length, ids.includes("slow"), ids.includes("quick21")]).toEqual([21, true, true]);
	});
});
