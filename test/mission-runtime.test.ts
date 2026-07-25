import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MissionState } from "../extensions/mission/state.ts";
import { MissionRuntime } from "../extensions/mission/runtime.ts";
import { clearJobManager, setJobManager } from "../extensions/jobs/registry.ts";
import type { JobManager } from "../extensions/jobs/manager.ts";
import { clearSubagentService, getSubagentService, setSubagentService } from "../extensions/subagents/registry.ts";
import type { SubagentService } from "../extensions/subagents/service.ts";
import type { DelegateRun } from "../extensions/subagents/runtime-types.ts";
import type { MissionCurrent } from "../extensions/mission/types.ts";

async function setup(options: { pending?: boolean } = {}) {
	const branch: Array<Record<string, unknown>> = [];
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const pi = {
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, sendOptions: unknown) { messages.push({ message, options: sendOptions }); },
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: "/tmp/mission-runtime",
		isIdle: () => true,
		hasPendingMessages: () => options.pending === true,
		sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/session.jsonl" },
		ui: { setStatus: () => undefined },
	} as unknown as ExtensionContext;
	const state = new MissionState();
	const created = await state.create({ objective: "Implement it", requirements: ["Feature works"], chain: "kit" }, ctx);
	state.append(pi, created);
	const runtime = new MissionRuntime(pi, state);
	runtime.register();
	const emit = async (event: string, value: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(value as never, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
	};
	return { branch, messages, handlers, pi, ctx, state, runtime, emit };
}

describe("Mission runtime", () => {
	it("continues only from idle lifecycle admission using a triggering follow-up", async () => {
		const test = await setup();
		await test.emit("session_start", { reason: "resume" });
		expect(test.messages).toHaveLength(1);
		expect(test.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(test.state.read()?.turnCount).toBe(1);
	});

	it("defers autonomous continuation behind queued user work", async () => {
		const test = await setup({ pending: true });
		await test.emit("session_start", { reason: "resume" });
		expect(test.messages).toEqual([]);
		expect(test.state.read()?.turnCount).toBe(0);
	});

	it("pauses only after explicit interruption at the settled boundary", async () => {
		const test = await setup();
		await test.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
		await test.emit("agent_settled");
		expect(test.state.read()?.status).toBe("paused");
		expect(test.messages).toEqual([]);
	});

	it("accepts user-requested gate bypass only from a real explicit user message", async () => {
		const test = await setup();
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx)).toContain("userRequested=true is not authorized by the latest real user message; use the ordinary completion evidence gate.");
		test.branch.push({ type: "message", message: { role: "user", content: "How do I end the mission?" } });
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx)).not.toEqual([]);
		test.branch.push({ type: "message", message: { role: "user", content: "I do not want you to end the mission." } });
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx)).not.toEqual([]);
		test.branch.push({ type: "message", message: { role: "user", content: "Stop the mission now." } });
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx)).toEqual([]);
	});

	it("defers continuation and completion while Jobs are active", async () => {
		const test = await setup();
		const manager = { list: () => [{ spec: { id: "j_active" }, runtime: { status: "running" } }] } as unknown as JobManager;
		setJobManager(manager);
		try {
			await test.emit("session_start", { reason: "resume" });
			expect(test.messages).toEqual([]);
			expect(await test.runtime.validateCompletion({ audit: [] }, test.ctx)).toContain("Jobs have not settled: j_active");
		} finally {
			clearJobManager(manager);
		}
	});

	it("guards stale continuation wakes and requires parent review adjudication", async () => {
		const test = await setup();
		const mission = test.state.read()!;
		test.branch.push({ type: "custom_message", customType: "mission", details: { missionId: mission.missionId, generation: "stale", objectiveVersion: mission.objectiveVersion } });
		const before = test.handlers.get("before_agent_start")?.[0];
		const guarded = await before?.({ systemPrompt: "base" } as never, test.ctx) as { systemPrompt?: string } | undefined;
		expect(guarded?.systemPrompt).toContain("continuation wake is stale");

		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-1", reason: "review settled" }));
		test.runtime.onProgress({ summary: "Adjudicated", reviewRunId: "review-1", reviewVerdict: "clear", reviewReason: "Verified the reviewer evidence and no findings remain." }, test.ctx);
		expect(test.state.read()?.reviewStatus).toBe("clear");
	});

	it("recovers automatically when a review settles without a parent agent turn", async () => {
		const test = await setup();
		const run = { spec: { id: "review-recovery" }, runtime: { status: "running", output: "" } } as unknown as DelegateRun;
		let listener: ((candidate: DelegateRun) => void) | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			executor: { get: () => run, onChange: (value: (candidate: DelegateRun) => void) => { listener = value; return () => undefined; } },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, reason: "reviewing" }));
			await test.emit("session_start", { reason: "resume" });
			expect(test.messages).toEqual([]);
			run.runtime.status = "completed";
			run.runtime.output = "## Verdict\nClear";
			listener?.(run);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(test.state.read()?.reviewStatus).toBe("awaiting_adjudication");
			expect(test.messages).toHaveLength(1);
		} finally {
			clearSubagentService(service);
		}
	});

	it("persists and schedules recovery when reviewer admission fails", async () => {
		const test = await setup();
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { throw new Error("synthetic concurrency rejection"); },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const mission = test.state.read()!;
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "files changed" }));
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void>; recoveryTimer?: NodeJS.Timeout };
			await internal.startReview(test.ctx, mission);
			expect(test.state.read()?.reviewStatus).toBe("due");
			expect(test.state.read()?.reviewReason).toContain("review admission failed");
			expect(internal.recoveryTimer).toBeDefined();
			await test.emit("session_shutdown");
		} finally {
			clearSubagentService(service);
		}
	});

	it("counts unavailable Subagent runtime as bounded review admission failures", async () => {
		const test = await setup();
		let existing: SubagentService | undefined;
		try { existing = getSubagentService(); clearSubagentService(existing); } catch { /* already unavailable */ }
		try {
			test.runtime.restore(test.ctx);
			const mission = test.state.read()!;
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, mission);
			await internal.startReview(test.ctx, mission);
			await internal.startReview(test.ctx, mission);
			expect(test.state.readAny()?.status).toBe("blocked");
			await test.emit("session_shutdown");
		} finally {
			if (existing) setSubagentService(existing);
		}
	});

	it("blocks after three failed review runs instead of retrying forever", async () => {
		const test = await setup();
		const run = { spec: { id: "review-third-failure" }, runtime: { status: "timeout", output: "", error: "Wall limit reached" } } as unknown as DelegateRun;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			executor: { get: () => run, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "first review timeout" }));
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "second review limit" }));
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, reason: "third review" }));
			await test.emit("session_start", { reason: "resume" });
			expect(test.state.readAny()?.status).toBe("blocked");
			expect(test.messages).toEqual([]);
		} finally {
			clearSubagentService(service);
		}
	});

	it("vetoes completion until evidence, validation, and review converge", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "files changed" }));
		let blockers = await test.runtime.validateCompletion({ audit: [] }, test.ctx);
		expect(blockers.some((blocker) => blocker.includes("Missing evidence"))).toBe(true);
		expect(blockers.some((blocker) => blocker.includes("review"))).toBe(true);

		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: ["npm test passed"] }));
		test.state.append(test.pi, test.state.reviewEvent("clear", { reason: "review clear" }));
		blockers = await test.runtime.validateCompletion({ audit: [{ requirement: "Feature works", evidence: "test output and implementation diff" }] }, test.ctx);
		expect(blockers).toEqual([]);
	});
});
