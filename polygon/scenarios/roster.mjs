import assert from "node:assert/strict";
import { fixtureModels, herdr, rpc, script } from "../drive.mjs";
import { agentIds, taskNotifications, toolCalls } from "../look.mjs";

// The roster labels agents and collaborators by kind. M5 adds job and monitor rows.
const child = (agent) => script({ agent, steps: [{ id: "c1", tool: "bash", args: { command: "sleep 4" } }, { id: "c2", text: "done" }] });

export default {
	name: "roster",
	gate: ["M2", "M5", "M6"],
	timeoutMs: 120_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["peer"]);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s0", tool: "collaborator_manage", args: { action: "start", participants: [{ participantId: "peer", model: "polygon/peer" }] } },
			{ id: "s1", tool: "Agent", args: { description: "roster named", prompt: child("named"), name: "polygon-named" } },
			{ id: "s2", tool: "Agent", args: { description: "roster unnamed", prompt: child("unnamed") } },
			{ id: "s3", tool: "job_start", args: { command: "sleep 4", description: "roster job" } },
			{ id: "s4", tool: "Monitor", args: { command: "sleep 4", description: "roster monitor" } },
			{ id: "s5", tool: "ListAgents", args: {} },
			{ id: "s6", text: "listed" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 6, 90_000, "the ListAgents result");
		const [collaborator, named, unnamed, job, monitor, list] = toolCalls(lead.events);
		assert.deepEqual([collaborator, named, unnamed, job, monitor, list].map((c) => [c.name, c.isError]), [["collaborator_manage", false], ["Agent", false], ["Agent", false], ["job_start", false], ["Monitor", false], ["ListAgents", false]]);
		const row = (id) => list.text.split("\n").find((line) => line.includes(id)) ?? "";
		for (const call of [named, unnamed]) assert.match(row(agentIds(call.text)[0]), /^agent\b/, "an agent row is not labelled by kind");
		assert.ok(row(agentIds(named.text)[0]).includes("polygon-named"), "the named agent's row lacks its name");
		assert.match(row(job.details.taskId), /^job\b/, "the job row is not labelled by kind");
		assert.match(row(monitor.details.taskId), /^monitor\b/, "the monitor row is not labelled by kind");
		assert.match(row("peer"), /^collaborator\b/, "the collaborator row is missing or not labelled by kind");
		await lead.until((_, events) => taskNotifications(events).length >= 4, 30_000, "the agents, the job and the monitor to finish");
	},
};
