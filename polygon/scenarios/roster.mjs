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
			{ id: "s3", tool: "ListAgents", args: {} },
			{ id: "s4", text: "listed" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 3, 30_000, "the ListAgents result");
		const [named, unnamed, list] = toolCalls(lead.events);
		assert.deepEqual([named, unnamed, list].map((c) => [c.name, c.isError]), [["Agent", false], ["Agent", false], ["ListAgents", false]]);
		const row = (id) => list.text.split("\n").find((line) => line.includes(id)) ?? "";
		for (const call of [named, unnamed]) assert.match(row(agentIds(call.text)[0]), /\bagent\b/, "an agent row is not labelled by kind");
		assert.ok(row(agentIds(named.text)[0]).includes("polygon-named"), "the named agent's row lacks its name");
		await lead.until((_, events) => taskNotes(events).length >= 2, 30_000, "both agents to finish");
	},
};
