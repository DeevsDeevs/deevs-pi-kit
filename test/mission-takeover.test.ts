import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { MissionState, MISSION_CUSTOM_TYPE } from "../extensions/mission/state.ts";
import { withMissionLock } from "../extensions/mission/persistence.ts";
import { discoverMissionTakeoverCandidates } from "../extensions/mission/takeover.ts";
import { registerMissionTools } from "../extensions/mission/tools.ts";
import type { MissionTakeoverCandidate } from "../extensions/mission/types.ts";

const cleanup: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(cwd: string, sessionId: string) {
	const branch: Array<Record<string, unknown>> = [];
	const sessionFile = path.join(cwd, `${sessionId}.jsonl`);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: { confirm: async () => true, notify: () => undefined },
		sessionManager: { getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => sessionFile },
	} as unknown as ExtensionContext;
	const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	return { branch, ctx, pi, sessionFile };
}

async function sourceMission(cwd: string) {
	const source = session(cwd, "source-session");
	const state = new MissionState();
	state.loadFromSession(source.ctx);
	state.append(source.pi, await state.create({ objective: "Finish recovery", requirements: ["Recovery works"], chain: "recovery", tokenBudget: 10_000 }, source.ctx));
	state.append(source.pi, state.progressEvent({ summary: "Started", evidence: ["source evidence"] }));
	return { ...source, state, candidate: { snapshot: state.exportSnapshot(state.readOwner()!), source: "snapshot" } as MissionTakeoverCandidate };
}

describe("Mission takeover", () => {
	it("atomically transfers one writer, carries progress, and fences the old session", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-takeover-"));
		cleanup.push(cwd);
		const source = await sourceMission(cwd);
		const first = session(cwd, "new-session");
		const second = session(cwd, "racing-session");
		const firstState = new MissionState();
		const secondState = new MissionState();
		source.candidate.snapshot.reviewFailureCount = 2;

		const taken = firstState.takeover(first.pi, source.candidate, first.ctx, "source session broke");
		expect(taken).toMatchObject({ status: "active", reviewStatus: "due", lastReason: "source session broke" });
		expect(taken.generation).not.toBe(source.candidate.snapshot.mission.generation);
		expect(firstState.readProgress().map((item) => item.summary)).toEqual(["Started"]);
		expect(firstState.readOwner()?.sessionId).toBe("new-session");
		expect(firstState.readReviewFailureCount()).toBe(0);
		expect(firstState.progressEvent({ summary: "new owner can mutate" }).kind).toBe("progress");
		expect(first.branch.some((entry) => (entry.data as { kind?: string })?.kind === "taken_over")).toBe(true);

		expect(() => secondState.takeover(second.pi, source.candidate, second.ctx, "race")).toThrow("ownership changed");
		source.state.loadFromSession(source.ctx);
		expect(source.state.readAny()).toBeUndefined();
		expect(source.state.readOwnershipConflict()).toEqual({ missionId: taken.missionId, ownerSessionId: "new-session" });
		expect(() => source.state.progressEvent({ summary: "late write" })).toThrow("controlled by session new-session");

		rmSync(path.join(cwd, ".missions", taken.slug), { recursive: true, force: true });
		source.state.loadFromSession(source.ctx);
		expect(source.state.readAny()).toBeUndefined();
		expect(source.state.readOwnershipConflict()?.ownerSessionId).toBe("new-session");

		firstState.append(first.pi, firstState.statusEvent("ended", "finished"));
		const replacement = session(cwd, "replacement-session");
		expect(await discoverMissionTakeoverCandidates(replacement.ctx)).toEqual([]);
	});

	it("discovers a pre-upgrade Mission from its exact same-cwd session branch", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-legacy-takeover-"));
		cleanup.push(cwd);
		const source = session(cwd, "legacy-session");
		const legacy = new MissionState();
		legacy.loadLegacyBranch(source.branch as Array<any>, cwd);
		const event = await legacy.create({ objective: "Legacy objective", chain: "legacy" }, source.ctx);
		source.pi.appendEntry(MISSION_CUSTOM_TYPE, event);
		const replay = new MissionState();
		replay.loadLegacyBranch(source.branch as Array<any>, cwd);

		const info = { path: source.sessionFile, id: "legacy-session", cwd } as SessionInfo;
		const manager = { getBranch: () => source.branch };
		vi.spyOn(SessionManager, "list").mockResolvedValue([info]);
		vi.spyOn(SessionManager, "open").mockReturnValue(manager as unknown as SessionManager);
		const current = session(cwd, "current-session");
		const candidates = await discoverMissionTakeoverCandidates(current.ctx);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ source: "legacy_session", snapshot: { owner: { sessionId: "legacy-session" }, mission: { objective: "Legacy objective" } } });
		expect(replay.readAny()?.missionId).toBe(candidates[0]?.snapshot.mission.missionId);
	});

	it("requires trusted confirmation and resumes immediately through mission_takeover", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-tool-takeover-"));
		cleanup.push(cwd);
		const source = await sourceMission(cwd);
		const target = session(cwd, "tool-session");
		const state = new MissionState();
		let tool: { execute: (...args: unknown[]) => Promise<{ details?: { mission?: { status?: string; reviewStatus?: string } } }> } | undefined;
		let takenOver = 0;
		const pi = {
			...target.pi,
			appendEntry() { throw new Error("session mirror unavailable"); },
			registerTool(value: unknown) {
				const candidate = value as { name?: string } & typeof tool;
				if (candidate.name === "mission_takeover") tool = candidate;
			},
		} as unknown as ExtensionAPI;
		const refreshed = structuredClone(source.candidate);
		refreshed.snapshot.usage = { mainTokens: 123, subagentTokens: 0, totalTokens: 123, mainCostUsd: 0, subagentCostUsd: 0, totalCostUsd: 0 };
		refreshed.snapshot.carriedUsage = { ...refreshed.snapshot.usage };
		let discoveries = 0;
		registerMissionTools(pi, state, () => undefined, { discoverTakeoverCandidates: async () => [discoveries++ ? refreshed : source.candidate], onTakenOver: () => { takenOver++; } });
		const projection = path.join(cwd, ".missions", source.candidate.snapshot.mission.slug, "mission.md");
		mkdirSync(path.dirname(projection), { recursive: true });
		const outsideProjection = path.join(cwd, "outside.md");
		writeFileSync(outsideProjection, "outside");
		symlinkSync(outsideProjection, projection);

		const result = await tool!.execute("call", { missionId: source.candidate.snapshot.mission.missionId, reason: "old session crashed" }, undefined, undefined, target.ctx);
		expect(result.details?.mission).toMatchObject({ status: "active", reviewStatus: "due" });
		expect(state.readUsage().totalTokens).toBe(123);
		expect(discoveries).toBe(2);
		expect(takenOver).toBe(1);
	});

	it("requires renewed confirmation when the controller changes during the prompt", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-reconfirm-"));
		cleanup.push(cwd);
		const source = await sourceMission(cwd);
		const target = session(cwd, "reconfirm-session");
		const state = new MissionState();
		let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const pi = { ...target.pi, registerTool(value: unknown) { const candidate = value as { name?: string } & typeof tool; if (candidate.name === "mission_takeover") tool = candidate; } } as unknown as ExtensionAPI;
		const changed = structuredClone(source.candidate);
		changed.snapshot.owner = { sessionId: "different-controller", sessionFile: path.join(cwd, "different.jsonl") };
		changed.snapshot.revision++;
		let discoveries = 0;
		registerMissionTools(pi, state, () => undefined, { discoverTakeoverCandidates: async () => [discoveries++ ? changed : source.candidate] });

		await expect(tool!.execute("call", { missionId: source.candidate.snapshot.mission.missionId, reason: "old session crashed" }, undefined, undefined, target.ctx)).rejects.toThrow("ownership changed after confirmation");
		expect(state.readAny()).toBeUndefined();
	});

	it("serializes different-slug creation and rejects symlinked state on read", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-create-lock-"));
		cleanup.push(cwd);
		const first = session(cwd, "creator-one");
		const second = session(cwd, "creator-two");
		const firstState = new MissionState();
		const secondState = new MissionState();
		firstState.loadFromSession(first.ctx);
		secondState.loadFromSession(second.ctx);
		const firstEvent = await firstState.create({ objective: "First", chain: "first" }, first.ctx);
		const secondEvent = await secondState.create({ objective: "Second", chain: "second" }, second.ctx);
		firstState.append(first.pi, firstEvent)!;
		expect(() => secondState.append(second.pi, secondEvent)).toThrow("A Mission already exists in this workspace");

		const statePath = path.join(cwd, ".missions", ".state");
		const outside = mkdtempSync(path.join(tmpdir(), "mission-state-outside-"));
		cleanup.push(outside);
		rmSync(statePath, { recursive: true });
		symlinkSync(outside, statePath, "dir");
		firstState.loadFromSession(first.ctx);
		expect(firstState.readPersistenceError()).toContain("not a real directory");
	});

	it("recovers a crashed holder's stale lock but keeps a live lock exclusive", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "mission-stale-lock-"));
		cleanup.push(cwd);
		const source = await sourceMission(cwd);
		const slug = source.candidate.snapshot.mission.slug;
		const lock = path.join(cwd, ".missions", ".state", ".locks", slug);
		mkdirSync(lock, { recursive: true });
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		// A lock left behind by a SIGKILLed holder (stale by age, no live owner) must be reclaimed, not brick the Mission forever.
		expect(withMissionLock(cwd, slug, () => "ran")).toBe("ran");
		// A freshly-held live lock is still exclusive.
		withMissionLock(cwd, slug, () => {
			expect(() => withMissionLock(cwd, slug, () => undefined)).toThrow("Mission state is busy");
		});

		const snapshotFile = path.join(cwd, ".missions", ".state", `${slug}.json`);
		const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
		snapshot.carriedUsage.mainTokens = 77;
		snapshot.carriedUsage.totalTokens = 0;
		writeFileSync(snapshotFile, JSON.stringify(snapshot));
		const restored = new MissionState();
		restored.loadFromSession(source.ctx);
		expect(restored.readUsage().totalTokens).toBe(77);
	});
});
