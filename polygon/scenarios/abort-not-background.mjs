import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { taskNotifications } from "../look.mjs";

// Aborting the lead's turn leaves a background agent running; it completes and reports.
export default {
	name: "abort-not-background",
	gate: "M1",
	async run(t) {
		const child = { agent: "child", steps: [{ id: "b1", tool: "bash", args: { command: "sleep 2" } }, { id: "c1", text: "survived" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "survivor", prompt: script(child) } },
			{ id: "s2", tool: "bash", args: { command: "sleep 20" } },
			{ id: "s3", text: "done" },
		] });
		await lead.until((e) => e.type === "tool_execution_start" && e.toolName === "bash", 30_000, "the lead's long bash");
		await lead.send({ type: "abort" });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the background agent's report");
		assert.equal(taskNotifications(lead.events)[0].status, "completed");
	},
};
