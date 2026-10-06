import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { poll, procs, taskNotifications, toolCalls } from "../look.mjs";

// TaskStop on a running agent: a killed report, and none of its tool children left behind.
export default {
	name: "taskstop",
	gate: "M1",
	async run(t) {
		const marker = join(t.repo, "bash-started");
		const child = { agent: "child", steps: [{ id: "b1", tool: "bash", args: { command: `touch ${marker}; sleep 300` } }, { id: "c1", text: "never" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "stoppable", name: "stoppable", prompt: `POLYGON ${JSON.stringify(child)}` } },
			{ id: "s2", tool: "bash", args: { command: `until [ -e ${marker} ]; do sleep 0.1; done` } },
			{ id: "s3", tool: "TaskStop", args: { task_id: "stoppable" } },
			{ id: "s4", tool: "TaskStop", args: { task_id: "stoppable" } },
			{ id: "s5", text: "stopped" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 1 && toolCalls(events).filter((c) => c.name === "TaskStop").length >= 2, 30_000, "the stopped agent's report and both stops");
		const [stop, again] = toolCalls(lead.events).filter((c) => c.name === "TaskStop");
		assert.equal(stop.isError, false);
		assert.equal(again.isError, true, "a second stop of a stopped agent succeeded");
		assert.equal(taskNotifications(lead.events)[0].status, "killed");
		await poll(() => procs(t).every((p) => p.pid === lead.pid || !p.argv.includes("sleep")), 10_000, "the agent's bash children to exit");
	},
};
