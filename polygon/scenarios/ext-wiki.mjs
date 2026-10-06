import assert from "node:assert/strict";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

export default {
	name: "ext-wiki",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s0", tool: "read", args: { path: join(t.kit, "skills", "wiki", "SKILL.md") } },
			{ id: "s1", tool: "wiki", args: { action: "init", path: "wiki", domain: "polygon" } },
			{ id: "s2", tool: "write", args: { path: "wiki/concepts/puppet.md", content: "# Puppet\n\nThe puppet answers every polygonfixture request.\n" } },
			{ id: "s3", tool: "wiki", args: { action: "search", path: "wiki", query: "polygonfixture", searchMode: "text" } },
			{ id: "s4", tool: "wiki", args: { action: "search", path: "wiki", query: "polygonfixture" } },
			{ id: "s5", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");

		const offered = requests(t).filter((r) => r.agent === "lead").map((r) => r.tools.includes("wiki"));
		assert.deepEqual(offered, [false, true, true, true, true, true], "wiki is offered only once its skill was read");
		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["read", false], ["wiki", false], ["write", false], ["wiki", false], ["wiki", false]]);
		for (const search of calls.slice(3)) assert.deepEqual(search.details.matches.map((m) => m.page.relativePath), ["concepts/puppet.md"], `${search.details.mode} search`);
	},
};
