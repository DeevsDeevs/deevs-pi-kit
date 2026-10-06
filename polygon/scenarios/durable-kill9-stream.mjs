import assert from "node:assert/strict";
import { eventually, rpc, script, sleep } from "../drive.mjs";
import { requests, sessionNotes } from "../look.mjs";

// kill -9 while the agent's answer streams: the request is sent again on reopen and one report lands.
export default {
	name: "durable-kill9-stream",
	gate: "M1",
	live: true,
	timeoutMs: 120_000,
	async run(t) {
		const child = { agent: "child", steps: [{ id: "c1", text: "a slow answer", delayMs: 4_000 }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Agent", args: { description: "streamer", prompt: script(child) } }, { id: "s2", text: "launched" }] });
		await eventually(() => requests(t).some((r) => r.agent === "child" && r.step === "c1"), 30_000, "the agent's answer to start streaming");
		await sleep(500);
		await lead.restart();
		await eventually(() => sessionNotes(t).length > 0, 45_000, "the agent's report in the session");
		await sleep(1_000);
		assert.equal(sessionNotes(t).length, 1, "the report landed more than once");
		assert.equal(requests(t).filter((r) => r.agent === "child" && r.step === "c1").length, 2, "the interrupted request was not sent again");
	},
};
