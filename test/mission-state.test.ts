import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MissionState } from "../extensions/mission/state.ts";
import type { MissionEvent } from "../extensions/mission/types.ts";
import { registerMissionTools } from "../extensions/mission/tools.ts";
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

		expect(inferred.title).toBe("Flaky Mission Naming Storage");
		expect(inferred.chain).toBe("mission-flaky-mission-naming-storage");
		expect(explicit.title).toBe("Human Readable Mission Names Stable Chain");
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
		const result = await completeTool!.execute("call", { userRequested: true }, undefined, undefined, test.ctx);
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

	it("counts continuation turns against the turn budget", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit", turnBudget: 1 }, test.ctx);
		test.state.append(test.pi, created);
		test.state.append(test.pi, test.state.continuedEvent());
		expect(test.state.budgetExceeded()).toBe("turn");
	});
});
