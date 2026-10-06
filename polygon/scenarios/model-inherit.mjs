import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, taskNotifications } from "../look.mjs";

// An Agent with no model runs the lead's model and thinking level.
export default {
	name: "model-inherit",
	gate: "M1",
	live: true,
	async run(t) {
		const child = { agent: "child", steps: [{ id: "c1", text: "inherited" }] };
		const lead = rpc(t);
		const { data: state } = await lead.send({ type: "get_state" });
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Agent", args: { description: "inherit", prompt: `POLYGON ${JSON.stringify(child)}` } }, { id: "s2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the agent's report");
		const launched = lead.events.find((e) => e.type === "tool_execution_end" && e.toolCallId === "s1").result.content[0].text;
		assert.match(launched, new RegExp(`^Model: ${state.model.provider}/${state.model.id}:${state.thinkingLevel}$`, "m"));
		const [leadModel] = requests(t).filter((r) => r.agent === "lead").map((r) => r.model);
		assert.deepEqual(requests(t).filter((r) => r.agent === "child").map((r) => r.model), [leadModel]);
	},
};
