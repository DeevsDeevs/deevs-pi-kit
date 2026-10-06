import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { entries, requests, runs } from "../look.mjs";

// A job finishes while the lead is busy, so its notification is steered; clear_queue (Esc) drops it before the next tool round.
export default {
	name: "esc-redeliver",
	gate: "M1",
	timing: true,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "job_start", args: { command: "sleep 1", description: "probe" } },
			{ id: "s2", tool: "bash", args: { command: "sleep 6" } },
			{ id: "s3", text: "busy turn done" },
			{ id: "s4", text: "woke" },
		] });
		await lead.until((e) => e.type === "tool_execution_start" && e.toolName === "bash", 30_000, "the lead's bash call");
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		await lead.send({ type: "clear_queue" });
		await lead.until((_, events) => events.filter((e) => e.type === "agent_settled").length >= 2, 30_000, "the redelivered notification's turn to settle");

		const kinds = entries(t).filter((e) => e.type === "message" || (e.type === "custom_message" && e.customType === "task-notification"))
			.map((e) => e.type === "custom_message" ? "notification" : e.message.role);
		assert.equal(kinds.filter((k) => k === "notification").length, 1, "exactly one task-notification reached the session");
		assert.deepEqual(kinds.slice(-3), ["assistant", "notification", "assistant"], "the notification arrived after the cleared run settled");
		assert.equal(runs(lead.events), 2);
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3", "s4"]);
	},
};
