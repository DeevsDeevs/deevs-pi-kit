import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentStep, eventually, rpc, sleep } from "../drive.mjs";
import { missionStates, owned, requests, sessionNotes, toolCalls } from "../look.mjs";
import { say } from "./wf-shapes.mjs";

// Background agents, an 8-agent workflow, a job, a monitor and a SendMessage in flight under an active Mission when Pi is killed:
// on reopen everything settles, each task reports exactly once, the Mission continues only after the last task reported, and no
// process outlives its task. Narrower than PLAN M7's row on purpose: a kill -9 stands in for /polygon-reload (reload-mid-run covers
// that), the collaborator image needs a live login (collab-image), and the 150 ms stall bound needs a lone run (durable-16, wf-scale).
export default {
	name: "everything-at-once",
	gate: "M7",
	timeoutMs: 120_000,
	async run(t) {
		const started = (name) => join(t.repo, `${name}-started`);
		const busy = (name) => ({ id: "b", tool: "bash", args: { command: `touch ${started(name)}; sleep 30` } });
		mkdirSync(join(t.repo, "watched"));
		const workflow = [
			'export const meta = { name: "all", description: "Eight agents at once" };',
			`return await parallel([() => agent(${say("w1", [busy("w1"), { id: "c", text: "w1 out" }])}), ${[2, 3, 4, 5, 6, 7, 8].map((i) => `() => agent(${say(`w${i}`)})`).join(", ")}]);`,
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
			{ id: "s7", tool: "mission_start", args: { title: "all at once", goal: "Wait for every task.", done: "Every task reported." } },
			{ id: "s8", text: "all launched" },
			{ id: "s9", on: "Mission continue", tool: "mission_update", args: { log: "All reported.", next: "none", status: "done" } },
			{ id: "s10", text: "closed" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		await eventually(() => ["a", "w1", "job"].every((name) => existsSync(started(name))), 30_000, "the agent, the workflow's agent and the job to be busy");
		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), ["Agent", "SendMessage", "Agent", "Workflow", "job_start", "Monitor", "mission_start"].map((name) => [name, false]));
		const ids = calls.filter((c) => !["SendMessage", "mission_start"].includes(c.name)).map((c) => c.details.agentId ?? c.details.taskId);
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
		await eventually(() => missionStates(t)[0]?.status === "done", 30_000, "the Mission's one continue");
		const customs = lead.events.filter((e) => e.type === "message_end" && e.message?.role === "custom").map((e) => e.message.customType === "mission-continue" ? "continue" : JSON.stringify(e.message.content));
		assert.ok(customs.indexOf("continue") > Math.max(...ids.slice(0, 4).map((id) => customs.findLastIndex((c) => c.includes(id)))), "the Mission continued while a task was live");
	},
};
