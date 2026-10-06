import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { dialogs, requests, toolCalls } from "../look.mjs";

const TYPED = "polygon-typed-in-chat";
const isDialog = (e) => e.type === "extension_ui_request" && ["select", "input"].includes(e.method);
const dialog = (n) => (e, events) => isDialog(e) && events.filter(isDialog)[n - 1] === e;

export default {
	name: "ext-ask-user",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "ask_user", args: { questions: [{ question: "Drop the table?", options: ["keep", "drop"] }] } },
			{ id: "s2", tool: "ask_user", args: { questions: [{ question: "New name?" }] } },
			{ id: "s3", on: TYPED, text: "the chat answer counts" },
		] });
		const select = await lead.until(dialog(1), 30_000, "the first ask_user dialog");
		assert.equal(select.method, "select");
		lead.reply(select, { value: "drop" });

		const input = await lead.until(dialog(2), 30_000, "the second ask_user dialog");
		assert.equal(input.method, "input");
		await lead.send({ type: "steer", message: `${TYPED} call it polygon` });
		lead.reply(input, { cancelled: true });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");

		const [answered, typed] = toolCalls(lead.events);
		assert.deepEqual([answered.name, answered.isError, answered.details.cancelled], ["ask_user", false, false]);
		assert.deepEqual(answered.details.answers.map((a) => [a.answer, a.kind]), [["drop", "selection"]]);
		assert.deepEqual([typed.name, typed.details.cancelled], ["ask_user", true]);
		assert.equal(dialogs(lead.events), 2);
		// s3 fires only when the typed text arrives after the dismissed dialog's result, before the next model call.
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3"]);
	},
};
