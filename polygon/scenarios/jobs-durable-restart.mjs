import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rpc, sleep } from "../drive.mjs";
import { owned, poll, sessionNotes, taskNotes, toolCalls } from "../look.mjs";

// A job keeps its process across /reload and reports once; across kill -9 it is reaped and reported once as interrupted.
export default {
	name: "jobs-durable-restart",
	gate: "M5",
	async run(t) {
		const lead = rpc(t, { args: ["-e", "/polygon/fixtures/polygon-reload.ts"] });
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "job_start", args: { command: "echo first; sleep 4; echo second", description: "across reload" } },
			{ id: "s2", text: "started" },
			{ id: "s3", on: "<status>completed", tool: "job_start", args: { command: "echo partial; sleep 300; echo never", description: "across kill" } },
			{ id: "s4", text: "started again" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		await lead.prompt("/polygon-reload");
		await lead.until((_, events) => toolCalls(events).length >= 2, 30_000, "the reloaded job's report and the second launch");
		const [reloaded, killed] = toolCalls(lead.events).map((c) => c.details);
		assert.deepEqual(taskNotes(lead.events).map((n) => [n.taskId, n.status]), [[reloaded.taskId, "completed"]]);
		assert.equal(readFileSync(reloaded.outputFile, "utf8"), "first\nsecond\n", "the reload cut the job's process");

		await poll(() => readFileSync(killed.outputFile, "utf8").includes("partial"), 15_000, "the second job's first output");
		await lead.kill9();
		assert.ok(owned(t).length > 0, "kill -9 left no job process to reap");
		await lead.restart();
		await poll(() => owned(t).length === 0, 15_000, "the reaper to kill the job's process group");
		await poll(() => sessionNotes(t).some((n) => n.taskId === killed.taskId), 30_000, "the interrupted job's report");
		await sleep(1_500);
		assert.deepEqual(sessionNotes(t).filter((n) => n.taskId === killed.taskId).map((n) => n.status), ["failed"], "the interrupted job did not report exactly once");
		assert.equal(readFileSync(killed.outputFile, "utf8"), "partial\n", "the interrupted job ran again");
	},
};
