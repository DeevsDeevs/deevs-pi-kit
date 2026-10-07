import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, fixtureModels, herdr, rpc, script } from "../drive.mjs";
import { notifications, requests } from "../look.mjs";

const MARKS = ["closed-mark-1", "closed-mark-2", "closed-mark-native"];

// The lead quits; a Pi collaborator sends twice and a Claude one once, after its lease would have lapsed.
// On reopen one turn starts carrying all three, and nothing polls.
export default {
	name: "collab-lead-closed",
	gate: "M6",
	timeoutMs: 240_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["talker"]);
		writeFileSync(join(t.home, ".claude", ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [t.repo]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["polygon"], rejected: [] } }));
		t.scripts.talker = { agent: "talker", steps: [
			{ id: "c1", tool: "bash", args: { command: "sleep 4" } },
			{ id: "c2", tool: "SendMessage", args: { to: "main", message: MARKS[0] } },
			{ id: "c3", tool: "SendMessage", args: { to: "main", message: MARKS[1] } },
			{ id: "c4", text: "both sent" },
		] };
		const first = rpc(t);
		await first.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_start", args: { participants: [
				{ name: "talker", model: "polygon/talker", profile: "read-only" },
				{ name: "scribe", model: "claude:opus", profile: "read-only" },
			] } },
			{ id: "s2", tool: "SendMessage", args: { to: "talker", message: "go" } },
			// The scribe's message carries the script that makes it send, 45 s later: past the 30 s lease the closed lead no longer renews.
			{ id: "s3", tool: "SendMessage", args: { to: "scribe", message: script({ agent: "scribe", steps: [
				{ id: "k1", tool: "~__SendMessage", args: { to: "main", message: MARKS[2] }, delayMs: 45_000 },
				{ id: "k2", text: "sent" },
			] }) } },
			{ id: "s4", text: "bye" },
		] });
		await first.until((e) => e.type === "agent_settled", 120_000, "the starts and sends");
		await eventually(() => requests(t).some((r) => r.agent === "scribe" && r.step === "k1"), 60_000, "the scribe at work");
		await first.close();
		await eventually(() => requests(t).some((r) => r.agent === "talker" && r.step === "c4"), 60_000, "the talker's sends while the lead is closed");
		await eventually(() => requests(t).some((r) => r.agent === "scribe" && r.step === "k2"), 90_000, "the scribe's send while the lead is closed");
		t.marks.push(MARKS[0], MARKS[1]);
		const reopened = Date.now();
		const lead = rpc(t, { args: ["--continue"] });
		await eventually(() => notifications(lead.events).some((n) => n.customType === "collaborator-message"), 60_000, "the held messages on reopen");
		await lead.until((e) => e.type === "agent_settled", 30_000, "the turn they start");
		const held = notifications(lead.events).filter((n) => n.customType === "collaborator-message");
		assert.equal(held.length, 1, "the held messages arrived as more than one notification");
		// The scribe's mark is also in the lead's own transcript (it sent the script), so its sender list proves its delivery.
		assert.deepEqual(held[0].details.from.toSorted(), ["scribe", "talker"], "a collaborator's held message is missing");
		const turn = requests(t).filter((r) => r.agent === "lead" && r.at >= reopened);
		assert.deepEqual(turn[0]?.marks, [MARKS[0], MARKS[1]], "the first request after reopen does not carry the talker's messages");
		assert.ok(requests(t).every((r) => !r.tools.includes("collaborator_inbox")), "an inbox tool was offered");
	},
};
