import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { agentReplyModels, taskNotifications, toolCalls } from "../look.mjs";

// An Agent with no model runs the lead's model and thinking level.
export default {
	name: "model-inherit",
	gate: "M1",
	live: true,
	async run(t) {
		const child = { agent: "child", steps: [{ id: "c1", text: "inherited" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Agent", args: { description: "inherit", prompt: script(child) } }, { id: "s2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the agent's report");
		// Read after the run: on --live the kit may switch a new session's lead to the newest sol just after start.
		const { data: state } = await lead.send({ type: "get_state" });
		const leadModel = `${state.model.provider}/${state.model.id}`;
		assert.match(toolCalls(lead.events).find((c) => c.name === "Agent").text, new RegExp(`^Model: ${leadModel}:${state.thinkingLevel}$`, "m"));
		assert.deepEqual([...new Set(agentReplyModels(t))], [leadModel]);
	},
};
