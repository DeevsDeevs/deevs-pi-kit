import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, taskNotifications } from "../look.mjs";
import { say } from "./wf-shapes.mjs";

const ORIGINAL = "ORIGINAL-REQUEST-7f3";
const SIDE = "SIDE-QUESTION-9c2";
// The first agent outlasts the side question, so the second starts after it.
const SOURCE = [
	'export const meta = { name: "provenance", description: "Two agents in a row" };',
	`const first = await agent(${say("prov1", [{ id: "b", tool: "bash", args: { command: "sleep 3" } }, { id: "c", text: "prov1 out" }])}, { label: "first" });`,
	`return [first, await agent(${say("prov2")}, { label: "second" })];`,
].join("\n");

export default {
	name: "wf-provenance",
	gate: "M3",
	async run(t) {
		t.marks.push(ORIGINAL, SIDE);
		const lead = rpc(t);
		await lead.script({ agent: "lead", note: ORIGINAL, steps: [{ id: "s1", tool: "Workflow", args: { script: SOURCE } }, { id: "s2", text: "launched" }] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		const asked = Date.now();
		await lead.prompt(`${SIDE} how is it going?`);
		await lead.until((_, events) => taskNotifications(events).length >= 1, 60_000, "the workflow notification");
		const agents = requests(t).filter((r) => r.agent === "prov1" || r.agent === "prov2");
		assert.ok(agents.find((r) => r.agent === "prov2").at > asked, "the second agent started before the side question");
		assert.ok(agents.every((r) => r.marks.includes(ORIGINAL)), "an agent did not get the user's request");
		assert.ok(agents.every((r) => !r.marks.includes(SIDE)), "the side question reached an agent");
		assert.ok(requests(t).some((r) => r.agent === "lead" && r.marks.includes(SIDE)), "the side question never reached the lead");
	},
};
