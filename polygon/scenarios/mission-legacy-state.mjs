import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, sleep } from "../drive.mjs";
import { notifications, requests, runs, toolCalls } from "../look.mjs";

const SLUG = "let-s-ship-the-final-product-cedfdb";
const SECTION = "<mission>";

// The old Missions' layout, shaped like a real one: active, a review running, $784 spent.
function legacyMission(root) {
	const state = {
		version: 1, revision: 263,
		owner: { sessionId: "019fd91a-0000-7000-8000-000000000000", sessionFile: "/home/polygon/.pi/agent/sessions/old.jsonl" },
		mission: {
			missionId: "m_polygon_cedfdb", title: "Let S Ship The Final Product", objective: "Ship the product.", requirements: ["Review each milestone."],
			status: "active", slug: SLUG, chain: `mission-${SLUG}`, chainBranch: "main", artifactDir: join(root, SLUG), paths: [],
			costBudgetUsd: 1000, turnCount: 412, reviewRunId: "a_polygon_794ef66c", reviewStatus: "running", reviewFailure: true,
		},
		progress: [{ missionId: "m_polygon_cedfdb", at: 1786114964555, summary: "Kickoff.", evidence: [], remaining: [], validation: [], checkpoint: true, blocked: false }],
		usage: { mainTokens: 40537024, subagentTokens: 0, totalTokens: 40537024, mainCostUsd: 783.68, subagentCostUsd: 0, totalCostUsd: 783.68 },
		usageComplete: true,
	};
	mkdirSync(join(root, ".state", ".locks"), { recursive: true });
	mkdirSync(join(root, SLUG));
	writeFileSync(join(root, ".state", `${SLUG}.json`), JSON.stringify(state, null, 2));
	writeFileSync(join(root, SLUG, "mission.md"), "# Mission: Let S Ship The Final Product\n\nStatus: active\n\n## Objective\nShip the product.\n");
	writeFileSync(join(root, SLUG, "log.md"), "# Mission Log: Let S Ship The Final Product\n\n## 2026-08-07T15:02:44.555Z checkpoint\n\nKickoff.\n");
}

export default {
	name: "mission-legacy-state",
	gate: "M5",
	async run(t) {
		const root = join(t.repo, ".missions");
		legacyMission(root);
		const registry = readFileSync(join(root, ".state", `${SLUG}.json`), "utf8");
		t.marks.push(SECTION);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_get", args: {} },
			{ id: "s2", text: "looked" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the prompted run to settle");
		await sleep(2_000);
		assert.deepEqual(toolCalls(lead.events).map((c) => [c.name, c.isError, c.details?.slug, c.details?.status, c.details?.legacy]), [["mission_get", false, SLUG, "paused", true]]);
		assert.equal(notifications(lead.events).filter((n) => n.customType?.startsWith("mission")).length, 0, "a legacy mission continued or raised a notice");
		assert.equal(runs(lead.events), 1);
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => [r.step, r.marks.includes(SECTION)]), [["s1", false], ["s2", false]]);
		assert.equal(readFileSync(join(root, ".state", `${SLUG}.json`), "utf8"), registry, "the old registry changed");
		assert.equal(existsSync(join(root, SLUG, "state.json")), false, "loading rewrote the old mission");
	},
};
