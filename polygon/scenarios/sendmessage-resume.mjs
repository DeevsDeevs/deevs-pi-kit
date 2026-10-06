import assert from "node:assert/strict";
import { agentStep, eventually, rpc, sleep } from "../drive.mjs";
import { agentIds, requests, settled, taskNotifications, toolCalls } from "../look.mjs";

const AGENT_ID = "$/\\ba[0-9a-f]{16}\\b/";
const send = (id, on, message) => ({ id, on, tool: "SendMessage", args: { to: AGENT_ID, message } });

export default {
	name: "sendmessage-resume",
	gate: "M2",
	async run(t) {
		const lead = rpc(t);
		const prompt = async (message) => { const before = settled(lead.events); await lead.prompt(message); await lead.until((_, events) => settled(events) > before, 30_000, `${message} to settle`); };
		await lead.script({ agent: "lead", steps: [
			agentStep("s1", { agent: "a", steps: [{ id: "c1", text: "first" }, { id: "c2", on: "polygon-resume", text: "resumed" }] }, { run_in_background: true }),
			{ id: "s2", text: "launched" },
			send("s3", "<task-notification", "polygon-resume"),
			agentStep("s4", { agent: "b", steps: [{ id: "c1", tool: "bash", args: { command: "sleep 30" } }, { id: "c2", on: "polygon-refused", text: "resumed" }] }, { run_in_background: true }, "polygon-round-2"),
			send("s5", "polygon-round-3", "polygon-refused"),
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 2, 30_000, "the first run's and the resumed run's notifications");
		const a = requests(t).filter((r) => r.agent === "a");
		assert.deepEqual(a.map((r) => r.step), ["c1", "c2"]);
		assert.ok(a[1].messages > a[0].messages, "the resumed run lost its context");
		const [aId] = agentIds(toolCalls(lead.events)[0].text);
		assert.deepEqual(taskNotifications(lead.events).map((n) => n.taskId), [aId, aId], "the resume did not notify under the same id");

		await prompt("polygon-round-2");
		const [bId] = agentIds(toolCalls(lead.events).filter((c) => c.name === "Agent")[1].text);
		await eventually(() => requests(t).some((r) => r.agent === "b"), 30_000, "agent b to start");
		await lead.prompt(`/agents stop ${bId}`);
		await prompt("polygon-round-3");
		assert.equal(toolCalls(lead.events).filter((c) => c.name === "SendMessage").length, 2);
		await sleep(2_000);
		assert.ok(!requests(t).some((r) => r.agent === "b" && r.step === "c2"), "an agent the user stopped was resumed");
	},
};
