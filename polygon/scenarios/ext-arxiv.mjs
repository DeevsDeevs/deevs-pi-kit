import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

// The puppet tier checks the tool waits for its skill; --live (which has a network) runs one real search.
export default {
	name: "ext-arxiv",
	gate: "M0",
	live: true,
	async run(t) {
		const lead = rpc(t);
		await lead.prompt(`/skill:arxiv ${script({ agent: "lead", steps: [
			...(t.live ? [{ id: "s1", tool: "arxiv", args: { action: "search", query: "attention is all you need", maxResults: 1 } }] : []),
			{ id: "s2", text: "done" },
		] })}`);
		await lead.until((e) => e.type === "agent_settled", 60_000, "agent_settled");

		assert.ok(requests(t)[0].tools.includes("arxiv"), "arxiv not offered after /skill:arxiv");
		if (!t.live) return;
		const [search] = toolCalls(lead.events);
		assert.deepEqual([search.name, search.isError], ["arxiv", false]);
		assert.ok(search.details.papers.length >= 1, "a real search returned no entries");
	},
};
