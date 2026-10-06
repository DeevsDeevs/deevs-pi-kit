import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { agentIds, taskNotes, toolCalls } from "../look.mjs";

// M2's roster: agents. M5 adds job and monitor rows, M6 collaborator rows.
const child = (agent) => script({ agent, steps: [{ id: "c1", tool: "bash", args: { command: "sleep 4" } }, { id: "c2", text: "done" }] });

export default {
	name: "roster",
	gate: ["M2", "M5", "M6"],
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "roster named", prompt: child("named"), name: "polygon-named" } },
			{ id: "s2", tool: "Agent", args: { description: "roster unnamed", prompt: child("unnamed") } },
			{ id: "s3", tool: "job_start", args: { command: "sleep 4", description: "roster job" } },
			{ id: "s4", tool: "Monitor", args: { command: "sleep 4", description: "roster monitor" } },
			{ id: "s5", tool: "ListAgents", args: {} },
			{ id: "s6", text: "listed" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 5, 30_000, "the ListAgents result");
		const [named, unnamed, job, monitor, list] = toolCalls(lead.events);
		assert.deepEqual([named, unnamed, job, monitor, list].map((c) => [c.name, c.isError]), [["Agent", false], ["Agent", false], ["job_start", false], ["Monitor", false], ["ListAgents", false]]);
		const row = (id) => list.text.split("\n").find((line) => line.includes(id)) ?? "";
		for (const call of [named, unnamed]) assert.match(row(agentIds(call.text)[0]), /\bagent\b/, "an agent row is not labelled by kind");
		assert.ok(row(agentIds(named.text)[0]).includes("polygon-named"), "the named agent's row lacks its name");
		assert.match(row(job.details.taskId), /\bjob\b/, "the job row is not labelled by kind");
		assert.match(row(monitor.details.taskId), /\bmonitor\b/, "the monitor row is not labelled by kind");
		await lead.until((_, events) => taskNotes(events).length >= 4, 30_000, "the agents, the job and the monitor to finish");
	},
};
