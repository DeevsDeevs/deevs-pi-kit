import assert from "node:assert/strict";
import { rpc, sleep } from "../drive.mjs";
import { missionStates, notifications, requests, runs, settled, toolCalls } from "../look.mjs";

// The first continue closes the mission and nothing continues after done. The closing review (step 5.4) needs
// the Workflow tool; until it lands, review:true closes with no review round, within the 2-round bound.
export default {
	name: "mission-done",
	gate: "M5",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_start", args: { title: "done probe", goal: "Close at once.", done: "The first continue arrived.", review: true } },
			{ id: "s2", text: "started" },
			{ id: "s3", on: "Mission continue", tool: "mission_update", args: { log: "The criteria hold.", next: "none", status: "done" } },
			{ id: "s4", text: "closed" },
		] });
		await lead.until((_, events) => settled(events) >= 2, 60_000, "the continued run to settle");
		await sleep(1_500);
		assert.deepEqual(toolCalls(lead.events).map((c) => [c.name, c.isError]), [["mission_start", false], ["mission_update", false]]);
		assert.equal(notifications(lead.events).filter((n) => n.customType === "mission-continue").length, 1);
		assert.equal(runs(lead.events), 2, "a continue ran after done");
		assert.deepEqual(missionStates(t).map((s) => [s.status, s.review]), [["done", true]]);
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3", "s4"]);
	},
};
