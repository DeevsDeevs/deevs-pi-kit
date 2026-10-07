import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, sleep } from "../drive.mjs";
import { missionStates, notifications, requests, taskNotifications, toolCalls } from "../look.mjs";

// The reviewer's script rides in the goal, which the review prompt quotes. Its schema step answers with the first enum
// value, changes_requested, so both rounds run, and the second verdict closes the mission all the same.
const REVIEWER = `POLYGON ${JSON.stringify({ agent: "reviewer", steps: [{ id: "r1", schema: "auto", text: "stub" }] })}`;
const round = (n) => [
	{ id: `d${n}`, on: n === 1 ? "Mission continue" : undefined, tool: "mission_update", args: { log: `Built, round ${n}.`, next: "review", status: "done" } },
	{ id: `w${n}`, on: `Closing review round ${n} of 2`, tool: "Workflow", args: { scriptPath: "$/\\.missions/[a-z0-9-]+/review\\.js/" } },
	{ id: `x${n}`, text: "reviewing" },
	{ id: `v${n}`, on: "<task-notification>", tool: "mission_update", args: { log: `findings ${n}`, next: "fix", verdict: "$/changes_requested|clear/" } },
];
const MISSION_TOOLS = new Set(["mission_start", "mission_update", "Workflow"]);

export default {
	name: "mission-done",
	gate: "M5",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_start", args: { title: "done probe", goal: `Close after review.\n${REVIEWER}`, done: "Two review rounds ran.", review: true } },
			{ id: "s2", text: "started" },
			...round(1),
			...round(2),
			{ id: "s9", text: "closed" },
		] });
		await lead.until((e, events) => e.type === "agent_settled" && toolCalls(events).filter((c) => c.name === "mission_update").length >= 4, 80_000, "both review rounds");
		await sleep(1_500);
		const calls = toolCalls(lead.events).filter((c) => MISSION_TOOLS.has(c.name)).map((c) => [c.name, c.isError]);
		const reviewRound = [["mission_update", false], ["Workflow", false], ["mission_update", false]];
		assert.deepEqual(calls, [["mission_start", false], ...reviewRound, ...reviewRound]);
		assert.equal(notifications(lead.events).filter((n) => n.customType === "mission-continue").length, 1, "a continue ran during or after the review");
		assert.deepEqual(taskNotifications(lead.events).map((n) => JSON.parse(n.result).verdict), ["changes_requested", "changes_requested"]);
		assert.deepEqual(missionStates(t).map((s) => [s.status, s.reviews, s.reviewing]), [["done", 2, false]]);
		assert.ok(requests(t).some((r) => r.agent === "reviewer"), "no reviewer ran");
		const [slug] = readdirSync(join(t.repo, ".missions"));
		assert.match(readFileSync(join(t.repo, ".missions", slug, "log.md"), "utf8"), / done\n\nfindings 2\n$/, "the closing findings were not logged");
	},
};
