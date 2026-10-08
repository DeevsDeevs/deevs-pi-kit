import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eventually, rpc, script, sleep } from "../drive.mjs";
import { requests, sessionNotes } from "../look.mjs";

// A new session in the same project leaves another session's agents paused; switching back resumes them.
export default {
	name: "durable-other-session",
	gate: "M1",
	timeoutMs: 120_000,
	async run(t) {
		const marker = join(t.repo, "bash-started");
		const child = { agent: "child", steps: [{ id: "b1", tool: "bash", args: { command: `touch ${marker}; sleep 30` } }, { id: "c1", text: "done" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Agent", args: { description: "paused", prompt: script(child) } }, { id: "s2", text: "launched" }] });
		const { data: first } = await lead.send({ type: "get_state" });
		await eventually(() => existsSync(marker), 30_000, "the agent's bash to start");
		await lead.restart([]);
		const { data: second } = await lead.send({ type: "get_state" });
		assert.notEqual(second.sessionId, first.sessionId);
		await sleep(3_000);
		assert.equal(requests(t).filter((r) => r.agent === "child" && r.step !== "b1").length, 0, "the other session's agent ran");
		await lead.send({ type: "switch_session", sessionPath: first.sessionFile });
		await eventually(() => sessionNotes(t).length > 0, 45_000, "the resumed agent's report");
		await sleep(1_000);
		assert.equal(sessionNotes(t).length, 1);
		assert.equal(requests(t).filter((r) => r.agent === "child" && r.step === "c1").length, 1);
	},
};
