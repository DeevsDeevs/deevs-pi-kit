import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";

// An unknown type is refused with the list of types; Explore is offered bash and not edit or write.
export default {
	name: "agent-types",
	gate: "M1",
	async run(t) {
		const child = { agent: "explore", steps: [{ id: "c1", text: "explored" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "nobody", subagent_type: "nobody", prompt: "x" } },
			{ id: "s2", tool: "Agent", args: { description: "explore", subagent_type: "Explore", prompt: `POLYGON ${JSON.stringify(child)}` } },
			{ id: "s3", text: "launched" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the explorer's report");
		const [unknown, explore] = toolCalls(lead.events).filter((c) => c.name === "Agent");
		assert.equal(unknown.isError, true);
		assert.equal(explore.isError, false);
		const error = lead.events.find((e) => e.type === "tool_execution_end" && e.toolCallId === "s1").result.content[0].text;
		assert.match(error, /^Agent type 'nobody' not found\. Available agents: general-purpose, .*\bexplorer\b/);
		const offered = requests(t).find((r) => r.agent === "explore").tools;
		assert.ok(offered.includes("bash") && !offered.includes("edit") && !offered.includes("write"), `Explore was offered ${offered}`);
	},
};
