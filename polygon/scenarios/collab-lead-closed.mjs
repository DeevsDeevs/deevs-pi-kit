import assert from "node:assert/strict";
import { eventually, fixtureModels, herdr, rpc } from "../drive.mjs";
import { notifications, requests } from "../look.mjs";

// The lead quits; its collaborator sends twice. On reopen one turn starts carrying both, and nothing polls.
export default {
	name: "collab-lead-closed",
	gate: "M6",
	timeoutMs: 180_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["talker"]);
		t.scripts.talker = { agent: "talker", steps: [
			{ id: "c1", tool: "bash", args: { command: "sleep 4" } },
			{ id: "c2", tool: "SendMessage", args: { to: "main", message: "closed-mark-1" } },
			{ id: "c3", tool: "SendMessage", args: { to: "main", message: "closed-mark-2" } },
			{ id: "c4", text: "both sent" },
		] };
		const first = rpc(t);
		await first.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_manage", args: { action: "start", participants: [{ participantId: "talker", model: "polygon/talker", profile: "read-only" }] } },
			{ id: "s2", tool: "SendMessage", args: { to: "talker", message: "go" } },
			{ id: "s3", text: "bye" },
		] });
		await first.until((e) => e.type === "agent_settled", 120_000, "the first lead's turn");
		await first.close();
		await eventually(() => requests(t).some((r) => r.agent === "talker" && r.step === "c4"), 60_000, "both sends while the lead is closed");
		t.marks.push("closed-mark-1", "closed-mark-2");
		const reopened = Date.now();
		const lead = rpc(t, { args: ["--continue"] });
		await eventually(() => notifications(lead.events).some((n) => n.customType === "collaborator-message"), 60_000, "the held messages on reopen");
		await lead.until((e) => e.type === "agent_settled", 30_000, "the turn they start");
		assert.equal(notifications(lead.events).filter((n) => n.customType === "collaborator-message").length, 1, "the held messages arrived as more than one notification");
		const turn = requests(t).filter((r) => r.agent === "lead" && r.at >= reopened);
		assert.deepEqual(turn[0]?.marks, ["closed-mark-1", "closed-mark-2"], "the first request after reopen does not carry both messages");
		assert.ok(requests(t).every((r) => !r.tools.includes("collaborator_inbox")), "an inbox tool was offered");
	},
};
