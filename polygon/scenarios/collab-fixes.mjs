import assert from "node:assert/strict";
import { eventually, fixtureModels, herdr, rpc } from "../drive.mjs";
import { notifications, requests, toolCalls } from "../look.mjs";

// A read-only Pi collaborator, woken by a message, is still mid-reply when the lead stands it down.
export default {
	name: "collab-fixes",
	gate: "M0",
	timeoutMs: 180_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["reader"]);
		t.scripts.reader = { agent: "reader", steps: [
			{ id: "r1", tool: "bash", args: { command: "sleep 3" } },
			{ id: "r2", tool: "SendMessage", args: { to: "main", message: "polygon-reply" } },
			{ id: "r3", text: "replied" },
		] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_start", args: { participants: [{ name: "reader", model: "polygon/reader", profile: "read-only" }] } },
			{ id: "s2", tool: "SendMessage", args: { to: "reader", message: "go" } },
			{ id: "s3", tool: "TaskStop", args: { task_id: "reader" } },
			{ id: "s4", text: "stood down" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 3, 170_000, "start, send and stand-down");
		assert.deepEqual(toolCalls(lead.events).map((c) => [c.name, c.isError]), [["collaborator_start", false], ["SendMessage", false], ["TaskStop", false]]);
		const reader = requests(t).filter((r) => r.agent === "reader");
		assert.ok(reader[0]?.tools.includes("bash") && !reader[0].tools.some((n) => n === "edit" || n === "write"), "a reader was not offered bash, or was offered edit/write");
		await eventually(() => notifications(lead.events).some((n) => n.customType === "collaborator-message"), 30_000, "the reply sent mid-stand-down");
	},
};
