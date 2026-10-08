import assert from "node:assert/strict";
import { eventually, fixtureModels, herdr, rpc, sleep } from "../drive.mjs";
import { toolCalls } from "../look.mjs";

// A Pi collaborator that answers main's mail in plain text reaches main once; one that answered with SendMessage is not repeated.
const mail = (events) => events.filter((e) => e.type === "message_end" && e.message?.customType === "collaborator-message")
	.flatMap((e) => e.message.content.map((part) => part.text ?? "")).join("\n");
const count = (text, mark) => text.split(mark).length - 1;

export default {
	name: "collab-text-reply",
	gate: "M6",
	timeoutMs: 180_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["texter", "sender"]);
		t.scripts.texter = { agent: "texter", steps: [{ id: "t1", text: "texter-answer" }] };
		t.scripts.sender = { agent: "sender", steps: [
			{ id: "p1", tool: "SendMessage", args: { to: "main", message: "sender-answer" } },
			{ id: "p2", text: "sender-closing-text" },
		] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_start", args: { participants: ["texter", "sender"].map((name) => ({ name, model: `polygon/${name}`, profile: "read-only" })) } },
			{ id: "s2", tool: "SendMessage", args: { to: "texter", message: "ask texter" } },
			{ id: "s3", tool: "SendMessage", args: { to: "sender", message: "ask sender" } },
			{ id: "s4", text: "asked" },
		] });
		await lead.until((e) => e.type === "agent_settled", 120_000, "the lead's asks");
		assert.ok(toolCalls(lead.events).every((c) => !c.isError), "a lead tool call failed");
		await eventually(() => count(mail(lead.events), "texter-answer") && count(mail(lead.events), "sender-answer"), 90_000, "both answers at main");
		await sleep(5_000);
		const got = mail(lead.events);
		assert.deepEqual(["texter-answer", "sender-answer", "sender-closing-text"].map((mark) => count(got, mark)), [1, 1, 0]);
	},
};
