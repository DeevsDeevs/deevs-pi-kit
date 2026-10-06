import assert from "node:assert/strict";
import { eventually, fixtureModels, herdr, rpc } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

const MARKS = [1, 2, 3, 4, 5].map((n) => `coalesce-mark-${n}`);

// Five messages to a busy collaborator arrive as one delivery at its next idle, and nothing polls.
export default {
	name: "collab-coalesce",
	gate: "M6",
	timeoutMs: 180_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["busy"]);
		t.scripts.busy = { agent: "busy", steps: [
			{ id: "b1", tool: "bash", args: { command: "sleep 8" } },
			{ id: "b2", text: "done" },
		] };
		t.marks.push(...MARKS);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_manage", args: { action: "start", participants: [{ participantId: "busy", model: "polygon/busy", profile: "read-only" }] } },
			{ id: "s2", tool: "SendMessage", args: { to: "busy", message: "go" } },
			{ id: "s3", tool: "bash", args: { command: "sleep 3" } },
			...MARKS.map((message, i) => ({ id: `m${i}`, tool: "SendMessage", args: { to: "busy", message } })),
			{ id: "s9", text: "sent" },
		] });
		await lead.until((e) => e.type === "agent_settled", 120_000, "the lead's sends");
		assert.ok(toolCalls(lead.events).every((c) => !c.isError), "a lead tool call failed");
		const first = await eventually(() => requests(t).find((r) => r.agent === "busy" && r.marks.length > 0), 60_000, "the coalesced delivery");
		assert.deepEqual(first.marks, MARKS, "the first delivery to the busy collaborator does not carry all five messages");
		assert.ok(requests(t).every((r) => !r.tools.includes("collaborator_inbox")), "an inbox tool was offered");
	},
};
