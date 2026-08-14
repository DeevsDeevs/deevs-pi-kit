import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import cronExtension from "../extensions/cron/index.ts";
import { nextCronDelivery, nextCronRun, parseCron, renderCronFire } from "../extensions/cron/cron.ts";
import { CronManager } from "../extensions/cron/manager.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function setup(options: { sessionId?: string; idle?: boolean; pending?: boolean; now?: number; root?: string; automatic?: boolean; sendFailures?: number } = {}) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pi-kit-cron-"));
	if (!options.root) cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	let now = options.now ?? new Date(2026, 0, 1, 12, 0, 0, 0).getTime();
	let idle = options.idle ?? true;
	let pending = options.pending ?? false;
	let sendFailures = options.sendFailures ?? 0;
	const messages: Array<{ message: any; options: unknown }> = [];
	const branch: unknown[] = [];
	const pi = {
		sendMessage(message: unknown, sendOptions: unknown) {
			if (sendFailures-- > 0) throw new Error("synthetic scheduling failure");
			messages.push({ message, options: sendOptions });
		},
	} as unknown as ExtensionAPI;
	const sessionId = options.sessionId ?? "session-a";
	const ctx = {
		cwd: "/tmp/project",
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => `/tmp/${sessionId}.jsonl`,
			getBranch: () => branch,
		},
		ui: { setStatus() {} },
	} as unknown as ExtensionContext;
	const manager = new CronManager(pi, { root, now: () => now, automatic: options.automatic ?? false, noJitter: true });
	manager.restore(ctx);
	cleanups.push(() => manager.dispose());
	return {
		root, manager, messages, branch, ctx,
		advance(ms: number) { now += ms; },
		setIdle(value: boolean) { idle = value; },
		setPending(value: boolean) { pending = value; },
		ack(index = messages.length - 1) {
			const message = messages[index]!.message;
			manager.messageStarted({ role: "custom", ...message });
		},
	};
}

describe("cron expression", () => {
	it("parses standard fields and computes local-time matches", () => {
		const cron = parseCron("*/5 9-17 * * 1-5");
		expect([...cron.minutes]).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
		const friday = new Date(2026, 0, 2, 16, 58, 30, 0).getTime();
		const next = new Date(nextCronRun(cron, friday)!);
		expect({ day: next.getDay(), hour: next.getHours(), minute: next.getMinutes() }).toEqual({ day: 5, hour: 17, minute: 0 });
	});

	it("rejects malformed and never-firing expressions", () => {
		expect(() => parseCron("* * * *")).toThrow("5 fields");
		expect(() => parseCron("60 * * * *")).toThrow("minute");
		expect(nextCronRun(parseCron("0 0 31 2 *"), Date.now())).toBeNull();
	});

	it("applies deterministic bounded production jitter", () => {
		const from = new Date(2026, 0, 1, 12, 0, 0).getTime();
		const recurring = nextCronDelivery({ id: "ffffffff", cron: "0 13 * * *", prompt: "daily", createdAt: from, recurring: true }, parseCron("0 13 * * *"), from)!;
		expect(recurring.delivery).toBeGreaterThan(recurring.ideal);
		expect(recurring.delivery - recurring.ideal).toBeLessThanOrEqual(15 * 60_000);
		const oneShot = nextCronDelivery({ id: "ffffffff", cron: "0 13 * * *", prompt: "once", createdAt: from, recurring: false }, parseCron("0 13 * * *"), from)!;
		expect(Math.round(oneShot.ideal - oneShot.delivery)).toBe(90_000);
		expect(nextCronDelivery({ id: "ffffffff", cron: "7 13 * * *", prompt: "exact", createdAt: from, recurring: false }, parseCron("7 13 * * *"), from)!.delivery).toBe(new Date(2026, 0, 1, 13, 7).getTime());
	});

	it("renders a parseable fire envelope", () => {
		const text = renderCronFire({ id: "deadbeef", deliveryId: "d&\"1", cron: "0 9 * * *", recurring: false, coalescedCount: 1, stale: false, prompt: "line 1\nline 2" });
		expect(text).toContain('deliveryId="d&amp;&quot;1"');
		expect(text).toContain("<prompt>\nline 1\nline 2\n</prompt>");
	});
});

describe("session cron runtime", () => {
	it("coalesces recurring fires and advances only after message admission", () => {
		const test = setup();
		const task = test.manager.create({ cron: "* * * * *", prompt: "check status" });
		test.advance(3 * 60_000);
		test.manager.tick();
		expect(test.messages).toHaveLength(1);
		expect(test.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(test.messages[0]?.message.details).toMatchObject({ taskId: task.id, recurring: true, coalescedCount: 3 });
		expect(test.manager.list()[0]?.lastFiredAt).toBeUndefined();
		test.ack();
		expect(test.manager.list()[0]?.lastFiredAt).toBeTypeOf("number");
	});

	it("fires an overdue one-shot once and deletes it after admission", () => {
		const test = setup();
		test.manager.create({ cron: "* * * * *", prompt: "one reminder", recurring: false });
		test.advance(10 * 60_000);
		test.manager.tick();
		expect(test.messages[0]?.message.details).toMatchObject({ recurring: false, coalescedCount: 1 });
		expect(test.manager.list()).toHaveLength(1);
		test.ack();
		expect(test.manager.list()).toEqual([]);
	});

	it("waits for idle and gives queued user work priority", () => {
		const test = setup({ idle: false });
		test.manager.create({ cron: "* * * * *", prompt: "later" });
		test.advance(2 * 60_000);
		test.manager.tick();
		expect(test.messages).toEqual([]);
		test.setIdle(true);
		test.setPending(true);
		test.manager.tick();
		expect(test.messages).toEqual([]);
		test.setPending(false);
		test.manager.tick();
		expect(test.messages).toHaveLength(1);
	});

	it("retries a synchronously rejected send with the same durable delivery", () => {
		const test = setup({ sendFailures: 1 });
		const task = test.manager.create({ cron: "* * * * *", prompt: "retry" });
		test.advance(60_000);
		expect(() => test.manager.tick()).not.toThrow();
		expect(test.messages).toEqual([]);
		test.manager.tick();
		expect(test.messages).toHaveLength(1);
		expect(test.messages[0]?.message.details.taskId).toBe(task.id);
	});

	it("persists to the exact session, retries one pending delivery, and does not copy to a fork", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-cron-resume-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const first = setup({ root, sessionId: "same", now: new Date(2026, 0, 1, 12).getTime() });
		first.manager.create({ cron: "* * * * *", prompt: "resume me" });
		first.advance(2 * 60_000);
		first.manager.tick();
		const deliveryId = first.messages[0]?.message.details.deliveryId;
		first.manager.dispose();

		const resumed = setup({ root, sessionId: "same", now: new Date(2026, 0, 1, 12, 2).getTime() });
		resumed.manager.tick();
		expect(resumed.messages[0]?.message.details.deliveryId).toBe(deliveryId);
		resumed.ack();
		expect(resumed.manager.list()[0]?.lastFiredAt).toBeTypeOf("number");

		const fork = setup({ root, sessionId: "fork", now: new Date(2026, 0, 1, 12, 2).getTime() });
		expect(fork.manager.list()).toEqual([]);
	});

	it("reconciles a delivered pending fire from session history after a crash", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-cron-ack-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const first = setup({ root, sessionId: "ack", now: new Date(2026, 0, 1, 12).getTime() });
		first.manager.create({ cron: "* * * * *", prompt: "recover admission" });
		first.advance(60_000);
		first.manager.tick();
		const sent = first.messages[0]!.message;
		first.manager.dispose();

		const resumed = setup({ root, sessionId: "ack", now: new Date(2026, 0, 1, 12, 1).getTime() });
		resumed.manager.dispose();
		resumed.branch.push({ type: "custom_message", customType: sent.customType, details: sent.details });
		const reconciled = new CronManager({ sendMessage() {} } as unknown as ExtensionAPI, { root, now: () => new Date(2026, 0, 1, 12, 1).getTime(), automatic: false, noJitter: true });
		reconciled.restore(resumed.ctx);
		cleanups.push(() => reconciled.dispose());
		expect(reconciled.list()[0]?.lastFiredAt).toBeTypeOf("number");
	});

	it("keeps valid tasks while dropping malformed persisted records", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-cron-state-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "state.json"), JSON.stringify({
			version: 1,
			sessionId: "state",
			tasks: [
				{ id: "deadbeef", cron: "* * * * *", prompt: "valid", createdAt: new Date(2026, 0, 1, 12).getTime(), recurring: true },
				{ id: "bad", cron: "not cron", prompt: "invalid", createdAt: 0, recurring: true },
			],
			pending: { deliveryId: "bad", taskId: "deadbeef", cursor: 0, coalescedCount: -1, stale: false },
		}));
		const test = setup({ root, sessionId: "state" });
		expect(test.manager.list().map((task) => task.id)).toEqual(["deadbeef"]);
		test.manager.tick();
		expect(test.messages).toHaveLength(0);
	});

	it("gives a stale recurring task one final fire", () => {
		const test = setup();
		test.manager.create({ cron: "0 9 * * *", prompt: "old task" });
		test.advance(8 * 24 * 60 * 60_000);
		test.manager.tick();
		expect(test.messages[0]?.message.details).toMatchObject({ stale: true });
		test.ack();
		expect(test.manager.list()).toEqual([]);
	});

	it("bounds task count, prompt bytes, one-shot horizon, and deletion", () => {
		const test = setup();
		expect(() => test.manager.create({ cron: "0 0 31 2 *", prompt: "never" })).toThrow("five years");
		expect(() => test.manager.create({ cron: "0 0 31 12 *", prompt: "too far", recurring: false })).toThrow("350 days");
		expect(() => test.manager.create({ cron: "* * * * *", prompt: "x".repeat(8_193) })).toThrow("8192");
		const task = test.manager.create({ cron: "* * * * *", prompt: "delete" });
		expect(test.manager.delete(task.id).id).toBe(task.id);
		expect(test.manager.list()).toEqual([]);
		for (let index = 0; index < 50; index++) test.manager.create({ cron: "* * * * *", prompt: `task ${index}` });
		expect(() => test.manager.create({ cron: "* * * * *", prompt: "overflow" })).toThrow("cap reached");
	});

	it("does not keep a task when durable creation fails", () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-kit-cron-fail-"));
		cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
		const root = join(parent, "not-a-directory");
		writeFileSync(root, "file");
		const test = setup({ root });
		expect(() => test.manager.create({ cron: "* * * * *", prompt: "must persist" })).toThrow();
		expect(test.manager.list()).toEqual([]);
	});

	it("cancels process-local deadlines on shutdown", () => {
		vi.useFakeTimers();
		cleanups.push(() => vi.useRealTimers());
		const test = setup({ automatic: true });
		test.manager.create({ cron: "* * * * *", prompt: "timer" });
		test.advance(60_000);
		vi.advanceTimersByTime(60_000);
		expect(test.messages).toHaveLength(1);
		test.manager.dispose();
		test.advance(60_000);
		vi.advanceTimersByTime(120_000);
		expect(test.messages).toHaveLength(1);
	});
});

describe("cron extension surface", () => {
	it("confirms interactive deletion before removing a task", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-cron-extension-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		cleanups.push(() => { process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
		let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		let start: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
		let shutdown: (() => void) | undefined;
		const pi = {
			registerTool(value: typeof tool) { tool = value; },
			registerCommand(_name: string, value: typeof command) { command = value; },
			registerMessageRenderer() {},
			on(event: string, handler: any) { if (event === "session_start") start = handler; if (event === "session_shutdown") shutdown = handler; },
			sendMessage() {},
		} as unknown as ExtensionAPI;
		cronExtension(pi);
		const answers: string[] = [];
		const ctx = {
			cwd: "/tmp/project", mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
			sessionManager: { getSessionId: () => "cron-ui", getSessionFile: () => "/tmp/cron-ui.jsonl", getBranch: () => [] },
			ui: { select: async () => answers.shift(), notify() {}, setStatus() {} },
		} as unknown as ExtensionContext;
		start?.({}, ctx);
		await tool!.execute("call", { action: "create", cron: "0 0 1 1 *", prompt: "probe" });
		const task = (await tool!.execute("call", { action: "list" })).details.tasks[0];
		answers.push(`recurring · ${task.id} · ${task.cron}`, "Delete task", "Keep task");
		await command!.handler("", ctx);
		expect((await tool!.execute("call", { action: "list" })).details.tasks).toHaveLength(1);
		answers.push(`recurring · ${task.id} · ${task.cron}`, "Delete task", "Delete task");
		await command!.handler("", ctx);
		expect((await tool!.execute("call", { action: "list" })).details.tasks).toEqual([]);
		shutdown?.();
	});

	it("registers one compact semantic scheduling tool and one command", () => {
		const tools: Array<{ name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] }> = [];
		const commands: string[] = [];
		const pi = {
			registerTool(tool: typeof tools[number]) { tools.push(tool); },
			registerCommand(name: string) { commands.push(name); },
			registerMessageRenderer() {},
			on() {},
		} as unknown as ExtensionAPI;
		cronExtension(pi);
		expect(tools.map((tool) => tool.name)).toEqual(["cron"]);
		expect([tools[0]!.description, tools[0]!.promptSnippet, ...(tools[0]!.promptGuidelines ?? [])].join(" ")).toContain("wall-clock");
		expect(tools[0]!.promptGuidelines?.join(" ")).toContain("Do not poll Jobs, Subagents, or Workflows");
		expect(commands).toEqual(["cron"]);
	});
});
