import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { requests, settled, toolCalls } from "../look.mjs";

const REMINDER = "<chain_checkpoint>";

export default {
	name: "ext-chains",
	gate: "M0",
	async run(t) {
		t.marks.push(REMINDER);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "chain", args: { action: "save", chain: "polygon", content: "# Start\n\nNext: fork.\n", slug: "start" } },
			{ id: "s2", tool: "chain", args: { action: "load", chain: "polygon" } },
			{ id: "s3", tool: "chain", args: { action: "fork", chain: "polygon", branch: "side" } },
			{ id: "s4", tool: "chain", args: { action: "save", chain: "polygon", branch: "side", parent: "$/[^\\s/\"]+-start\\.md/", content: "# Side\n\nForked.\n", slug: "side" } },
			{ id: "s5", tool: "chain", args: { action: "load", chain: "polygon", branch: "side" } },
			// 170k of the puppet's 200k window: 85%, past the 80% checkpoint and short of auto-compaction.
			{ id: "s6", usage: 170_000, text: "context is full" },
			{ id: "s7", tool: "chain", args: { action: "list" } },
			{ id: "s7b", tool: "chain", args: { action: "context", chain: "polygon", mode: "full" } },
			{ id: "s8", text: "done" },
			{ id: "s9", text: "still done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the first turn to settle");
		await lead.prompt("continue");
		await lead.until((_, events) => settled(events) >= 2, 30_000, "the second turn to settle");
		await lead.prompt("continue");
		await lead.until((_, events) => settled(events) >= 3, 30_000, "the third turn to settle");

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [false, false, false, false, false, false, true].map((isError) => ["chain", isError]));
		assert.match(calls[6].text, /mode/, "an unknown context mode is refused at the tool boundary");
		const [main, loadedMain, fork, side, loadedSide] = calls.map((c) => c.details);
		assert.equal(loadedMain.link.filename, main.link.filename);
		assert.equal(fork.parent.filename, main.link.filename);
		assert.deepEqual([side.link.branch, side.link.parent], ["side", main.link.filename]);
		assert.equal(loadedSide.link.filename, side.link.filename);
		for (const link of [main.link, side.link]) assert.ok(existsSync(join(t.repo, ".chains", "polygon", link.filename)), `${link.filename} missing on disk`);

		const leadRequests = requests(t).filter((r) => r.agent === "lead");
		assert.deepEqual(leadRequests.map((r) => r.step), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s7b", "s8", "s9"]);
		assert.deepEqual(leadRequests.map((r) => r.marks.includes(REMINDER)), [false, false, false, false, false, false, true, true, true, false], "the reminder reaches exactly one turn, the one after 85%, and no later one");
	},
};
