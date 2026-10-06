import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { poll, requests, sessionNotes, taskNotifications } from "../look.mjs";
import { journal, launches, out, say } from "./wf-shapes.mjs";

// kill -9 while the second of three agents runs bash: on reopen the run continues by itself, no finished agent asks
// the model again, and one notification lands.
export default {
	name: "wf-kill9-continue",
	gate: "M3",
	timeoutMs: 120_000,
	async run(t) {
		const marker = join(t.repo, "k2-started");
		const source = [
			'export const meta = { name: "survivor", description: "Three agents in a row" };',
			`const a = await agent(${say("k1")}, { label: "k1" });`,
			`const b = await agent(${say("k2", [{ id: "b", tool: "bash", args: { command: `touch ${marker}; sleep 30` } }, { id: "c", text: "k2 out" }])}, { label: "k2" });`,
			`return [a, b, await agent(${say("k3")}, { label: "k3" })];`,
		].join("\n");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Workflow", args: { script: source } }, { id: "s2", text: "launched" }] });
		await poll(() => existsSync(marker), 30_000, "the second agent's bash to start");
		const [run] = launches(lead.events);
		await lead.restart();
		await poll(() => sessionNotes(t).length > 0, 60_000, "the workflow notification in the session");
		await new Promise((r) => setTimeout(r, 1_000));
		assert.equal(sessionNotes(t).length, 1, "the run notified more than once");
		const [note] = taskNotifications(lead.events);
		assert.equal(note.status, "completed");
		assert.deepEqual(JSON.parse(note.result), [out("k1"), out("k2"), out("k3")]);
		const asked = requests(t).filter((r) => r.agent !== "lead").map((r) => `${r.agent}:${r.step}`);
		assert.deepEqual(asked.sort(), ["k1:c", "k2:b", "k2:c", "k3:c"], "an agent asked the model twice");
		const rows = journal(run);
		assert.equal(rows.filter((r) => r.type === "result").length, 3);
		assert.equal(rows.filter((r) => r.type === "started").length, 3);
	},
};
