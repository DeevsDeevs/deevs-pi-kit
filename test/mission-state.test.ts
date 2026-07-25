import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MissionState } from "../extensions/mission/state.ts";
import type { MissionEvent } from "../extensions/mission/types.ts";

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

	it("uses unique project-contained artifact directories for repeated titles", async () => {
		const first = await new MissionState().create({ objective: "Same objective", title: "Same title", chain: "kit" }, setup().ctx);
		const second = await new MissionState().create({ objective: "Same objective", title: "Same title", chain: "kit" }, setup().ctx);
		expect(first.artifactDir).not.toBe(second.artifactDir);
		expect(first.artifactDir!.startsWith("/tmp/mission/.missions/")).toBe(true);
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

	it("counts continuation turns against the turn budget", async () => {
		const test = setup();
		const created = await test.state.create({ objective: "Do work", chain: "kit", turnBudget: 1 }, test.ctx);
		test.state.append(test.pi, created);
		test.state.append(test.pi, test.state.continuedEvent());
		expect(test.state.budgetExceeded()).toBe("turn");
	});
});
