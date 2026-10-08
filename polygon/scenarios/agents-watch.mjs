import assert from "node:assert/strict";
import { eventually, rpc, script } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";

// /agents <id> tails a running agent's transcript in a widget, a second /agents <id> hides it, and the agent's end clears it.
// The child's 100 tool calls make about 200 transcript entries, which the tail reads every second.
const child = script({ agent: "child", steps: [
	...Array.from({ length: 100 }, (_, n) => ({ id: `w${n}`, tool: "bash", args: { command: "true" } })),
	{ id: "long", tool: "bash", args: { command: "sleep 8" } },
	{ id: "c1", text: "child done" },
] });
const tails = (events) => events.filter((e) => e.type === "extension_ui_request" && e.method === "setWidget" && e.widgetKey === "agent-tail").map((e) => e.widgetLines);

export default {
	name: "agents-watch",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "probe", prompt: child } },
			{ id: "s2", text: "launched" },
			{ id: "s3", on: "task-notification", text: "reported" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn");
		const { agentId } = toolCalls(lead.events)[0].details;
		await eventually(() => requests(t).some((r) => r.step === "long"), 60_000, "the child's long step");
		await lead.prompt(`/agents ${agentId}`);
		await lead.until((_, events) => tails(events).at(-1)?.some((line) => line.includes("sleep 8")), 10_000, "the tail showing the running step");
		const lines = tails(lead.events).at(-1);
		assert.ok(lines[0].includes(agentId) && lines.length === 9, "a header and the last 8 transcript lines");
		await lead.prompt(`/agents ${agentId}`);
		await lead.until((_, events) => tails(events).at(-1) === undefined, 5_000, "the second /agents hiding the tail");
		await lead.prompt(`/agents ${agentId}`);
		await lead.until((_, events) => tails(events).at(-1) !== undefined, 5_000, "the tail shown again");
		await lead.until((_, events) => taskNotifications(events).length === 1 && tails(events).at(-1) === undefined, 30_000, "the agent's end clearing the tail");
	},
};
