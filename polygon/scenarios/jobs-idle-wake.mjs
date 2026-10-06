import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, runs } from "../look.mjs";

export default {
	name: "jobs-idle-wake",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "job_start", args: { command: "sleep 1; echo polygon-ok", description: "probe" } },
			{ id: "s2", text: "started" },
			{ id: "s3", text: "woke" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the first turn to settle");
		await lead.until((_, events) => runs(events) >= 2, 30_000, "a lead run started by the finished job, with no prompt");
		await lead.until((_, events) => events.filter((e) => e.type === "agent_settled").length >= 2, 30_000, "the woken turn to settle");
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3"]);
	},
};
