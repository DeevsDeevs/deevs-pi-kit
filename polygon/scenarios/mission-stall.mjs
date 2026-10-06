import assert from "node:assert/strict";
import { rpc, sleep } from "../drive.mjs";
import { missionStates, notifications, requests, runs } from "../look.mjs";

const count = (events, customType) => notifications(events).filter((n) => n.customType === customType).length;

// The puppet starts a mission, then answers every continue with idle text: no mission_update and no commit.
export default {
	name: "mission-stall",
	gate: "M5",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_start", args: { title: "stall probe", goal: "Make no progress.", done: "Never." } },
			{ id: "s2", text: "started" },
		] });
		await lead.until((_, events) => count(events, "mission-notice") > 0, 60_000, "the stall notice");
		await sleep(1_500);
		assert.equal(count(lead.events, "mission-continue"), 3, "three continues before the stall guard");
		assert.equal(count(lead.events, "mission-notice"), 1, "exactly one notice");
		assert.equal(runs(lead.events), 4, "the prompted run and one run per continue");
		assert.deepEqual(missionStates(t).map((s) => [s.status, s.quietContinues]), [["paused", 3]]);
		assert.equal(requests(t).filter((r) => r.agent === "lead").length, 5);
	},
};
