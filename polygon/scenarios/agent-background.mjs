import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { dialogs, requests, settled, taskNotifications, toolCalls } from "../look.mjs";

// The bash step outlasts the lead's launch turn, so the reports wake an idle lead.
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
		await lead.until((_, events) => taskNotifications(events).length >= 3, 60_000, "3 task notifications");
		await lead.until((_, events) => settled(events) >= 2, 30_000, "the woken turns to settle");
		const calls = toolCalls(lead.events).filter((c) => c.name === "Agent");
		assert.deepEqual(calls.map((c) => [c.isError, c.details?.status]), [[false, "async_launched"], [false, "async_launched"], [false, "async_launched"]]);
		const notes = taskNotifications(lead.events);
		assert.equal(notes.length, 3, "each agent notifies exactly once");
		assert.deepEqual(notes.map((n) => n.status), ["completed", "completed", "completed"]);
		assert.deepEqual(new Set(notes.map((n) => n.taskId)), new Set(calls.map((c) => c.details.agentId)));
		assert.ok(notes.every((n) => n.result?.trim()), "a notification carried an empty <result>");
		assert.equal(dialogs(lead.events), 0);
		const children = requests(t).filter((r) => r.agent?.startsWith("child"));
		// A real model's tool call ids never mark a script step said, so live runs check only who asked.
		if (t.live) assert.deepEqual([...new Set(children.map((r) => r.agent))].sort(), ["child1", "child2", "child3"]);
		else assert.deepEqual(children.map((r) => r.step).sort(), ["c1", "c2", "c3", "w1", "w2", "w3"]);
	},
};
