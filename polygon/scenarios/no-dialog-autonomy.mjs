import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdr, rpc } from "../drive.mjs";
import { dialogs, toolCalls } from "../look.mjs";

// Writer spawn, stand-down and resume (a start after stand-down). Mission continue joins in M5.
const lifecycle = (protocol, participantId) => {
	const start = (id) => ({ id, tool: "collaborator_manage", args: { action: "start", protocol, callerParticipantId: "lead", participants: [{ participantId, driver: "pi", profile: "workspace-write" }] } });
	const standDown = { id: "s2", tool: "collaborator_manage", args: { action: "stand_down", participants: [{ participantId }] } };
	return { agent: "lead", steps: [start("s1"), standDown, start("s3"), { id: "s4", text: "done" }] };
};

async function run(t, protocol, participantId) {
	const lead = rpc(t, { answer: true });
	await lead.script(lifecycle(protocol, participantId));
	await lead.until((e) => e.type === "agent_settled", 150_000, `${protocol}'s lifecycle`);
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
		assert.equal(await run(t, "auto", "w1"), 0, "a dialog opened with no autonomy setting");
		mkdirSync(join(t.repo, ".pi"), { recursive: true });
		writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ autonomy: false }));
		assert.equal(await run(t, "ask", "w2"), 3, "with autonomy false, start, stand-down and resume should each ask once");
	},
};
