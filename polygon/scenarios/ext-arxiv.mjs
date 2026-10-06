import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

// The puppet tier only checks the tools are offered; --live (which has a network) runs one real search.
export default {
	name: "ext-arxiv",
	gate: "M0",
	live: true,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			...(t.live ? [{ id: "s1", tool: "arxiv_search", args: { query: "attention is all you need", maxResults: 1 } }] : []),
			{ id: "s2", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 60_000, "agent_settled");

		const offered = requests(t)[0].tools;
		assert.deepEqual(["arxiv_search", "arxiv_get", "arxiv_bibtex"].filter((name) => !offered.includes(name)), [], "arxiv tools not offered");
		if (!t.live) return;
		const [search] = toolCalls(lead.events);
		assert.deepEqual([search.name, search.isError], ["arxiv_search", false]);
		assert.ok(search.details.papers.length >= 1, "a real search returned no entries");
	},
};
