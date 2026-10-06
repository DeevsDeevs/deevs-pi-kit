import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, sleep } from "../drive.mjs";
import { poll, procs, taskNotifications, toolCalls } from "../look.mjs";
import { launches, say } from "./wf-shapes.mjs";

// TaskStop by run id: the agents stop, the run record says killed, and no notification follows, as in CC.
export default {
	name: "wf-taskstop",
	gate: "M3",
	async run(t) {
		const marker = join(t.repo, "stuck-started");
		const source = [
			'export const meta = { name: "stuck", description: "One agent that never ends" };',
			`return await agent(${say("stuck", [{ id: "b", tool: "bash", args: { command: `touch ${marker}; sleep 300` } }, { id: "c", text: "never" }])}, { label: "stuck" });`,
		].join("\n");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Workflow", args: { script: source } },
			{ id: "s2", tool: "bash", args: { command: `until [ -e ${marker} ]; do sleep 0.1; done` } },
			{ id: "s3", tool: "TaskStop", args: { task_id: "$/wf_[0-9a-f]{8}-[0-9a-f]{3}/" } },
			{ id: "s4", text: "stopped" },
		] });
		await lead.until((_, events) => toolCalls(events).some((c) => c.name === "TaskStop"), 30_000, "the TaskStop result");
		const stop = toolCalls(lead.events).find((c) => c.name === "TaskStop");
		const [run] = launches(lead.events);
		assert.equal(stop.isError, false, stop.text);
		assert.ok(stop.text.startsWith(`Successfully stopped task: ${run.taskId} (One agent that never ends)`), stop.text);
		const record = join(run.transcriptDir, `${run.runId}.json`);
		await poll(() => existsSync(record) && JSON.parse(readFileSync(record, "utf8")).status === "killed", 10_000, "the killed run record");
		await poll(() => procs(t).every((p) => p.pid === lead.pid || !p.argv.includes("sleep")), 10_000, "the agent's bash to exit");
		await sleep(2_000);
		assert.equal(taskNotifications(lead.events).length, 0, "a stopped workflow notified");
	},
};
