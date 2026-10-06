import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { entries, requests } from "../look.mjs";

const REMINDER = "The user hasn't heard from you in a while.";

export default {
	name: "silent-turn",
	gate: "M1",
	async run(t) {
		t.marks.push(REMINDER);
		const lead = rpc(t);
		const quiet = Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, tool: "bash", args: { command: "true" } }));
		await lead.script({ agent: "lead", steps: [...quiet, { id: "s8", text: "done" }] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");

		const leadRequests = requests(t).filter((r) => r.agent === "lead");
		assert.deepEqual(leadRequests.map((r) => r.step), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
		assert.deepEqual(leadRequests.map((r) => r.marks.includes(REMINDER)), [false, false, false, false, false, true, true, true], "the reminder reaches the request after the fifth silent turn");
		const reminders = entries(t).filter((e) => e.type === "custom_message" && e.customType === "silent-turn-reminder");
		assert.deepEqual(reminders.map((e) => e.display), [false]);
	},
};
