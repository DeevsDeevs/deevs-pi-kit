import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function expectedFingerprint(diff = "", head = "head"): string {
	return createHash("sha256").update(".").update("\0\0").update(head).update("\0").update(diff).update("\0").digest("hex");
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
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], { cwd: repo });
	return repo;
}

async function setup(options: { pending?: boolean; fingerprint?: () => string; head?: () => string; cwd?: string; exec?: (command: string, args: string[], options: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }> } = {}) {
	const branch: Array<Record<string, unknown>> = [];
	const cwd = options.cwd ?? realpathSync("/tmp");
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
		sessionManager: { getBranch: () => branch, getSessionFile: () => "/tmp/session.jsonl" },
		ui: { setStatus: () => undefined },
	} as unknown as ExtensionContext;
	const state = new MissionState();
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
		expect(test.messages).toHaveLength(1);
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

	it("lets the model-callable tool policy authorize recoverable user-requested closure", async () => {
		const test = await setup();
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx)).toEqual([]);
		expect(await test.runtime.validateCompletion({ userRequested: true }, test.ctx, true)).toEqual([]);
	});

	it("marks review due from a structured worktree fingerprint change regardless of tool prose", async () => {
		let fingerprint = "before";
		const test = await setup({ fingerprint: () => fingerprint });
		await test.emit("turn_start");
		fingerprint = "after";
		await test.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
		await test.emit("agent_settled");
		expect(test.state.read()?.reviewStatus).toBe("due");
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

		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-1", reason: "review settled" }));
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
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, reason: "reviewing", worktreeFingerprint: expectedFingerprint() }));
			await test.emit("session_start", { reason: "resume" });
			expect(test.messages).toEqual([]);
			run.runtime.status = "completed";
			run.runtime.output = "human explanation in any language";
			writeFileSync(join(artifactsDir, "review-report.json"), JSON.stringify({ version: 1, verdict: "clear", findings: [] }));
			listener?.(run);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(test.state.read()?.reviewStatus).toBe("awaiting_adjudication");
			expect(test.state.read()?.reviewSuggestedVerdict).toBe("clear");
			expect(test.messages).toHaveLength(1);
		} finally {
			rmSync(artifactsDir, { recursive: true, force: true });
			clearSubagentService(service);
		}
	});

	it("requires a new review when the worktree changes while review is running", async () => {
		let fingerprint = "before";
		const test = await setup({ fingerprint: () => fingerprint });
		const artifactsDir = mkdtempSync(join(tmpdir(), "mission-review-mutation-"));
		const run = { spec: { id: "review-mutation", artifactsDir }, runtime: { status: "running", output: "" } } as unknown as DelegateRun;
		let listener: ((candidate: DelegateRun) => void) | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
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
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(test.state.read()?.reviewStatus).toBe("due");
			expect(test.state.read()?.reviewReason).toContain("worktree changed while independent review was running");
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

	it("moves a lost reviewer run back to a recoverable due state", async () => {
		const test = await setup();
		const service = {
			list: () => ({ runs: [], groups: [] }),
			executor: { get: () => { throw new Error("Unknown delegate run"); }, onChange: () => () => undefined },
		} as unknown as SubagentService;
		setSubagentService(service);
		try {
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: "missing-review", reason: "reviewing" }));
			await test.emit("session_start", { reason: "resume" });
			expect(test.state.read()?.reviewStatus).toBe("due");
			expect(test.state.read()?.reviewReason).toContain("independent review run lost");
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
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "first review timeout", failure: true }));
			test.state.append(test.pi, test.state.reviewEvent("due", { reason: "second review limit", failure: true }));
			test.state.append(test.pi, test.state.reviewEvent("running", { runId: run.spec.id, reason: "third review" }));
			await test.emit("session_start", { reason: "resume" });
			expect(test.state.readAny()?.status).toBe("blocked");
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
			expect(blockers).toContain("Worktree changed during this turn before independent review admission.");
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
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "other"], { cwd: repo });
		const test = await setup({ cwd: parent, exec: actualGitExec });
		try {
			test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "typed scope", paths: ["repo/tracked.txt"] }));
			test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
			test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "test" }));
			await test.emit("turn_start");
			writeFileSync(join(repo, "other.txt"), "unrelated change\n");
			const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
			expect(blockers).not.toContain("Worktree changed during this turn before independent review admission.");
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
		let started: { cwd?: string; task?: string } | undefined;
		const service = {
			list: () => ({ runs: [], groups: [] }),
			start: async (input: { cwd?: string; task?: string }) => {
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
			expect(test.state.read()?.reviewStatus).toBe("running");
		} finally {
			await test.emit("session_shutdown");
			clearSubagentService(service);
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
		expect(blockers).toContain("Worktree changed during this turn before independent review admission.");
	});

	it("invalidates review admission after a clean HEAD change", async () => {
		let head = "reviewed-head";
		const test = await setup({ head: () => head });
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0 }] }));
		test.state.append(test.pi, test.state.reviewEvent("clear", { worktreeFingerprint: expectedFingerprint("", head) }));
		head = "new-head";
		const blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "recorded" }] }, test.ctx);
		expect(blockers).toContain("Worktree differs from the schema-validated reviewed snapshot.");
	});

	it("vetoes completion until evidence, validation, and review converge", async () => {
		const test = await setup();
		test.state.append(test.pi, test.state.reviewEvent("due", { reason: "files changed" }));
		let blockers = await test.runtime.validateCompletion({ audit: [] }, test.ctx);
		expect(blockers.some((blocker) => blocker.includes("Missing evidence"))).toBe(true);
		expect(blockers.some((blocker) => blocker.includes("review"))).toBe(true);

		test.state.append(test.pi, test.state.progressEvent({ summary: "Failed check", validation: [{ command: "npm test", exitCode: 1 }] }));
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 99, evidence: "wrong id" }] }, test.ctx);
		expect(blockers).toContain("No successful structured validation is recorded for the current objectiveVersion.");
		expect(blockers).toContain("Requirement audit contains an unknown requirementIndex.");

		test.state.append(test.pi, test.state.progressEvent({ summary: "Old validation", validation: [{ command: "npm test", exitCode: 0 }] }));
		test.state.append(test.pi, test.state.objectiveUpdateEvent({ reason: "Objective version changed" }));
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "old output" }] }, test.ctx);
		expect(blockers).toContain("No successful structured validation is recorded for the current objectiveVersion.");
		test.state.append(test.pi, test.state.progressEvent({ summary: "Validated", validation: [{ command: "npm test", exitCode: 0, summary: "passed" }] }));
		test.state.append(test.pi, test.state.reviewEvent("clear", { reason: "review clear", worktreeFingerprint: expectedFingerprint() }));
		blockers = await test.runtime.validateCompletion({ audit: [{ requirementIndex: 0, evidence: "test output and implementation diff" }] }, test.ctx);
		expect(blockers).toEqual([]);
	});
});
