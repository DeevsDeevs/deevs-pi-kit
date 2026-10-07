import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, taskNotifications } from "../look.mjs";
import { journal, launches, out, say, usageOf } from "./wf-shapes.mjs";

// A 500 and a 429 that outlast every retry (5, about 62 s of backoff) each turn one agent into null; the run still completes.
const SOURCE = [
	'export const meta = { name: "nulls", description: "Failures become null" };',
	`return await parallel([`,
	`  () => agent(${say("fine")}, { label: "fine" }),`,
	`  () => agent(${say("e500", [{ id: "c", error: { status: 500 } }])}, { label: "boom 500" }),`,
	`  () => agent(${say("e429", [{ id: "c", error: { status: 429, retryAfter: 0 } }])}, { label: "busy 429" }),`,
	"]);",
].join("\n");

export default {
	name: "wf-null-on-failure",
	gate: "M3",
	timeoutMs: 180_000,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Workflow", args: { script: SOURCE } }, { id: "s2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 150_000, "the workflow notification");
		const [note] = taskNotifications(lead.events);
		assert.equal(note.status, "completed");
		assert.deepEqual(JSON.parse(note.result), [out("fine"), null, null]);
		const failures = note.failures.split("\n");
		assert.equal(failures.length, 2, note.failures);
		assert.ok(failures.some((line) => line.startsWith("[boom 500] failed: ")) && failures.some((line) => line.startsWith("[busy 429] failed: ")), note.failures);
		const usage = usageOf(note);
		assert.deepEqual([usage.agent_count, usage.agents_done, usage.agents_error], [3, 1, 2]);
		const [run] = launches(lead.events);
		assert.equal(journal(run).filter((r) => r.type === "failed").length, 2);
		assert.deepEqual(["e500", "e429"].map((agent) => requests(t).filter((r) => r.agent === agent).length), [6, 6], "each failing agent: 1 request and 5 retries");
	},
};
