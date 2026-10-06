import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, runs } from "../look.mjs";

export default {
	name: "subagent-idle-wake",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		const child = { agent: "child", steps: [{ id: "c1", text: "child done" }] };
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "subagent", args: { agent: "explorer", task: `POLYGON ${JSON.stringify(child)}`, model: "polygon/puppet" } },
			{ id: "s2", text: "launched" },
			{ id: "s3", text: "woke" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the first turn to settle");
		await lead.until((_, events) => runs(events) >= 2, 30_000, "a lead run started by the finished subagent, with no prompt");
		await lead.until((_, events) => events.filter((e) => e.type === "agent_settled").length >= 2, 30_000, "the woken turn to settle");
		const seen = requests(t).map((r) => `${r.agent}:${r.step}`);
		assert.ok(seen.includes("child:c1"), "the subagent never reached the puppet");
		assert.deepEqual(seen.filter((s) => s.startsWith("lead:")), ["lead:s1", "lead:s2", "lead:s3"]);
	},
};
