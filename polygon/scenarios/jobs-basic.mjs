import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { procs, taskNotifications, toolCalls } from "../look.mjs";

export const JOB_ID = "$/(?<=ID: )b[0-9a-z]{8}/";
export const JOB_LOG = "$/\\/\\S+\\/out\\/b[0-9a-z]{8}\\.log/";

// Start, read the output file, stop: one `killed` report, and no process of the job left.
export default {
	name: "jobs-basic",
	gate: ["M0", "M5"],
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "job_start", args: { command: "echo polygon-ok; sleep 300", description: "probe" } },
			{ id: "s2", tool: "bash", args: { command: "sleep 1" } },
			{ id: "s3", tool: "read", args: { path: JOB_LOG } },
			{ id: "s4", tool: "TaskStop", args: { task_id: JOB_ID } },
			{ id: "s5", text: "done" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the stopped job's report");

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["job_start", false], ["bash", false], ["read", false], ["TaskStop", false]]);
		const [start, , read, stop] = calls;
		assert.match(read.text, /polygon-ok/, "the output file lacks the job's output");
		assert.equal(stop.details.kind, "job");
		const [report] = taskNotifications(lead.events);
		assert.deepEqual([report.taskId, report.status, report.outputFile], [start.details.taskId, "killed", start.details.outputFile]);
		assert.deepEqual(procs(t).filter((p) => p.pid !== lead.pid), [], "census: the job's process tree outlived TaskStop");
	},
};
