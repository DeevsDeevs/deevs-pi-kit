import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rpc, script } from "../drive.mjs";
import { poll, requests, taskNotes, toolCalls } from "../look.mjs";
import { AGENT_ID } from "./claude-worker.mjs";

// A message to a running Claude worker waits for its run to end, then goes in by resume: two reports under one id.
export default {
	name: "sendmessage-cli",
	gate: "M4",
	timeoutMs: 120_000,
	async run(t) {
		const marker = join(t.repo, "cli-started");
		const child = { agent: "cw", steps: [{ id: "b1", tool: "Bash", args: { command: `touch ${marker}; sleep 8` } }, { id: "c1", text: "first" }, { id: "c2", on: "polygon-queued", text: "second" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "busy worker", prompt: script(child), model: "opus", subagent_type: "Explore" } },
			{ id: "s2", text: "launched" },
			{ id: "s3", on: "polygon-send", tool: "SendMessage", args: { to: AGENT_ID, message: "polygon-queued" } },
			{ id: "s4", text: "sent" },
		] });
		await poll(() => existsSync(marker), 60_000, "the worker's command to start");
		await lead.prompt("polygon-send");
		await lead.until((_, events) => toolCalls(events).some((c) => c.name === "SendMessage"), 30_000, "the SendMessage call");
		assert.equal(toolCalls(lead.events).find((c) => c.name === "SendMessage").details?.outcome, "queued");
		await lead.until((_, events) => taskNotes(events).length >= 2, 60_000, "both runs' notifications");
		const notes = taskNotes(lead.events);
		assert.equal(notes[0].taskId, notes[1].taskId);
		const cw = requests(t).filter((r) => r.agent === "cw");
		assert.deepEqual(cw.map((r) => r.step), ["b1", "c1", "c2"]);
		assert.ok(cw[2].messages > cw[1].messages, "the queued message did not resume the session");
	},
};
