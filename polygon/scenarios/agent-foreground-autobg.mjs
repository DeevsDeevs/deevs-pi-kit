import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

// A foreground agent still running at 120 s returns the launch text, keeps running, and notifies when done.
export default {
	name: "agent-foreground-autobg",
	gate: "M1",
	slow: true,
	timeoutMs: 200_000,
	async run(t) {
		const quick = { agent: "quick", steps: [{ id: "q1", text: "quick answer" }] };
		const slow = { agent: "slow", steps: [{ id: "w1", tool: "bash", args: { command: "sleep 130", timeout: 200 } }, { id: "c1", text: "slow done" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "quick", prompt: script(quick), run_in_background: false } },
			{ id: "s2", tool: "Agent", args: { description: "slow", prompt: script(slow), run_in_background: false } },
			{ id: "s3", text: "returned" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 190_000, "the slow agent's report");
		const [quickCall, slowCall] = toolCalls(lead.events).filter((c) => c.name === "Agent");
		assert.deepEqual([quickCall.details.status, slowCall.details.status], ["completed", "async_launched"]);
		const notes = taskNotifications(lead.events);
		assert.deepEqual(notes.map((n) => [n.toolUseId, n.status]), [["s2", "completed"]], "the foreground result was also notified, or the slow one never was");
	},
};
