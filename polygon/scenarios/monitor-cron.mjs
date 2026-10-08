import assert from "node:assert/strict";
import { rpc, sleep } from "../drive.mjs";
import { requests, runs, taskNotifications, toolCalls } from "../look.mjs";

// A stopped every-minute timer and a one-shot for the next minute: exactly one fire, then a quiet minute after it.
export default {
	name: "monitor-cron",
	gate: ["M0", "M5"],
	slow: true,
	timeoutMs: 200_000,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Monitor", args: { cron: "* * * * *", prompt: "polygon-cron-stopped", description: "stopped timer" } },
			{ id: "s2", tool: "TaskStop", args: { task_id: "$/(?<=task )b[0-9a-z]{8}/" } },
			{ id: "s3", tool: "Monitor", args: { cron: "* * * * *", prompt: "polygon-cron-fired", once: true, description: "one-shot timer" } },
			{ id: "s4", text: "scheduled" },
			{ id: "s5", on: "polygon-cron-fired", text: "fired" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the scheduling turn to settle");
		await lead.until((_, events) => taskNotifications(events).length >= 1, 75_000, "the one-shot to fire");
		await sleep(Math.ceil(Date.now() / 60_000) * 60_000 - Date.now() + 5_000);

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["Monitor", false], ["TaskStop", false], ["Monitor", false]]);
		const [stopped, , oneShot] = calls.map((c) => c.details);
		const fires = taskNotifications(lead.events);
		assert.deepEqual(fires.map((n) => [n.taskId, n.event]), [[oneShot.taskId, "polygon-cron-fired"]], `the stopped timer ${stopped.taskId} must never fire`);
		assert.equal(runs(lead.events), 2);
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3", "s4", "s5"]);
	},
};
