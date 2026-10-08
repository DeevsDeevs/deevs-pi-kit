import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { requests, runs, settled } from "../look.mjs";

// A run woken by a report starts without before_agent_start. The open mission, here started mid-run, is in every request's
// prompt from mission_start until it closes; the report's own message carries a due chain checkpoint.
const GUIDANCE = "Work toward the done criteria without waiting for the user.";
const CHECKPOINT = "Chain checkpoint: context reached 80%.";
const child = script({ agent: "child", steps: [{ id: "w1", tool: "bash", args: { command: "sleep 1" } }, { id: "c1", text: "child done" }] });

export default {
	name: "mission-report-wake",
	gate: "M5",
	async run(t) {
		t.marks.push(GUIDANCE, CHECKPOINT);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_start", args: { title: "wake probe", goal: "Keep the mission across a report.", done: "The woken run closed it." } },
			{ id: "s2", tool: "Agent", args: { description: "probe", prompt: child, run_in_background: true } },
			// 85% of the puppet's 200k window: the checkpoint falls due as this run settles.
			{ id: "s3", usage: 170_000, text: "launched" },
			{ id: "s4", on: "task-notification", tool: "bash", args: { command: "true" } },
			{ id: "s5", tool: "mission_update", args: { log: "The report arrived.", next: "none", status: "done" } },
			{ id: "s6", text: "closed" },
		] });
		await lead.until((_, events) => runs(events) >= 2 && settled(events) >= 2, 60_000, "the report-woken run to settle");
		const lead_ = requests(t).filter((r) => r.agent === "lead");
		assert.deepEqual(lead_.map((r) => r.step), ["s1", "s2", "s3", "s4", "s5", "s6"]);
		const carry = (mark) => lead_.filter((r) => r.marks.includes(mark)).map((r) => r.step);
		assert.deepEqual(carry(GUIDANCE), ["s2", "s3", "s4", "s5"], "the requests while the mission is open carry it");
		assert.deepEqual(carry(CHECKPOINT), ["s4", "s5", "s6"], "the woken run's requests carry the checkpoint");
	},
};
