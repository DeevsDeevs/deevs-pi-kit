import assert from "node:assert/strict";
import { rpc, script, sleep } from "../drive.mjs";
import { requests, sessionNotes, taskNotes } from "../look.mjs";

export default {
	name: "reload-mid-run",
	gate: "M1",
	async run(t) {
		const lead = rpc(t, { args: ["-e", "/polygon/fixtures/polygon-reload.ts"] });
		const child = { agent: "child", steps: [{ id: "c1", tool: "bash", args: { command: "sleep 3" } }, { id: "c2", text: "done" }] };
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "reload probe", prompt: script(child), run_in_background: true } },
			{ id: "s2", text: "launched" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		await lead.prompt("/polygon-reload");
		await lead.until((_, events) => taskNotes(events).length >= 1, 30_000, "the agent's notification after the reload");
		await sleep(2_000);
		assert.equal(taskNotes(lead.events).length, 1, "the reload duplicated or lost the notification");
		assert.equal(sessionNotes(t).length, 1);
		assert.deepEqual(requests(t).filter((r) => r.agent === "child").map((r) => r.step), ["c1", "c2"], "the reload repeated a model request");
	},
};
