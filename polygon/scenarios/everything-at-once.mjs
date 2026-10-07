import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentStep, eventually, rpc, sleep } from "../drive.mjs";
import { owned, requests, sessionNotes, toolCalls } from "../look.mjs";
import { say } from "./wf-shapes.mjs";

// Background agents, a workflow, a job, a monitor and a SendMessage in flight together when Pi is killed: on reopen
// everything settles, each task reports exactly once and no process outlives its task.
export default {
	name: "everything-at-once",
	gate: "M7",
	timeoutMs: 120_000,
	async run(t) {
		const started = (name) => join(t.repo, `${name}-started`);
		const busy = (name) => ({ id: "b", tool: "bash", args: { command: `touch ${started(name)}; sleep 30` } });
		mkdirSync(join(t.repo, "watched"));
		const workflow = [
			'export const meta = { name: "all", description: "Two agents at once" };',
			`return await parallel([() => agent(${say("w1", [busy("w1"), { id: "c", text: "w1 out" }])}), () => agent(${say("w2")})]);`,
		].join("\n");
		t.marks.push("polygon-steer");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			agentStep("s1", { agent: "a", steps: [busy("a"), { id: "c", text: "a out" }] }, { run_in_background: true }),
			{ id: "s2", tool: "SendMessage", args: { to: "$/\\ba[0-9a-f]{16}\\b/", message: "polygon-steer" } },
			agentStep("s3", { agent: "b", steps: [{ id: "c", text: "b out" }] }, { run_in_background: true }),
			{ id: "s4", tool: "Workflow", args: { script: workflow } },
			{ id: "s5", tool: "job_start", args: { command: `touch ${started("job")}; sleep 30`, description: "long job" } },
			{ id: "s6", tool: "Monitor", args: { path: "watched", every: 1, description: "watched folder" } },
			{ id: "s7", text: "all launched" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		await eventually(() => ["a", "w1", "job"].every((name) => existsSync(started(name))), 30_000, "the agent, the workflow's agent and the job to be busy");
		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), ["Agent", "SendMessage", "Agent", "Workflow", "job_start", "Monitor"].map((name) => [name, false]));
		const ids = calls.filter((c) => c.name !== "SendMessage").map((c) => c.details.agentId ?? c.details.taskId);
		await lead.restart();
		writeFileSync(join(t.repo, "watched", "new.txt"), "1\n");

		const of = (id) => sessionNotes(t).filter((n) => n.taskId === id);
		await eventually(() => ids.every((id) => of(id).length), 60_000, "a report from every task");
		await eventually(() => owned(t).length === 0, 15_000, "every task's process to end");
		await sleep(2_000);
		assert.deepEqual(ids.map((id) => of(id).length), ids.map(() => 1), "a task did not report exactly once");
		assert.equal(new Set(sessionNotes(t).map((n) => n.notificationId)).size, sessionNotes(t).length, "a notification reached the session twice");
		assert.deepEqual(ids.map((id) => of(id)[0].status ?? of(id)[0].event), ["completed", "completed", "completed", "failed", "added new.txt"], "agents and workflow complete, the job is interrupted, the monitor sees new.txt");
		assert.ok(requests(t).some((r) => r.agent === "a" && r.marks.includes("polygon-steer")), "the steer never reached agent a");
	},
};
