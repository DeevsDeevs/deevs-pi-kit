import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MISSION_CUSTOM_TYPE, MissionState } from "../extensions/mission/state.ts";
import { MissionRuntime } from "../extensions/mission/runtime.ts";
import { parseCreateArgs } from "../extensions/mission/commands.ts";
import { completeMission, registerMissionTools, resumeMission } from "../extensions/mission/tools.ts";
import { clearJobManager, setJobManager } from "../extensions/jobs/registry.ts";
import type { JobManager } from "../extensions/jobs/manager.ts";
import { clearSubagentService, getSubagentService, setSubagentService } from "../extensions/subagents/registry.ts";
import type { SubagentService } from "../extensions/subagents/service.ts";
import type { DelegateRun } from "../extensions/subagents/runtime-types.ts";
import { MAX_MISSION_REVIEW_ADJUDICATIONS } from "../extensions/mission/types.ts";
import type { MissionCurrent } from "../extensions/mission/types.ts";

function expectedFingerprint(diff = "", head = "head"): string {
	return createHash("sha256").update(".").update("\0\0whole-head\0").update(head).update("\0").update(diff).update("\0").digest("hex");
}

async function actualGitExec(command: string, args: string[], options: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		return { code: 0, stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		return { code: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

function createGitRepo(parent: string, name: string): string {
	const repo = join(parent, name);
	mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "tracked.txt"), `${name}\n`);
	execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"], { cwd: repo });
	return repo;
}

const ownedRoots: string[] = [];
afterEach(() => { for (const root of ownedRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function setup(options: { pending?: boolean; fingerprint?: () => string; head?: () => string; cwd?: string; exec?: (command: string, args: string[], options: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }> } = {}) {
	const branch: Array<Record<string, unknown>> = [];
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "mission-runtime-unit-"));
	if (!options.cwd) ownedRoots.push(cwd);
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const pi = {
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, sendOptions: unknown) { messages.push({ message, options: sendOptions }); },
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		exec: options.exec ?? (async (_command: string, args: string[]) => ({ code: 0, stdout: args[0] === "rev-parse" && args[1] === "--show-toplevel" ? cwd : args[0] === "rev-parse" ? options.head?.() ?? "head" : args[0] === "diff" ? options.fingerprint?.() ?? "" : "", stderr: "" })),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		isIdle: () => true,
		hasPendingMessages: () => options.pending === true,
		sessionManager: { getBranch: () => branch, getSessionFile: () => join(cwd, "session.jsonl"), getSessionId: () => `session-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}` },
		ui: { setStatus: () => undefined },
	} as unknown as ExtensionContext;
	const state = new MissionState();
	state.loadFromSession(ctx);
	const created = await state.create({ objective: "Implement it", requirements: ["Feature works"], chain: "kit" }, ctx);
	state.append(pi, created);
	const runtime = new MissionRuntime(pi, state);
	const emptyService = {
		list: () => ({ runs: [], groups: [] }),
		executor: { onChange: () => () => undefined },
	} as unknown as SubagentService;
	setSubagentService(emptyService);
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
		await vi.waitFor(() => expect(test.messages).toHaveLength(1), { timeout: 500 });
		expect(test.messages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		const wake = test.messages[0]?.message as { content?: string };
		expect(wake.content).toContain("do not shrink scope to fit one turn");
		expect(wake.content).not.toContain("one reversible, verifiable slice");
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
		const before = test.handlers.get("before_agent_start")?.[0];
		const prompt = await before?.({ systemPrompt: "base", prompt: "What next?" } as never, test.ctx) as { systemPrompt?: string } | undefined;
		expect(prompt?.systemPrompt).toContain("Mission control state: PAUSED");
		expect(prompt?.systemPrompt).toContain("call mission_resume");
		expect(prompt?.systemPrompt).toContain("kit@main");
	});

	it("keeps autonomy active when a typed mid-stream steer aborts the current run", async () => {
		const test = await setup();
		await test.emit("input", { source: "interactive", streamingBehavior: "steer", text: "Also update docs" });
		await test.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
		await test.emit("agent_settled");
		expect(test.state.read()?.status).toBe("active");
	});

	it("does not treat extension-injected steering as user authorization", async () => {
		const test = await setup();
		await test.emit("input", { source: "extension", streamingBehavior: "steer", text: "runtime wake" });
		await test.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
		await test.emit("agent_settled");
		expect(test.state.read()?.status).toBe("paused");
	});

	it("attributes an abort to the latest typed steer source", async () => {
		const test = await setup();
		await test.emit("input", { source: "interactive", streamingBehavior: "steer", text: "user steer" });
		await test.emit("input", { source: "extension", streamingBehavior: "steer", text: "runtime steer" });
		await test.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
		await test.emit("agent_settled");
		expect(test.state.read()?.status).toBe("paused");
	});

	it("lets the model-callable tool policy authorize recoverable user-requested closure", async () => {
		const test = await setup();
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx)).toEqual([]);
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx, true)).toEqual([]);
	});

	it("blocks continuation and user-requested closure on groups and launch reservations", async () => {
		const test = await setup();
		const service = {
			list: () => ({ runs: [], groups: [{ id: "g_active", status: "running" }] }),
			activeLaunchReservations: () => 1,
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			await test.emit("session_start", { reason: "resume" });
			expect(test.messages).toEqual([]);
			expect(test.runtime.continuationBlockers(test.ctx)).toContain("Subagent groups still running: g_active");
			const blockers = await test.runtime.validateCompletion({ userRequested: true }, test.ctx);
			expect(blockers).toContain("Subagent groups have not settled: g_active");
			expect(blockers).toContain("Subagent launches have not settled: 1");
		} finally {
			clearSubagentService(service);
		}
	});

	it("marks review due from a structured worktree fingerprint change regardless of tool prose", async () => {
		let fingerprint = "before";
		const test = await setup({ fingerprint: () => fingerprint });
		await test.emit("turn_start");
		fingerprint = "after";
		await test.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
		await test.emit("agent_settled");
		expect(["due", "starting", "blocked"]).toContain(test.state.readAny()?.reviewStatus);
	});

	it("fails completion and continuation closed when child settlement cannot be verified", async () => {
		const test = await setup();
		const service = {
			list: () => { throw new Error("synthetic registry failure"); },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			await test.emit("session_start", { reason: "resume" });
			expect(test.messages).toEqual([]);
			expect(await test.runtime.validateCompletion({ audit: [] }, test.ctx)).toContain("Cannot verify child settlement: synthetic registry failure");
		} finally {
			clearSubagentService(service);
		}
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

	it("keeps a running review active when edits occur so fingerprint reconciliation can count churn", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("running", { runId: "review-active", worktreeFingerprint: expectedFingerprint() }));
		await test.emit("tool_execution_start", { toolName: "edit", toolCallId: "edit-1" });
		await test.emit("tool_execution_end", { toolName: "edit", toolCallId: "edit-1", isError: false });
		expect(test.state.read()?.reviewStatus).toBe("running");
		expect(test.state.read()?.reviewRunId).toBe("review-active");
	});

	it("guards stale continuation wakes and requires parent review adjudication", async () => {
		const test = await setup();
		const mission = test.state.read()!;
		test.branch.push({ type: "custom_message", customType: "mission", details: { missionId: mission.missionId, generation: "stale", objectiveVersion: mission.objectiveVersion } });
		const before = test.handlers.get("before_agent_start")?.[0];
		const guarded = await before?.({ systemPrompt: "base" } as never, test.ctx) as { systemPrompt?: string } | undefined;
		expect(guarded?.systemPrompt).toContain("continuation wake is stale");

		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-1", reason: "review settled", suggestedVerdict: "clear" }));
		test.runtime.onProgress({ summary: "Adjudicated", reviewRunId: "review-1", reviewVerdict: "clear", reviewReason: "Verified the reviewer evidence and no findings remain." }, test.ctx);
		expect(test.state.read()?.reviewStatus).toBe("clear");
	});

	it("recovers automatically when a review settles without a parent agent turn", async () => {
		const test = await setup();
		const artifactsDir = mkdtempSync(join(tmpdir(), "mission-review-"));
		const run = { spec: { id: "review-recovery", artifactsDir }, runtime: { status: "running", output: "" } } as unknown as DelegateRun;
		let listener: ((candidate: DelegateRun) => void) | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			executor: { get: () => run, onChange: (value: (candidate: DelegateRun) => void) => { listener = value; return () => undefined; } },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const candidateId = await test.runtime.completionCandidateId(test.ctx);
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, reason: "reviewing", worktreeFingerprint: expectedFingerprint(), candidateId }));
			await test.emit("session_start", { reason: "resume" });
			expect(test.messages).toEqual([]);
			run.runtime.status = "completed";
			run.runtime.output = "human explanation in any language";
			writeFileSync(join(artifactsDir, "review-report.json"), JSON.stringify({ version: 1, verdict: "clear", findings: [] }));
			listener?.(run);
			await vi.waitFor(() => expect(test.state.read()?.reviewStatus).toBe("awaiting_adjudication"), { timeout: 500 });
			expect(test.state.read()?.reviewSuggestedVerdict).toBe("clear");
			expect(test.messages).toHaveLength(1);
		} finally {
			rmSync(artifactsDir, { recursive: true, force: true });
			clearSubagentService(service);
		}
	});

	it("keeps a changed candidate awaiting adjudication instead of comparing it to the old admitted baseline", async () => {
		let fingerprint = "baseline";
		const test = await setup({ fingerprint: () => fingerprint });
		test.state.append(test.pi, test.state.workspaceFingerprintEvent(expectedFingerprint(fingerprint)));
		fingerprint = "reviewed-change";
		const reviewedFingerprint = expectedFingerprint(fingerprint);
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-changed-candidate", suggestedVerdict: "clear", worktreeFingerprint: reviewedFingerprint, candidateId }));
		await test.emit("turn_start");
		expect(test.state.read()).toMatchObject({ reviewStatus: "awaiting_adjudication", reviewRunId: "review-changed-candidate", reviewWorktreeFingerprint: reviewedFingerprint });
	});

	it("requires a new review when the worktree changes while review is running", async () => {
		let fingerprint = "before";
		const test = await setup({ fingerprint: () => fingerprint });
		const artifactsDir = mkdtempSync(join(tmpdir(), "mission-review-mutation-"));
		const run = { spec: { id: "review-mutation", artifactsDir }, runtime: { status: "running", output: "" } } as unknown as DelegateRun;
		let listener: ((candidate: DelegateRun) => void) | undefined;
		let restarted: { deliverTerminal?: boolean } | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async (input: { deliverTerminal?: boolean }) => {
				restarted = input;
				return { spec: { id: "review-mutation-retry" }, runtime: { status: "running" } } as DelegateRun;
			},
			executor: { get: () => run, onChange: (value: (candidate: DelegateRun) => void) => { listener = value; return () => undefined; } },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const launchFingerprint = expectedFingerprint(fingerprint);
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, worktreeFingerprint: launchFingerprint }));
			await test.emit("session_start", { reason: "resume" });
			fingerprint = "after";
			run.runtime.status = "completed";
			writeFileSync(join(artifactsDir, "review-report.json"), JSON.stringify({ version: 1, verdict: "clear", findings: [] }));
			listener?.(run);
			await vi.waitFor(() => expect(test.state.read()?.reviewRunId).toBe("review-mutation-retry"), { timeout: 500 });
			expect(test.state.read()?.reviewStatus).toBe("running");
			expect(test.state.read()?.reviewReason).toContain("worktree changed while independent review was running");
			expect(restarted?.deliverTerminal).toBe(false);
		} finally {
			rmSync(artifactsDir, { recursive: true, force: true });
			clearSubagentService(service);
		}
	});

	it("blocks after three review-time fingerprint changes instead of requeueing forever", async () => {
		let fingerprint = "before";
		const test = await setup({ fingerprint: () => fingerprint });
		const artifactsDir = mkdtempSync(join(tmpdir(), "mission-review-churn-"));
		const run = { spec: { id: "review-churn", artifactsDir }, runtime: { status: "running", output: "" } } as unknown as DelegateRun;
		let listener: ((candidate: DelegateRun) => void) | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			executor: { get: () => run, onChange: (value: (candidate: DelegateRun) => void) => { listener = value; return () => undefined; } },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "first churn", failure: true }));
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "second churn", failure: true }));
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, worktreeFingerprint: expectedFingerprint(fingerprint) }));
			await test.emit("session_start", { reason: "resume" });
			fingerprint = "after";
			run.runtime.status = "completed";
			writeFileSync(join(artifactsDir, "review-report.json"), JSON.stringify({ version: 1, verdict: "clear", findings: [] }));
			listener?.(run);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(test.state.readAny()?.status).toBe("blocked");
			expect(test.state.readAny()?.reviewStatus).toBe("due");
			expect(test.state.readAny()?.lastSummary).toContain("worktree changed while independent review was running");
		} finally {
			rmSync(artifactsDir, { recursive: true, force: true });
			clearSubagentService(service);
		}
	});

	it("refuses reviewer launch without a canonical persisted Mission owner", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/ownerless.jsonl" }, ui: { setStatus: () => undefined } } as unknown as ExtensionContext;
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); }, exec: async () => ({ code: 0, stdout: "/tmp", stderr: "", killed: false }) } as unknown as ExtensionAPI;
		const state = new MissionState();
		state.append(pi, await state.create({ objective: "Ownerless review", chain: "kit" }, ctx));
		state.append(pi, state.reviewEvent("due", { reason: "review" }));
		const runtime = new MissionRuntime(pi, state);
		let starts = 0;
		setSubagentService({ list: () => ({ runs: [], groups: [] }), start: async () => { starts++; throw new Error("must not start"); }, executor: { onChange: () => () => undefined } } as unknown as SubagentService);
		try {
			const internal = runtime as unknown as { startReview: (currentCtx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await expect(internal.startReview(ctx, state.read()!)).rejects.toThrow("canonical persisted session owner");
			expect(starts).toBe(0);
		} finally { clearSubagentService(getSubagentService()); }
	});

	it("migrates legacy clear review state back to due instead of deadlocking completion", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("clear", { worktreeFingerprint: expectedFingerprint() }));
		test.runtime.restore(test.ctx);
		expect(test.state.read()).toMatchObject({ reviewStatus: "due" });
		expect(test.state.read()?.reviewReason).toContain("Legacy clear review");
	});

	it("suppresses duplicate reviewer generations for an unchanged adjudicated candidate", async () => {
		const test = await setup();
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId, worktreeFingerprint: expectedFingerprint() }));
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "duplicate due" }));
		let starts = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { starts++; return { spec: { id: "should-not-start" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(starts).toBe(0);
			expect(test.state.read()).toMatchObject({ reviewStatus: "clear", reviewAdjudicatedCandidateId: candidateId, reviewCorrectionCount: 0 });
		} finally {
			clearSubagentService(service);
		}
	});

	it("suppresses duplicate reviewer generations when a previously adjudicated candidate returns", async () => {
		const head = "candidate-a";
		const test = await setup({ head: () => head });
		const candidateA = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId: candidateA, worktreeFingerprint: expectedFingerprint("", head) }));
		const otherCandidates = Array.from({ length: 32 }, (_, index) => `candidate_other_${index}`);
		for (const candidateId of otherCandidates) test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId }));
		expect(test.state.read()?.reviewAdjudications).toHaveLength(33);
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "candidate A returned after more than 32 adjudications" }));
		let starts = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { starts++; return { spec: { id: "must-not-start" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(starts).toBe(0);
			expect(test.state.read()).toMatchObject({ reviewStatus: "clear", reviewAdjudicatedCandidateId: candidateA });
			expect(test.state.read()?.reviewAdjudications).toHaveLength(33);
			expect(test.state.read()?.reviewAdjudications?.at(-1)).toEqual({ candidateId: candidateA, verdict: "clear" });
			expect(test.state.read()?.reviewAdjudications?.map((item) => item.candidateId)).toEqual([...otherCandidates, candidateA]);
		} finally {
			clearSubagentService(service);
		}
	});

	it("fails closed before reviewer launch when adjudication history capacity is exhausted", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId: "candidate_seed" }));
		for (let index = 1; index < MAX_MISSION_REVIEW_ADJUDICATIONS; index++) test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId: `candidate_${index}` }));
		expect(test.state.read()?.reviewAdjudications).toHaveLength(MAX_MISSION_REVIEW_ADJUDICATIONS);
		expect(() => test.state.reviewEvent("clear", { candidateId: "candidate_over_capacity" })).toThrow("refusing to forget a reviewed candidate");
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "new candidate" }));
		let starts = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { starts++; return { spec: { id: "must-not-start" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(starts).toBe(0);
			expect(test.state.read()).toMatchObject({ status: "blocked", reviewStatus: "due", lastReason: "review adjudication history capacity reached" });
		} finally {
			clearSubagentService(service);
		}
	});

	it("does not infer complete history from an original legacy branch with truncated arrays", async () => {
		const test = await setup();
		const mission = test.state.read()!;
		const legacyAdjudications = Array.from({ length: 32 }, (_, index) => ({ candidateId: `legacy_candidate_${index + 2}`, verdict: "clear" }));
		const snapshotFile = join(test.ctx.cwd, ".missions", ".state", `${mission.slug}.json`);
		const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
		delete snapshot.mission.reviewAdjudicationHistoryComplete;
		snapshot.mission.reviewAdjudications = legacyAdjudications;
		writeFileSync(snapshotFile, JSON.stringify(snapshot));
		const created = test.branch.find((entry) => entry.customType === MISSION_CUSTOM_TYPE && (entry.data as { kind?: string }).kind === "created")!;
		delete (created.data as { reviewAdjudicationHistoryComplete?: true }).reviewAdjudicationHistoryComplete;
		test.branch.push({ type: "custom", customType: MISSION_CUSTOM_TYPE, data: { kind: "review_changed", missionId: mission.missionId, generation: mission.generation, at: Date.now(), reviewStatus: "clear", reviewCandidateId: "legacy_candidate_33", reviewAdjudicatedCandidateId: "legacy_candidate_33", reviewAdjudicatedVerdict: "clear", reviewAdjudications: legacyAdjudications } });
		test.state.loadFromSession(test.ctx);
		expect(test.state.read()?.reviewAdjudicationHistoryComplete).toBeUndefined();
		expect(test.state.read()?.reviewAdjudications).toHaveLength(32);
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "possibly evicted legacy candidate returned" }));
		let starts = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { starts++; return { spec: { id: "must-not-start" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, current: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(starts).toBe(0);
			expect(test.state.read()).toMatchObject({ status: "blocked", reviewStatus: "due", lastReason: "review adjudication history completeness is unknown" });
		} finally {
			clearSubagentService(service);
		}
	});

	it("replays the authoritative singular legacy verdict over a stale array entry", async () => {
		const test = await setup();
		const mission = test.state.read()!;
		const candidateId = (await test.runtime.completionCandidateId(test.ctx))!;
		const snapshotFile = join(test.ctx.cwd, ".missions", ".state", `${mission.slug}.json`);
		const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
		delete snapshot.mission.reviewAdjudicationHistoryComplete;
		snapshot.mission.reviewStatus = "clear";
		snapshot.mission.reviewAdjudicatedCandidateId = candidateId;
		snapshot.mission.reviewAdjudicatedVerdict = "changes_requested";
		snapshot.mission.reviewAdjudications = Array.from({ length: 32 }, (_, index) => ({ candidateId: index === 0 ? candidateId : `legacy_other_${index}`, verdict: "clear" }));
		writeFileSync(snapshotFile, JSON.stringify(snapshot));
		test.branch.splice(0, test.branch.length, { type: "custom", customType: MISSION_CUSTOM_TYPE, data: { kind: "taken_over", missionId: mission.missionId, slug: mission.slug, generation: mission.generation, at: Date.now(), status: "active" } });
		test.state.loadFromSession(test.ctx);
		expect(test.state.read()?.reviewAdjudications?.at(-1)).toEqual({ candidateId, verdict: "changes_requested" });
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "known singular candidate returned" }));
		let starts = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { starts++; return { spec: { id: "must-not-start" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, current: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(starts).toBe(0);
			expect(test.state.read()).toMatchObject({ status: "active", reviewStatus: "changes_requested", reviewAdjudicatedCandidateId: candidateId, reviewAdjudicatedVerdict: "changes_requested" });
		} finally {
			clearSubagentService(service);
		}
	});

	it("fails closed for an unknown candidate when a takeover snapshot has incomplete legacy history", async () => {
		const test = await setup();
		const mission = test.state.read()!;
		const snapshotFile = join(test.ctx.cwd, ".missions", ".state", `${mission.slug}.json`);
		const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
		delete snapshot.mission.reviewAdjudicationHistoryComplete;
		snapshot.mission.reviewAdjudications = Array.from({ length: 32 }, (_, index) => ({ candidateId: `legacy_candidate_${index + 2}`, verdict: "clear" }));
		writeFileSync(snapshotFile, JSON.stringify(snapshot));
		test.branch.splice(0, test.branch.length, { type: "custom", customType: MISSION_CUSTOM_TYPE, data: { kind: "taken_over", missionId: mission.missionId, slug: mission.slug, generation: mission.generation, at: Date.now(), status: "active" } });
		test.state.loadFromSession(test.ctx);
		expect(test.state.read()?.reviewAdjudicationHistoryComplete).toBeUndefined();
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "legacy candidate returned" }));
		let starts = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { starts++; return { spec: { id: "must-not-start" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, current: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(starts).toBe(0);
			expect(test.state.read()).toMatchObject({ status: "blocked", reviewStatus: "due", lastReason: "review adjudication history completeness is unknown" });
		} finally {
			clearSubagentService(service);
		}
	});

	it("reserves a typed review candidate before launch and rejects a stale objective result", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "review" }));
		let launchStarted!: () => void;
		let resolveRun!: (run: DelegateRun) => void;
		let listener: ((run: DelegateRun) => void) | undefined;
		let starts = 0;
		let firstLaunched = false;
		const started = new Promise<void>((resolve) => { launchStarted = resolve; });
		const firstRun = new Promise<DelegateRun>((resolve) => { resolveRun = resolve; });
		const staleRun = { spec: { id: "stale-review" }, runtime: { status: "running" } } as DelegateRun;
		const service = {
			list: () => ({ runs: firstLaunched && staleRun.runtime.status === "running" ? [staleRun] : [], groups: [] }),
			start: async () => { starts++; if (starts === 1) { firstLaunched = true; launchStarted(); return firstRun; } return { spec: { id: "fresh-review" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { onChange: (value: (run: DelegateRun) => void) => { listener = value; return () => undefined; } },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			const admission = internal.startReview(test.ctx, test.state.read()!);
			await started;
			expect(test.state.read()).toMatchObject({ reviewStatus: "starting", reviewCandidateObjectiveVersion: 1 });
			expect(test.state.read()?.reviewCandidateId).toMatch(/^candidate_/);
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ objective: "Changed objective", reason: "user changed scope" }));
			resolveRun(staleRun);
			await admission;
			expect(test.state.read()).toMatchObject({ objectiveVersion: 2, reviewStatus: "due" });
			expect(test.state.read()?.reviewRunId).toBeUndefined();
			await test.emit("session_start", { reason: "resume" });
			staleRun.runtime.status = "completed";
			listener?.(staleRun);
			await vi.waitFor(() => expect(test.state.read()?.reviewRunId).toBe("fresh-review"), { timeout: 500 });
			expect(starts).toBe(2);
		} finally {
			clearSubagentService(service);
		}
	});

	it("reconciles a reviewer that settles before its durable run binding is appended", async () => {
		const test = await setup();
		const artifactsDir = mkdtempSync(join(tmpdir(), "mission-fast-review-"));
		const run = { spec: { id: "fast-review", artifactsDir }, runtime: { status: "completed", output: "" } } as unknown as DelegateRun;
		writeFileSync(join(artifactsDir, "review-report.json"), JSON.stringify({ version: 1, verdict: "clear", findings: [] }));
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => run,
			executor: { get: () => run, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "fast review" }));
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			await vi.waitFor(() => expect(test.state.read()?.reviewStatus).toBe("awaiting_adjudication"), { timeout: 500 });
			expect(test.state.read()?.reviewRunId).toBe("fast-review");
		} finally {
			rmSync(artifactsDir, { recursive: true, force: true });
			clearSubagentService(service);
		}
	});

	it("requires explicit resume after ambiguous starting admission and re-enters review recovery", async () => {
		const test = await setup();
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("starting", { candidateId, worktreeFingerprint: expectedFingerprint(), admissionId: "review-ambiguous" }));
		await test.emit("session_start", { reason: "resume" });
		await vi.waitFor(() => expect(test.state.readAny()?.status).toBe("blocked"), { timeout: 500 });
		let recoveredAdmissionKey: string | undefined;
		const recoveredRun = { spec: { id: "recovered-review", admissionKey: "review-ambiguous" }, runtime: { status: "running" } } as DelegateRun;
		const service = {
			list: () => ({ runs: [recoveredRun], groups: [] }),
			start: async (input: { admissionKey?: string }) => { recoveredAdmissionKey = input.admissionKey; return recoveredRun; },
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		await resumeMission(test.pi, test.state, "user inspected ambiguous launch");
		test.runtime.onResumed(test.ctx);
		await vi.waitFor(() => expect(test.state.read()?.reviewRunId).toBe("recovered-review"), { timeout: 500 });
		expect(test.state.read()?.reviewStatus).toBe("running");
		expect(recoveredAdmissionKey).toBe("review-ambiguous");
		clearSubagentService(service);
	});

	it("rotates an ambiguous admission only after the old candidate's run settles", async () => {
		let fingerprint = "candidate-a";
		const test = await setup({ fingerprint: () => fingerprint });
		const candidateA = await test.runtime.completionCandidateId(test.ctx);
		const oldRun = { spec: { id: "old-review", admissionKey: "review-old" }, runtime: { status: "running" } } as DelegateRun;
		test.state.append(test.pi, test.state.reviewEvent("starting", { candidateId: candidateA, worktreeFingerprint: expectedFingerprint(fingerprint), admissionId: "review-old" }));
		await test.emit("session_start", { reason: "resume" });
		await vi.waitFor(() => expect(test.state.readAny()?.status).toBe("blocked"), { timeout: 500 });
		fingerprint = "candidate-b";
		let launches = 0;
		let newAdmissionKey: string | undefined;
		const service = {
			list: () => ({ runs: [oldRun], groups: [] }),
			start: async (input: { admissionKey?: string }) => { launches++; newAdmissionKey = input.admissionKey; return { spec: { id: "new-review" }, runtime: { status: "running" } } as DelegateRun; },
			executor: { get: () => undefined, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			await resumeMission(test.pi, test.state, "user inspected ambiguous launch");
			test.runtime.onResumed(test.ctx);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(launches).toBe(0);
			oldRun.runtime.status = "completed";
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(launches).toBe(1);
			expect(newAdmissionKey).not.toBe("review-old");
			expect(test.state.read()).toMatchObject({ reviewStatus: "running", reviewRunId: "new-review", reviewAdmissionId: newAdmissionKey });
		} finally {
			clearSubagentService(service);
		}
	});

	it.each([
		{ severity: "minor", submitted: "changes_requested", expected: "clear", blocking: 0, backlog: 1 },
		{ severity: "major", submitted: "clear", expected: "changes_requested", blocking: 1, backlog: 0 },
	] as const)("derives release disposition from $severity severity instead of submitted verdict", async ({ severity, submitted, expected, blocking, backlog }) => {
		const test = await setup();
		const artifactsDir = mkdtempSync(join(tmpdir(), "mission-severity-"));
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		const run = { spec: { id: `review-${severity}`, artifactsDir }, runtime: { status: "completed", output: "" } } as unknown as DelegateRun;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			executor: { get: () => run, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, candidateId, worktreeFingerprint: expectedFingerprint() }));
			writeFileSync(join(artifactsDir, "review-report.json"), JSON.stringify({ version: 1, verdict: submitted, findings: [{ severity, summary: "typed finding" }] }));
			const internal = test.runtime as unknown as { reconcileReview: () => Promise<boolean> };
			expect(await internal.reconcileReview()).toBe(true);
			expect(test.state.read()).toMatchObject({ reviewStatus: "awaiting_adjudication", reviewSuggestedVerdict: expected, reviewBlockingFindingCount: blocking, reviewBacklogFindingCount: backlog, reviewHighestSeverity: severity });
		} finally {
			rmSync(artifactsDir, { recursive: true, force: true });
			clearSubagentService(service);
		}
	});

	it("blocks the fourth valid correction cycle until trusted authorization extends the numeric limit", async () => {
		const test = await setup();
		for (let cycle = 1; cycle <= 4; cycle++) {
			const runId = `review-${cycle}`;
			test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId, suggestedVerdict: "changes_requested", candidateId: `candidate-${cycle}` }));
			test.runtime.onProgress({ summary: `Adjudicate ${cycle}`, reviewVerdict: "changes_requested", reviewRunId: runId, reviewReason: "typed major finding" }, test.ctx);
		}
		expect(test.state.readAny()).toMatchObject({ status: "blocked", reviewCorrectionCount: 4, reviewCorrectionLimit: 3 });
		await expect(resumeMission(test.pi, test.state, "generic retry")).rejects.toThrow("review correction limit");
		let progressTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> }; if (value.name === "mission_progress") progressTool = value; } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined, { authorizeReviewContinuation: (ctx) => test.runtime.authorizeReviewContinuation(ctx) });
		const denied = { ...test.ctx, hasUI: true, ui: { ...test.ctx.ui, confirm: async () => false } } as unknown as ExtensionContext;
		await expect(progressTool!.execute("call", { summary: "continue", reviewContinue: true, reviewContinueReason: "user wants more" }, undefined, undefined, denied)).rejects.toThrow("not authorized");
		const approved = { ...test.ctx, hasUI: true, ui: { ...test.ctx.ui, confirm: async () => true } } as unknown as ExtensionContext;
		await progressTool!.execute("call", { summary: "continue", reviewContinue: true, reviewContinueReason: "user wants more" }, undefined, undefined, approved);
		expect(test.state.read()).toMatchObject({ status: "active", reviewCorrectionCount: 4, reviewCorrectionLimit: 6 });
	});

	it("rejects completion authorization when a skipped disposition belongs to an older fingerprint", async () => {
		let fingerprint = "waived";
		const test = await setup({ fingerprint: () => fingerprint });
		const admitted = expectedFingerprint(fingerprint);
		test.state.append(test.pi, test.state.workspaceFingerprintEvent(admitted));
		test.state.append(test.pi, test.state.reviewEvent("skipped", { worktreeFingerprint: admitted, skippedReason: "trusted waiver" }));
		fingerprint = "changed";
		await expect(test.runtime.authorizeCompletion(test.ctx)).rejects.toThrow("converged disposition to match the current workspace fingerprint");
		expect(test.state.read()?.completionLatchCandidateId).toBeUndefined();
	});

	it("requires fresh completion authorization when review disposition changes for the same candidate", async () => {
		const test = await setup();
		const fingerprint = expectedFingerprint();
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId, worktreeFingerprint: fingerprint }));
		await test.runtime.authorizeCompletion(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("skipped", { candidateId, worktreeFingerprint: fingerprint, skippedReason: "new waiver" }));
		expect(await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "validated" }] }, test.ctx)).toContain("Mission completion authorization does not match the current converged review disposition.");
		expect(() => test.state.completionEvent(candidateId!, "completion-stale-latch", [{ requirementIndex: 0, evidence: "validated" }])).toThrow("does not match the current review disposition");
	});

	it("latches completion to one candidate and repairs pending effects exactly once", async () => {
		let fingerprint = "candidate";
		const test = await setup({ fingerprint: () => fingerprint });
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "check", exitCode: 0 }] }));
		test.state.append(test.pi, test.state.reviewEvent("clear", { candidateId, worktreeFingerprint: expectedFingerprint(fingerprint) }));
		await test.runtime.authorizeCompletion(test.ctx);
		fingerprint = "changed";
		expect(await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "validated" }] }, test.ctx)).toContain("Mission completion is not user-authorized for the current objective/scope/fingerprint candidate.");
		fingerprint = "candidate";
		await test.runtime.authorizeCompletion(test.ctx);
		let effects = 0;
		const hooks = {
			validateCompletion: (input: Parameters<MissionRuntime["validateCompletion"]>[0], ctx: ExtensionContext) => test.runtime.validateCompletion(input, ctx),
			completionCandidateId: (ctx: ExtensionContext) => test.runtime.completionCandidateId(ctx),
			onCompleted: () => { effects++; if (effects === 1) throw new Error("first effect failed"); },
		};
		const input = { summary: "done", audit: [{ requirementIndex: 0, evidence: "validated" }] };
		const first = await completeMission(test.pi as unknown as ExtensionAPI, test.state, test.ctx, input, "complete", hooks);
		expect(first.mission).toMatchObject({ status: "complete", completionEffectsStatus: "pending" });
		const [second] = await Promise.all([
			completeMission(test.pi as unknown as ExtensionAPI, test.state, test.ctx, input, "complete", hooks),
			completeMission(test.pi as unknown as ExtensionAPI, test.state, test.ctx, input, "complete", hooks),
		]);
		expect(second.mission).toMatchObject({ status: "complete", completionEffectsStatus: "done" });
		await completeMission(test.pi as unknown as ExtensionAPI, test.state, test.ctx, input, "complete", hooks);
		expect(effects).toBe(2);
	});

	it("restores skipped and not-required convergence instead of relaunching an unchanged latched candidate", async () => {
		for (const reviewStatus of ["skipped", "not_required"] as const) {
			const test = await setup({ fingerprint: () => reviewStatus });
			const fingerprint = expectedFingerprint(reviewStatus);
			test.state.append(test.pi, test.state.workspaceFingerprintEvent(fingerprint));
			if (reviewStatus === "skipped") test.state.append(test.pi, test.state.reviewEvent("skipped", { worktreeFingerprint: fingerprint, skippedReason: "authorized skip" }));
			await test.runtime.authorizeCompletion(test.ctx);
			let launches = 0;
			const service = {
				list: () => ({ runs: [], groups: [] }),
				start: async () => { launches++; return { spec: { id: "unexpected-review" }, runtime: { status: "running" } } as DelegateRun; },
				executor: { get: () => undefined, onChange: () => () => undefined },
			} as unknown as SubagentService;
			setSubagentService(service);
			try {
				test.state.append(test.pi, test.state.reviewEvent("due", { reason: "synthetic replay" }));
				const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
				await internal.startReview(test.ctx, test.state.read()!);
				expect(launches).toBe(0);
				expect(test.state.read()).toMatchObject({ reviewStatus, completionLatchReviewStatus: reviewStatus });
			} finally {
				clearSubagentService(service);
			}
		}
	});

	it("defers legacy due admission until Subagent restoration completes", async () => {
		const test = await setup();
		let restored = false;
		let launches = 0;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { launches++; return { spec: { id: "legacy-due-review" }, runtime: { status: "running" } } as DelegateRun; },
			restorationComplete: () => restored,
			executor: { get: () => undefined, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "legacy due without admission key" }));
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(launches).toBe(0);
			expect(test.state.read()?.reviewStatus).toBe("due");
			restored = true;
			await internal.startReview(test.ctx, test.state.read()!);
			expect(launches).toBe(1);
			expect(test.state.read()).toMatchObject({ reviewStatus: "running", reviewRunId: "legacy-due-review" });
		} finally {
			clearSubagentService(service);
		}
	});

	it("waits for Subagent restoration before re-admitting a lost reviewer", async () => {
		const test = await setup();
		let restored = false;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => ({ spec: { id: "replacement-review" }, runtime: { status: "running" } }) as DelegateRun,
			restorationComplete: () => restored,
			executor: { get: () => { throw new Error("Unknown delegate run"); }, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: "missing-review", reason: "reviewing" }));
			await test.emit("session_start", { reason: "resume" });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(test.state.read()).toMatchObject({ reviewStatus: "running", reviewRunId: "missing-review" });
			restored = true;
			const internal = test.runtime as unknown as { recover: (ctx: ExtensionContext) => Promise<void> };
			await internal.recover(test.ctx);
			await vi.waitFor(() => expect(test.state.read()?.reviewRunId).toBe("replacement-review"), { timeout: 500 });
			expect(test.state.read()?.reviewStatus).toBe("running");
			expect(test.state.read()?.reviewReason).toContain("independent review run lost");
		} finally {
			clearSubagentService(service);
		}
	});

	it("keeps a durable ambiguous reservation when reviewer launch rejects", async () => {
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
			expect(test.state.read()?.reviewStatus).toBe("starting");
			expect(internal.recoveryTimer).toBeDefined();
			await vi.waitFor(() => expect(test.state.readAny()?.status).toBe("blocked"), { timeout: 500 });
			expect(test.state.readAny()?.lastReason).toContain("ambiguous");
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
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "first review timeout", failure: true }));
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "second review limit", failure: true }));
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, reason: "third review" }));
			await test.emit("session_start", { reason: "resume" });
			await vi.waitFor(() => expect(test.state.readAny()?.status).toBe("blocked"), { timeout: 500 });
			expect(test.messages).toEqual([]);
		} finally {
			clearSubagentService(service);
		}
	});

	it("does not reset recurring blockers from prose evidence or failed validation", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.progressEvent({ summary: "Still blocked", blocked: true, blockerId: "dependency", evidence: ["human claim"], validation: [{ command: "npm test", exitCode: 1 }] }));
		await test.emit("agent_settled");
		expect(test.state.readAny()?.blockerCount).toBe(1);
		await test.emit("agent_settled");
		expect(test.state.readAny()?.blockerCount).toBe(1);
		for (let attempt = 0; attempt < 2; attempt++) {
			test.state.append(test.pi, test.state.progressEvent({ summary: "Still blocked", blocked: true, blockerId: "dependency", evidence: ["human claim"], validation: [{ command: "npm test", exitCode: 1 }] }));
			await test.emit("agent_settled");
		}
		expect(test.state.readAny()?.blockerCount).toBe(3);
		expect(test.state.readAny()?.status).toBe("blocked");
	});

	it("parses repeatable typed paths from the direct Mission command", () => {
		expect(parseCreateArgs("Ship it --path repo-a --path 'repo b/file.ts' --path=repo-c")).toMatchObject({ objective: "Ship it", paths: ["repo-a", "repo b/file.ts", "repo-c"] });
		expect(() => parseCreateArgs("Ship it --path")).toThrow("--path requires a value");
		expect(() => parseCreateArgs("Ship it --path --budget 10")).toThrow("--path requires a value");
	});

	it("fingerprints explicit repositories from a non-Git parent workspace", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-workspace-"));
		const repoA = createGitRepo(parent, "repo-a");
		createGitRepo(parent, "repo-b");
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed workspace", paths: ["repo-a", "repo-b"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			await test.emit("turn_start");
			writeFileSync(join(repoA, "tracked.txt"), "changed\n");
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).toContain("Worktree differs from the last durable admitted workspace fingerprint.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("detects workspace changes between turns from a durable admitted fingerprint", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-interturn-workspace-"));
		const repo = createGitRepo(parent, "repo");
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed workspace", paths: ["repo"] }));
			test.state.append(test.pi, test.state.reviewEvent("not_required"));
			await test.emit("turn_start");
			expect(test.state.read()?.admittedWorktreeFingerprint).toBeTruthy();
			writeFileSync(join(repo, "tracked.txt"), "external change\n");
			await test.emit("session_start", { reason: "resume" });
			await vi.waitFor(() => expect(test.state.readAny()?.reviewReason).toContain("last admitted fingerprint"), { timeout: 1_000 });
			expect(["due", "starting", "running", "blocked"]).toContain(test.state.readAny()?.reviewStatus);
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("ignores changes outside an explicit path scope in the same repository", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-scoped-workspace-"));
		const repo = createGitRepo(parent, "repo");
		writeFileSync(join(repo, "other.txt"), "other\n");
		execFileSync("git", ["add", "other.txt"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "other"], { cwd: repo });
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed scope", paths: ["repo/tracked.txt"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			await test.emit("turn_start");
			writeFileSync(join(repo, "other.txt"), "unrelated change\n");
			execFileSync("git", ["add", "other.txt"], { cwd: repo });
			execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "unrelated commit"], { cwd: repo });
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).not.toContain("Worktree changed during this turn before independent review admission.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("hashes untracked symlink text without following its external target", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-untracked-symlink-"));
		const repo = createGitRepo(parent, "repo");
		const outside = join(parent, "outside.txt");
		writeFileSync(outside, "before\n");
		symlinkSync(outside, join(repo, "link.txt"));
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed scope", paths: ["repo"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			await test.emit("turn_start");
			writeFileSync(outside, "after\n");
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).not.toContain("Worktree changed during this turn before independent review admission.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("fails fingerprinting closed for oversized untracked files", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-untracked-large-"));
		const repo = createGitRepo(parent, "repo");
		const large = join(repo, "large.bin");
		writeFileSync(large, "");
		truncateSync(large, 17 * 1024 * 1024);
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed scope", paths: ["repo"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).toContain("Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("scopes automatic review to typed repositories from their shared parent", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-review-workspace-"));
		createGitRepo(parent, "repo-a");
		createGitRepo(parent, "repo-b");
		const test = await setup({ cwd: parent, exec: actualGitExec });
		let started: { cwd?: string; task?: string; deliverTerminal?: boolean } | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async (input: { cwd?: string; task?: string; deliverTerminal?: boolean }) => {
				started = input;
				return { spec: { id: "workspace-review" }, runtime: { status: "running", startedAt: Date.now() } } as DelegateRun;
			},
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed workspace", paths: ["repo-a", "repo-b"] }));
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(started).toBeDefined();
			expect(started?.cwd).toBe(parent);
			expect(started?.task).toContain("repo-a");
			expect(started?.task).toContain("repo-b");
			expect(started?.deliverTerminal).toBe(false);
			expect(test.state.read()?.reviewStatus).toBe("running");
		} finally {
			await test.emit("session_shutdown");
			clearSubagentService(service);
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("reviews the whole repository for a path-less Mission started in a subdirectory", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-pathless-subdir-"));
		const repo = createGitRepo(parent, "repo");
		const subdir = join(repo, "nested");
		mkdirSync(subdir);
		const test = await setup({ cwd: subdir, exec: actualGitExec });
		let started: { cwd?: string; task?: string } | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async (input: { cwd?: string; task?: string }) => {
				started = input;
				return { spec: { id: "pathless-review" }, runtime: { status: "running", startedAt: Date.now() } } as DelegateRun;
			},
			executor: { onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "test review" }));
			const internal = test.runtime as unknown as { startReview: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> };
			await internal.startReview(test.ctx, test.state.read()!);
			expect(started?.cwd).toBe(realpathSync(repo));
			expect(started?.task).toContain("workspace paths: .");
			expect(started?.task).not.toContain("nested");
		} finally {
			await test.emit("session_shutdown");
			clearSubagentService(service);
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("excludes generated Mission artifacts from a path-less whole-repository fingerprint", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-pathless-artifacts-"));
		const repo = createGitRepo(parent, "repo");
		const test = await setup({ cwd: repo, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			await test.emit("turn_start");
			const artifactDir = test.state.read()!.artifactDir;
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(join(artifactDir, "log.md"), "generated progress\n");
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).not.toContain("Worktree differs from the last durable admitted workspace fingerprint.");
			expect(blockers).not.toContain("Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("rejects missing typed paths instead of widening to their nearest directory", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-missing-path-"));
		createGitRepo(parent, "repo");
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed workspace", paths: ["repo/missing.txt"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).toContain("Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("rejects typed paths that escape the workspace through symlinks", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-symlink-workspace-"));
		const outside = mkdtempSync(join(tmpdir(), "mission-symlink-repo-"));
		const outsideRepo = createGitRepo(outside, "repo");
		symlinkSync(outsideRepo, join(parent, "outside-repo"));
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed workspace", paths: ["outside-repo"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).toContain("Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("fails closed without typed paths in a non-Git workspace", async () => {
		const parent = mkdtempSync(join(tmpdir(), "mission-nongit-"));
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).toContain("Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories.");
		} finally {
			await test.emit("session_shutdown");
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("vetoes same-turn completion when worktree differs from reviewed snapshot", async () => {
		let fingerprint = "reviewed";
		const test = await setup({ fingerprint: () => fingerprint });
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
		await test.emit("turn_start");
		fingerprint = "mutated";
		const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
		expect(blockers).toContain("Worktree differs from the last durable admitted workspace fingerprint.");
	});

	it("allows completion after an authorized waiver admits the mutated workspace", async () => {
		let fingerprint = "before";
		const test = await setup({ fingerprint: () => fingerprint });
		await test.emit("turn_start");
		fingerprint = "after";
		const admitted = expectedFingerprint("after");
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
		test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "trusted waiver", worktreeFingerprint: admitted }));
		await test.runtime.authorizeCompletion(test.ctx);
		const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
		expect(blockers).toEqual([]);
	});

	it("invalidates review admission after a clean HEAD change", async () => {
		let head = "reviewed-head";
		const test = await setup({ head: () => head });
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("clear", { worktreeFingerprint: expectedFingerprint("", head), candidateId }));
		head = "new-head";
		const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
		expect(blockers).toContain("Worktree differs from the severity-adjudicated reviewed candidate.");
	});

	it("vetoes completion until evidence, validation, and review converge", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "files changed" }));
		let blockers = await test.runtime.validateCompletion({ audit: [] }, test.ctx);
		expect(blockers.some((blocker) => blocker.includes("Missing non-empty evidence"))).toBe(true);
		expect(blockers.some((blocker) => blocker.includes("review"))).toBe(true);
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "   " }] }, test.ctx);
		expect(blockers.some((blocker) => blocker.includes("Missing non-empty evidence"))).toBe(true);
		expect(blockers).toContain("Requirement audit contains empty evidence.");
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "one" }, { requirementIndex: 0, evidence: "two" }] }, test.ctx);
		expect(blockers).toContain("Requirement audit contains duplicate requirementIndex entries.");

		test.state.append(test.pi, test.state.progressEvent({ summary: "Failed check", validation: [{ command: "npm test", exitCode: 1 }] }));
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 99, evidence: "wrong id" }] }, test.ctx);
		expect(blockers).toContain("No successful structured validation is recorded for the current objectiveVersion.");
		expect(blockers).toContain("Requirement audit contains an unknown requirementIndex.");

		test.state.append(test.pi, test.state.progressEvent({ summary: "Old validation", validation: [{ command: "npm test", exitCode: 0 }] }));
		test.state.append(test.pi, test.state.objectiveUpdateEvent({ objective: "Changed objective", reason: "Objective version changed" }));
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "old output" }] }, test.ctx);
		expect(blockers).toContain("No successful structured validation is recorded for the current objectiveVersion.");
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0, summary: "passed" }] }));
		const candidateId = await test.runtime.completionCandidateId(test.ctx);
		test.state.append(test.pi, test.state.reviewEvent("clear", { reason: "review clear", worktreeFingerprint: expectedFingerprint(), candidateId }));
		await test.runtime.authorizeCompletion(test.ctx);
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "test output and implementation diff" }] }, test.ctx);
		expect(blockers).toEqual([]);
	});
});
