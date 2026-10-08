import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdr, rpc, sleep } from "../drive.mjs";
import { dialogs, toolCalls } from "../look.mjs";

// Writer spawn, stand-down and resume (a start after stand-down). mission-restart asserts 0 dialogs for a Mission continue.
const lifecycle = (name) => {
	const start = (id) => ({ id, tool: "collaborator_start", args: { participants: [{ name, profile: "workspace-write" }] } });
	const standDown = { id: "s2", tool: "TaskStop", args: { task_id: name } };
	return { agent: "lead", steps: [start("s1"), standDown, start("s3"), { id: "s4", text: "done" }] };
};

async function run(t, name) {
	const lead = rpc(t, { answer: true });
	await lead.script(lifecycle(name));
	await lead.until((e) => e.type === "agent_settled", 150_000, `${name}'s lifecycle`);
	assert.deepEqual(toolCalls(lead.events).map((c) => c.isError), [false, false, false]);
	await lead.close();
	return dialogs(lead.events);
}

export default {
	name: "no-dialog-autonomy",
	gate: ["M0", "M6"],
	timeoutMs: 330_000,
	async run(t) {
		await herdr(t);
		assert.equal(await run(t, "w1"), 0, "a dialog opened with no autonomy setting");
		mkdirSync(join(t.repo, ".pi"), { recursive: true });
		writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ autonomy: false }));
		// The second lead takes main over from the first once its 30 s lease ran out, which also asks.
		await sleep(31_000);
		assert.equal(await run(t, "w2"), 4, "with autonomy false, the takeover, start, stand-down and resume should each ask once");
	},
};
