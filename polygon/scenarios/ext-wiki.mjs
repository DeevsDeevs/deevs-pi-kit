import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { toolCalls } from "../look.mjs";

export default {
	name: "ext-wiki",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "wiki_init", args: { path: "wiki", domain: "polygon" } },
			{ id: "s2", tool: "write", args: { path: "wiki/concepts/puppet.md", content: "# Puppet\n\nThe puppet answers every polygonfixture request.\n" } },
			{ id: "s3", tool: "wiki_search", args: { path: "wiki", query: "polygonfixture", mode: "text" } },
			{ id: "s4", tool: "wiki_search", args: { path: "wiki", query: "polygonfixture" } },
			{ id: "s5", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["wiki_init", false], ["write", false], ["wiki_search", false], ["wiki_search", false]]);
		for (const search of calls.slice(2)) assert.deepEqual(search.details.matches.map((m) => m.page.relativePath), ["concepts/puppet.md"], `${search.details.mode} search`);
	},
};
