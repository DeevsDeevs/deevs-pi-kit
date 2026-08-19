import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MissionState } from "../extensions/mission/state.ts";
import type { MissionEvent } from "../extensions/mission/types.ts";
import { completeMission, registerMissionTools } from "../extensions/mission/tools.ts";
import { registerMissionCommands } from "../extensions/mission/commands.ts";

function setup() {
	const branch: Array<Record<string, unknown>> = [];
	const ctx = { cwd: "/tmp/mission", sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
	const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } };
	return { branch, ctx, pi, state: new MissionState() };
}

describe("Mission state", () => {
	it("creates generation-owned objectives, review state, and hard limits", async () => {
		const test = setup();
		const created = await test.state.create({
			objective: "Implement the runtime",
			requirements: ["Runtime works", "Tests pass"],
			chain: "kit",
			turnBudget: 2,
			wallDeadlineMs: 60_000,
		}, test.ctx);
		let mission = test.state.append(test.pi, created)!;

		expect(mission.generation).toBeTruthy();
		expect(mission.objectiveVersion).toBe(1);
		expect(mission.reviewStatus).toBe("not_required");
		expect(mission.turnBudget).toBe(2);
		expect(mission.wallDeadlineAt).toBeGreaterThan(Date.now());

		mission = test.state.append(test.pi, test.state.objectiveUpdateEvent({ objective: "Implement and migrate", requirements: ["Migrated"], reason: "Scope changed" }))!;
		expect(mission.objective).toBe("Implement and migrate");
		expect(mission.objectiveVersion).toBe(2);
		expect(mission.reviewStatus).toBe("due");

		mission = test.state.append(test.pi, test.state.reviewEvent("skipped", { skippedReason: "Documentation-only change" }))!;
		expect(mission.reviewStatus).toBe("skipped");
		expect(mission.reviewSkippedReason).toBe("Documentation-only change");
	});

	it("preserves meaningful leading digits while stripping explicit list markers", async () => {
		const test = setup();
		const mission = test.state.append(test.pi, await test.state.create({ objective: "Coverage", chain: "kit", requirements: ["100% coverage", "1. First check", "- Second check", "1.2 stays"] }, test.ctx));
		expect(mission?.requirements).toEqual(["100% coverage", "First check", "Second check", "1.2 stays"]);
	});

	it("rejects live replacement and oversized control lists instead of truncating", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "First", chain: "kit" }, test.ctx));
		await expect(test.state.create({ objective: "Second", chain: "kit" }, test.ctx)).rejects.toThrow("Mission already exists");
		const fresh = new MissionState();
		const first = fresh.create({ objective: "Concurrent first", chain: "kit" }, test.ctx);
		await expect(fresh.create({ objective: "Concurrent second", chain: "kit" }, test.ctx)).rejects.toThrow("being created");
		fresh.append(test.pi, await first);
		expect(() => test.state.objectiveUpdateEvent({ reason: "too many", requirements: Array.from({ length: 13 }, (_, index) => `req-${index}`) })).toThrow("requirements are limited to 12");
		expect(() => test.state.objectiveUpdateEvent({ reason: "too many", paths: Array.from({ length: 101 }, (_, index) => `path-${index}`) })).toThrow("paths are limited to 100");
	});

	it("keeps explicit display titles and stable Chain names while using Mission-ID artifact suffixes", async () => {
		const ctx = { ...setup().ctx, cwd: `/tmp/mission-${randomUUID()}` };
		const first = await new MissionState().create({ objective: "First objective", title: "  Readable   Mission Name  " }, ctx);
		const second = await new MissionState().create({ objective: "Second objective", title: "Readable Mission Name" }, ctx);

		expect(first.title).toBe("Readable Mission Name");
		expect(first.chain).toBe("mission-readable-mission-name");
		expect(second.chain).toBe(first.chain);
		expect(first.slug).toMatch(/^readable-mission-name-[0-9a-f]{6}$/);
		expect(second.slug).toMatch(/^readable-mission-name-[0-9a-f]{6}$/);
		expect(first.slug).toBe(`readable-mission-name-${first.missionId.slice(-6)}`);
		expect(second.slug).toBe(`readable-mission-name-${second.missionId.slice(-6)}`);
		expect(first.artifactDir).toBe(`${ctx.cwd}/.missions/${first.slug}`);
	});

	it("derives useful display titles from inferred or explicit requirements", async () => {
		const ctx = { ...setup().ctx, cwd: `/tmp/mission-${randomUUID()}` };
		const inferred = await new MissionState().create({ objective: "Fix flaky Mission naming and test storage" }, ctx);
		const explicit = await new MissionState().create({
			objective: "Document and verify the naming contract",
			requirements: ["Human-readable Mission names", "Stable Chain storage"],
		}, ctx);

		expect(inferred.title).toBe("Fix Flaky Mission Naming And Test");
		expect(inferred.chain).toBe("mission-fix-flaky-mission-naming-and-test");
		expect(explicit.title).toBe("Human-readable Mission Names");
		const multilingual = await new MissionState().create({ objective: "日本語の目標を完了する" }, ctx);
		expect(multilingual.title).toBe("日本語の目標を完了する");
		expect(multilingual.chain).toBe("mission-日本語の目標を完了する");
	});

	it("rejects stale generation outcomes and blocks after three repeated blockers", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx);
		let mission = test.state.append(test.pi, created)!;
		const stale: MissionEvent = { kind: "review_changed", missionId: mission.missionId, generation: "stale", at: Date.now(), reviewStatus: "clear" };
		mission = test.state.append(test.pi, stale)!;
		expect(mission.reviewStatus).toBe("not_required");

		for (let index = 0; index < 3; index++) {
			mission = test.state.append(test.pi, test.state.settledEvent({ blockerFingerprint: "need credentials", madeProgress: false }))!;
		}
		expect(mission.blockerCount).toBe(3);
	});

	it("accounts individual Subagent terminal usage exactly once", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx);
		test.state.append(test.pi, created);
		const runtimeOperation = {
			type: "emit",
			event: {
				version: 1,
				id: "terminal:a:g",
				dedupeKey: "subagent:a:g:terminal",
				source: { kind: "subagent", id: "a", generation: "g" },
				type: "terminal",
				status: "completed",
				delivery: "record_only",
				createdAt: Date.now(),
				summary: "done",
				usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 1, costUsd: 0.1 },
			},
		};
		test.branch.push({ type: "custom", customType: "deevs.runtime-event-op.v1", data: runtimeOperation });
		test.branch.push({ type: "custom", customType: "deevs.runtime-event-op.v1", data: runtimeOperation });
		test.state.loadFromSession(test.ctx);
		expect(test.state.readUsage()).toMatchObject({ subagentTokens: 15, subagentCostUsd: 0.1 });
	});

	it("freezes usage at terminal status in one branch pass", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx);
		test.state.append(test.pi, created);
		test.branch.push({ type: "message", message: { role: "assistant", usage: { input: 5, output: 2, cost: { total: 0.01 } } } });
		test.state.append(test.pi, test.state.statusEvent("complete", "done", "done"));
		test.branch.push({ type: "message", message: { role: "assistant", usage: { input: 100, output: 100, cost: { total: 1 } } } });
		test.state.loadFromSession(test.ctx);
		expect(test.state.readUsage()).toMatchObject({ totalTokens: 7, totalCostUsd: 0.01 });
	});

	it("checks resume admission before opening confirmation UI", async () => {
		const test = setup();
		let resumeTool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> } | undefined;
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> }; if (value.name === "mission_resume") resumeTool = value; } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined, { continuationBlockers: () => ["independent review still running: review-1"] });
		let confirmations = 0;
		const ctx = { ...test.ctx, hasUI: true, ui: { confirm: async () => { confirmations++; return true; } } } as unknown as ExtensionContext;
		await expect(resumeTool!.execute("call", { reason: "Nothing to resume" }, undefined, undefined, ctx)).rejects.toThrow("No Mission exists");
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		const result = await resumeTool!.execute("call", { reason: "Already running" }, undefined, undefined, ctx);
		expect(result.content[0]?.text).toContain("already active");
		expect(result.content[0]?.text).toContain("independent review still running: review-1");
		expect(confirmations).toBe(0);
	});

	it("lets the agent explicitly resume a paused Mission with a recorded reason", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", title: "Probe", chain: "kit" }, test.ctx);
		test.state.append(test.pi, created);
		test.state.append(test.pi, test.state.statusEvent("paused", "waiting for approval"));
		let resumeTool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> } | undefined;
		let resumed = 0;
		const pi = {
			...test.pi,
			registerTool(tool: unknown) {
				const value = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> };
				if (value.name === "mission_resume") resumeTool = value;
			},
		} as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined, { onResumed: () => { resumed++; } });
		await expect(resumeTool!.execute("call", { reason: "Headless" }, undefined, undefined, test.ctx)).rejects.toThrow("trusted /mission resume");
		const deniedCtx = { ...test.ctx, hasUI: true, ui: { confirm: async () => false } } as unknown as ExtensionContext;
		await expect(resumeTool!.execute("call", { reason: "Unconfirmed" }, undefined, undefined, deniedCtx)).rejects.toThrow("not authorized");
		expect(test.state.read()?.status).toBe("paused");
		const approvedCtx = { ...test.ctx, hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
		const result = await resumeTool!.execute("call", { reason: "User supplied approval" }, undefined, undefined, approvedCtx);
		expect(result.content[0]?.text).toContain("Mission resumed");
		expect(test.state.read()?.status).toBe("active");
		expect(test.state.read()?.lastReason).toBe("User supplied approval");
		expect(resumed).toBe(1);
	});

	it("does not resume a limited Mission through the direct command", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit", turnBudget: 1 }, test.ctx));
		test.state.append(test.pi, test.state.continuedEvent());
		test.state.append(test.pi, test.state.statusEvent("usage_limited", "turn limit exhausted"));
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		let continuations = 0;
		const pi = { ...test.pi, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI;
		registerMissionCommands(pi, test.state, () => undefined, () => { continuations++; });
		const notices: string[] = [];
		const ctx = { ...test.ctx, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
		await command!.handler("resume", ctx);
		expect(test.state.readAny()?.status).toBe("usage_limited");
		expect(continuations).toBe(0);
		expect(notices[0]).toContain("turn limit is exhausted");
	});

	it("tracks progress after continuation by event order rather than timestamp", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		const before = test.state.progressEvent({ summary: "before" });
		const continued = test.state.continuedEvent();
		continued.at = before.at;
		test.state.append(test.pi, before);
		test.state.append(test.pi, continued);
		expect(test.state.readProgressSinceContinuation()).toEqual([]);
		const after = test.state.progressEvent({ summary: "after" });
		after.at = continued.at;
		test.state.append(test.pi, after);
		expect(test.state.readProgressSinceContinuation().map((item) => item.summary)).toEqual(["after"]);
	});

	it("requires trusted confirmation for Mission updates and nonempty review waivers", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> }; tools.set(value.name, value); } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined, { workspaceFingerprint: async () => "waiver-fingerprint" });
		await expect(tools.get("mission_update")!.execute("call", { objective: "Changed", reason: "scope" }, undefined, undefined, test.ctx)).rejects.toThrow("/mission update command");
		const denied = { ...test.ctx, hasUI: true, ui: { confirm: async () => false } } as unknown as ExtensionContext;
		await expect(tools.get("mission_update")!.execute("call", { objective: "Changed", reason: "scope" }, undefined, undefined, denied)).rejects.toThrow("not authorized");
		const approved = { ...test.ctx, hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
		await tools.get("mission_update")!.execute("call", { objective: "Changed", reason: "scope" }, undefined, undefined, approved);
		expect(test.state.read()?.objective).toBe("Changed");
		await expect(tools.get("mission_progress")!.execute("call", { summary: "waive", reviewSkip: true }, undefined, undefined, approved)).rejects.toThrow("non-empty reviewSkipReason");
		await tools.get("mission_progress")!.execute("call", { summary: "waived", reviewSkip: true, reviewSkipReason: "trusted waiver" }, undefined, undefined, approved);
		expect(test.state.read()).toMatchObject({ reviewStatus: "skipped", reviewWorktreeFingerprint: "waiver-fingerprint", admittedWorktreeFingerprint: "waiver-fingerprint" });
	});

	it("refuses clear adjudication without a structured reviewer verdict", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-1" }));
		let progressTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as { name: string; execute: (...args: unknown[]) => Promise<unknown> }; if (value.name === "mission_progress") progressTool = value; } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined);
		const before = test.branch.length;
		await expect(progressTool!.execute("call", { summary: "Adjudicate", reviewVerdict: "clear", reviewRunId: "review-1", reviewReason: "report evidence" }, undefined, undefined, test.ctx)).rejects.toThrow("severity-derived reviewer verdict");
		expect(test.branch).toHaveLength(before);
		expect(test.state.readProgress()).toEqual([]);
		await expect(progressTool!.execute("call", { summary: "Invalid mixed control", reviewSkip: true, reviewSkipReason: "waive", reviewVerdict: "changes_requested", reviewRunId: "review-1", reviewReason: "report evidence" }, undefined, undefined, test.ctx)).rejects.toThrow("mutually exclusive");
		expect(test.branch).toHaveLength(before);
	});

	it("clears stale highest severity when a later report has no findings", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-major", suggestedVerdict: "changes_requested", highestSeverity: "major", blockingFindingCount: 1 }));
		expect(test.state.read()?.reviewHighestSeverity).toBe("major");
		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-clear", suggestedVerdict: "clear", blockingFindingCount: 0, backlogFindingCount: 0 }));
		expect(test.state.read()?.reviewHighestSeverity).toBeUndefined();
	});

	it("returns post-adjudication Mission state after the progress hook", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		test.state.append(test.pi, test.state.reviewEvent("awaiting_adjudication", { runId: "review-clear", suggestedVerdict: "clear" }));
		let progressTool: { execute: (...args: unknown[]) => Promise<{ details?: { mission?: { reviewStatus?: string } } }> } | undefined;
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as typeof progressTool & { name?: string }; if (value?.name === "mission_progress") progressTool = value; } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined, { onProgress: (input) => { if (input.reviewVerdict) test.state.append(test.pi, test.state.reviewEvent(input.reviewVerdict, { runId: input.reviewRunId, reason: input.reviewReason })); } });
		const result = await progressTool!.execute("call", { summary: "Adjudicated", reviewVerdict: "clear", reviewRunId: "review-clear", reviewReason: "structured report clear" }, undefined, undefined, test.ctx);
		expect(result.details?.mission?.reviewStatus).toBe("clear");
	});

	it("commits completion before best-effort side effects so a failing terminal event cannot leak", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", requirements: ["Works"], chain: "kit" }, test.ctx));
		const input = { summary: "done", audit: [{ requirementIndex: 0, evidence: "tests" }] };
		const ctx = { ...test.ctx, ui: { notify: () => undefined } } as unknown as ExtensionContext;
		test.state.append(test.pi, test.state.completionLatchEvent("candidate-test", "not_required"));
		// Status is committed first; a throwing onCompleted leaves durable pending effects without leaking a false active state.
		const completed = await completeMission(test.pi as unknown as ExtensionAPI, test.state, ctx, input, "complete", { completionCandidateId: async () => "candidate-test", onCompleted: () => { throw new Error("synthetic side effect failure"); } });
		expect(completed.mission?.status).toBe("complete");
		expect(test.state.readAny()?.status).toBe("complete");
	});

	it("keeps model guidance aligned with completion and takeover control semantics", () => {
		const test = setup();
		const tools = new Map<string, { promptGuidelines?: string[] }>();
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as { name: string; promptGuidelines?: string[] }; tools.set(value.name, value); } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined);
		const completion = tools.get("mission_complete")?.promptGuidelines?.join(" ") ?? "";
		const takeover = tools.get("mission_takeover")?.promptGuidelines?.join(" ") ?? "";
		expect(completion).toContain("complete or finish");
		expect(completion).toContain("end, stop, or abandon");
		expect(completion).not.toContain("end/complete/stop");
		expect(takeover).toContain("preserves an unchanged exact adjudicated candidate");
		expect(takeover).not.toContain("forces fresh review");
	});

	it("records user-requested closure as ended rather than achieved", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", title: "Probe", chain: "kit" }, test.ctx));
		let completeTool: { execute: (...args: unknown[]) => Promise<{ details?: { mission?: { status?: string }; audit?: Array<{ requirementIndex: number; evidence: string }> } }> } | undefined;
		const pi = { ...test.pi, registerTool(tool: unknown) { const value = tool as typeof completeTool & { name?: string }; if (value?.name === "mission_complete") completeTool = value; } } as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined);
		const ctx = { ...test.ctx, hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
		const result = await completeTool!.execute("call", { userRequested: true, audit: [{ requirementIndex: 0, evidence: "   " }, { requirementIndex: 0, evidence: "duplicate" }] }, undefined, undefined, ctx);
		expect(result.details?.mission?.status).toBe("ended");
		expect(result.details?.audit).toHaveLength(1);
		expect(result.details?.audit?.[0]?.evidence.trim()).toBeTruthy();
		expect(test.state.read()).toBeUndefined();
		expect(test.state.readAny()?.status).toBe("ended");
	});

	it("keeps completed Missions terminal under pause, progress, and update builders", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit" }, test.ctx));
		test.state.append(test.pi, test.state.statusEvent("complete", "done"));
		expect(() => test.state.statusEvent("paused", "invalid reopen")).toThrow("cannot transition from complete to paused");
		expect(() => test.state.progressEvent({ summary: "late progress" })).toThrow("terminal and cannot be mutated");
		expect(() => test.state.objectiveUpdateEvent({ reason: "late update", objective: "changed" })).toThrow("terminal and cannot be mutated");
	});

	it("treats repeated completion as idempotent", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", title: "Probe", chain: "kit" }, test.ctx);
		test.state.append(test.pi, created);
		test.state.append(test.pi, test.state.statusEvent("complete", "first completion", "done"));
		let completeTool: { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> } | undefined;
		const pi = {
			...test.pi,
			registerTool(tool: unknown) {
				const value = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: unknown }> };
				if (value.name === "mission_complete") completeTool = value;
			},
		} as unknown as ExtensionAPI;
		registerMissionTools(pi, test.state, () => undefined);
		const before = test.branch.length;
		const approvedCtx = { ...test.ctx, hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
		const result = await completeTool!.execute("call", { userRequested: true }, undefined, undefined, approvedCtx);
		expect(result.content[0]?.text).toContain("already complete");
		expect(test.branch).toHaveLength(before);
	});

	it("does not complete or checkpoint an already-complete Mission again through the command", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", title: "Probe", chain: "kit" }, test.ctx);
		test.state.append(test.pi, created);
		test.state.append(test.pi, test.state.statusEvent("complete", "first completion", "done"));
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		let completed = 0;
		const pi = {
			...test.pi,
			registerCommand(_name: string, value: typeof command) { command = value; },
		} as unknown as ExtensionAPI;
		registerMissionCommands(pi, test.state, () => undefined, () => undefined, { onCompleted: () => { completed++; } });
		const notices: string[] = [];
		const ctx = { ...test.ctx, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
		const before = test.branch.length;
		await command!.handler("end", ctx);
		expect(test.branch).toHaveLength(before);
		expect(completed).toBe(0);
		expect(notices).toEqual(["Mission already complete: Probe"]);
	});

	it("requires trusted confirmation before dashboard resume", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", title: "Probe", chain: "kit" }, test.ctx));
		test.state.append(test.pi, test.state.statusEvent("paused", "pause"));
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		let dashboard: { handleInput: (data: string) => void } | undefined;
		let confirmations = 0;
		const pi = { ...test.pi, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI;
		registerMissionCommands(pi, test.state, () => undefined, () => undefined);
		const ctx = {
			...test.ctx,
			mode: "tui",
			hasUI: true,
			ui: {
				confirm: async () => { confirmations++; return false; },
				notify: () => undefined,
				custom: async (factory: (...args: unknown[]) => unknown) => { dashboard = factory({ requestRender: () => undefined, terminal: { rows: 24 } }, {}, {}, () => undefined) as typeof dashboard; },
			},
		} as unknown as ExtensionContext;
		await command!.handler("", ctx);
		dashboard!.handleInput("p");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(confirmations).toBe(1);
		expect(test.state.read()?.status).toBe("paused");
	});

	it("routes the direct end command through the shared completion validator", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", title: "Probe", chain: "kit" }, test.ctx);
		test.state.append(test.pi, created);
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
		let directUserRequest = false;
		let completed = 0;
		const pi = {
			...test.pi,
			registerCommand(_name: string, value: typeof command) { command = value; },
		} as unknown as ExtensionAPI;
		registerMissionCommands(pi, test.state, () => undefined, () => undefined, {
			validateCompletion: (_input, _ctx, direct) => { directUserRequest = direct === true; return ["synthetic blocker"]; },
			onCompleted: () => { completed++; },
		});
		const notices: string[] = [];
		const ctx = { ...test.ctx, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
		await command!.handler("end", ctx);
		expect(directUserRequest).toBe(true);
		expect(test.state.read()?.status).toBe("active");
		expect(completed).toBe(0);
		expect(notices[0]).toContain("synthetic blocker");
	});

	it("defaults cost to $1,000 and lets a reasoned update remove the token cap", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit", tokenBudget: 10, wallDeadlineMs: 10 }, test.ctx);
		test.state.append(test.pi, created);
		expect(test.state.read()).toMatchObject({ tokenBudget: 10, costBudgetUsd: 1_000 });
		test.state.append(test.pi, test.state.objectiveUpdateEvent({ tokenBudget: null, costBudgetUsd: 2_000, turnBudget: null, wallDeadlineMs: null, reason: "User revised Mission limits" }));
		expect(test.state.read()?.tokenBudget).toBeUndefined();
		expect(test.state.read()?.costBudgetUsd).toBe(2_000);
		expect(test.state.read()?.wallDeadlineAt).toBeUndefined();
	});

	it("detects exhausted limits even while Mission status is limited", async () => {
		const test = setup();
		test.state.append(test.pi, await test.state.create({ objective: "Do work", chain: "kit", tokenBudget: 1 }, test.ctx));
		test.branch.push({ type: "message", message: { role: "assistant", usage: { input: 2, output: 0, cost: { total: 0 } } } });
		test.state.append(test.pi, test.state.statusEvent("budget_limited", "token exhausted"));
		test.state.loadFromSession(test.ctx);
		expect(test.state.budgetExceeded()).toBeNull();
		expect(test.state.limitExceeded()).toBe("token");
	});

	it("counts continuation turns against the turn budget", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit", turnBudget: 1 }, test.ctx);
		test.state.append(test.pi, created);
		test.state.append(test.pi, test.state.continuedEvent());
		expect(test.state.budgetExceeded()).toBe("turn");
	});
});
