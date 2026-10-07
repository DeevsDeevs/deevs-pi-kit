import assert from "node:assert/strict";
import { agentStep, eventually, rpc, sleep } from "../drive.mjs";
import { sessionNotes, taskNotifications } from "../look.mjs";

const agent = (id, name, on) => agentStep(id, { agent: name, steps: [{ id: "c1", text: "done" }] }, { run_in_background: true }, on);

// kill -9 as Pi emits the notification (before its entry is written), then once the entry is on disk.
export default {
	name: "durable-kill9-ack",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		const reopen = async (count) => {
			await lead.restart();
			await eventually(() => sessionNotes(t).length >= count, 30_000, `${count} notification(s) in the session after reopening`);
			await sleep(2_000);
		};
		await lead.script({ agent: "lead", steps: [agent("s1", "before"), agent("s2", "after", "polygon-round-2")] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the first notification event");
		await reopen(1);
		await lead.prompt("polygon-round-2");
		await eventually(() => sessionNotes(t).length >= 2, 30_000, "the second notification's session entry");
		await reopen(2);
		const notes = sessionNotes(t);
		assert.equal(notes.length, 2, `expected exactly 1 notification per agent, got ${notes.length}`);
		assert.equal(new Set(notes.map((n) => n.taskId)).size, 2);
	},
};
