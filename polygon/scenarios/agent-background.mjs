import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { dialogs, requests, settled, taskNotifications, toolCalls } from "../look.mjs";

// On the puppet the bash step outlasts the lead's launch turn, so the reports wake an idle lead; a real lead may still be
// in its launch run and take them as steers.
const child = (n) => script({ agent: `child${n}`, steps: [{ id: `w${n}`, tool: "bash", args: { command: "sleep 1" } }, { id: `c${n}`, text: `child ${n} done` }] });

export default {
	name: "agent-background",
	gate: "M1",
	live: true,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			...[1, 2, 3].map((n) => ({ id: `s${n}`, tool: "Agent", args: { description: `probe ${n}`, prompt: child(n) } })),
			{ id: "s4", text: "launched" },
		] });
		await lead.until((e, events) => e.type === "agent_settled" && taskNotifications(events.slice(0, events.indexOf(e))).length >= 3, 90_000, "the lead to settle after 3 task notifications");
		const calls = toolCalls(lead.events).filter((c) => c.name === "Agent");
		assert.deepEqual(calls.map((c) => [c.isError, c.details?.status]), [[false, "async_launched"], [false, "async_launched"], [false, "async_launched"]]);
		const notes = taskNotifications(lead.events);
		assert.equal(notes.length, 3, "each agent notifies exactly once");
		assert.deepEqual(notes.map((n) => n.status), ["completed", "completed", "completed"]);
		assert.deepEqual(new Set(notes.map((n) => n.taskId)), new Set(calls.map((c) => c.details.agentId)));
		assert.ok(notes.every((n) => n.result?.trim()), "a notification carried an empty <result>");
		assert.equal(dialogs(lead.events), 0);
		if (t.live) return;
		assert.ok(settled(lead.events) >= 2, "no report woke the idle lead");
		assert.deepEqual(requests(t).filter((r) => r.agent?.startsWith("child")).map((r) => r.step).sort(), ["c1", "c2", "c3", "w1", "w2", "w3"]);
	},
};
