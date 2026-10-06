import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";

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
		assert.match(toolCalls(lead.events)[0].text, new RegExp(`^Model: ${state.model.provider}/${state.model.id}:${state.thinkingLevel}$`, "m"));
		const [leadModel] = requests(t).filter((r) => r.agent === "lead").map((r) => r.model);
		assert.deepEqual([...new Set(requests(t).filter((r) => r.agent === "child").map((r) => r.model))], [leadModel]);
	},
};
