import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { procs, toolCalls } from "../look.mjs";

const JOB_ID = "$/j_[0-9a-z]+_[0-9a-f]{8}/";

export default {
	name: "jobs-basic",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "job_start", args: { name: "probe", argv: ["sh", "-c", "echo polygon-ok; sleep 300"], readyPattern: "polygon-ok" } },
			{ id: "s2", tool: "job_read", args: { id: JOB_ID } },
			{ id: "s3", tool: "TaskStop", args: { task_id: JOB_ID } },
			{ id: "s4", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["job_start", false], ["job_read", false], ["TaskStop", false]]);
		const [start, read, stop] = calls.map((c) => c.details);
		assert.equal(start.runtime.status, "running");
		assert.ok(read.chunks.length > 0, "job_read returned no output chunks");
		assert.equal(stop.kind, "job");
		assert.deepEqual(procs(t).filter((p) => p.pid !== lead.pid), [], "census: the job's process tree outlived TaskStop");
	},
};
