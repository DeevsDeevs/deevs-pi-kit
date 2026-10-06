import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

const REMINDER = "<chain_checkpoint>";

export default {
	name: "ext-chains",
	gate: "M0",
	async run(t) {
		t.marks.push(REMINDER);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "chain_save", args: { chain: "polygon", content: "# Start\n\nNext: fork.\n", slug: "start" } },
			{ id: "s2", tool: "chain_load", args: { chain: "polygon" } },
			{ id: "s3", tool: "chain_fork", args: { chain: "polygon", branch: "side" } },
			{ id: "s4", tool: "chain_save", args: { chain: "polygon", branch: "side", parent: "$/[^\\s/\"]+-start\\.md/", content: "# Side\n\nForked.\n", slug: "side" } },
			{ id: "s5", tool: "chain_load", args: { chain: "polygon", branch: "side" } },
			// 170k of the puppet's 200k window: 85%, past the 80% checkpoint and short of auto-compaction.
			{ id: "s6", usage: 170_000, text: "context is full" },
			{ id: "s7", tool: "chain_list", args: {} },
			{ id: "s8", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the first turn to settle");
		await lead.prompt("continue");
		await lead.until((_, events) => events.filter((e) => e.type === "agent_settled").length >= 2, 30_000, "the second turn to settle");

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), ["chain_save", "chain_load", "chain_fork", "chain_save", "chain_load", "chain_list"].map((name) => [name, false]));
		const [main, loadedMain, fork, side, loadedSide] = calls.map((c) => c.details);
		assert.equal(loadedMain.link.filename, main.link.filename);
		assert.equal(fork.parent.filename, main.link.filename);
		assert.deepEqual([side.link.branch, side.link.parent], ["side", main.link.filename]);
		assert.equal(loadedSide.link.filename, side.link.filename);
		for (const link of [main.link, side.link]) assert.ok(existsSync(join(t.repo, ".chains", "polygon", link.filename)), `${link.filename} missing on disk`);

		const leadRequests = requests(t).filter((r) => r.agent === "lead");
		assert.deepEqual(leadRequests.map((r) => r.step), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
		assert.deepEqual(leadRequests.map((r) => r.marks.includes(REMINDER)), [false, false, false, false, false, false, true, true], "the reminder reaches exactly the turn after 85%");
	},
};
