import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { agentIds, requests, taskNotifications, toolCalls } from "../look.mjs";

const MARK = "polygon-steer-mark";

export default {
	name: "sendmessage-steer",
	gate: "M2",
	live: true,
	async run(t) {
		const lead = rpc(t);
		const child = { agent: "child", steps: [
			{ id: "c1", tool: "bash", args: { command: "sleep 3" } },
			{ id: "c2", on: MARK, text: "steered" },
			{ id: "c3", text: "never steered" },
		] };
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "steer probe", prompt: script(child), run_in_background: true } },
			{ id: "s2", tool: "SendMessage", args: { to: "$/\\ba[0-9a-f]{16}\\b/", message: MARK } },
			{ id: "s3", text: "sent" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 2, 30_000, "the Agent and SendMessage results");
		const [launch, send] = toolCalls(lead.events);
		assert.deepEqual([launch.name, launch.isError, send.name, send.isError], ["Agent", false, "SendMessage", false]);
		const [id] = agentIds(launch.text);
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the steered agent's notification");
		assert.deepEqual(requests(t).filter((r) => r.agent === "child").map((r) => r.step), ["c1", "c2"], "the steer mark did not reach the child's next request");
		assert.deepEqual([...new Set(taskNotifications(lead.events).map((n) => n.taskId))], [id], "the steered run notified under another task id");
	},
};
