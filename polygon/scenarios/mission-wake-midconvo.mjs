import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, rpc, script } from "../drive.mjs";
import { jsonl, owned, runs, settled } from "../look.mjs";

// A model that takes system messages mid-conversation (gpt-6.1-sol, Opus) sees Pi's prompt updates. A mission started in
// an earlier run stays in a report-woken run's prompt, once, with no removal, and the next prompt's re-add is not repeated.
const GUIDANCE = "Work toward the done criteria without waiting for the user.";
const REMOVED = 'Removed system prompt section \\"mission\\"';
const short = script({ agent: "short", steps: [{ id: "h1", tool: "bash", args: { command: "sleep 2" } }, { id: "h2", text: "short done" }] });

export default {
	name: "mission-wake-midconvo",
	gate: "M5",
	bodies: true,
	async run(t) {
		const file = join(t.agentDir, "models.json");
		const config = JSON.parse(readFileSync(file, "utf8"));
		config.providers.polygon.models[0].compat = { supportsMidConvoSystemMessages: true };
		writeFileSync(file, JSON.stringify(config));
		const stop = join(t.repo, "stop");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_start", args: { title: "midconvo", goal: "Keep the mission across a report.", done: "The next prompt answered." } },
			// Running until the assertions, so no mission continue starts a run of its own.
			{ id: "s2", tool: "job_start", args: { command: `until [ -e ${stop} ]; do sleep 0.1; done`, description: "long" } },
			{ id: "s3", text: "started" },
			{ id: "s4", on: "go-launch", tool: "Agent", args: { description: "short", prompt: short, run_in_background: true } },
			{ id: "s5", text: "launched short" },
			{ id: "s6", on: "task-notification", tool: "bash", args: { command: "true" } },
			{ id: "s7", tool: "bash", args: { command: "true" } },
			{ id: "s8", text: "woken" },
			{ id: "s9", on: "go-on", text: "answered" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "run 1");
		await lead.prompt("go-launch");
		await lead.until((_, events) => runs(events) >= 3 && settled(events) >= 3, 60_000, "the report-woken run");
		await lead.prompt("go-on");
		await lead.until((_, events) => runs(events) >= 4 && settled(events) >= 4, 30_000, "the next prompt");
		const bodies = jsonl(join(t.dir, "bodies.jsonl")).filter((b) => b.agent === "lead").map((b) => ({ step: b.step, raw: JSON.stringify(b.body) }));
		writeFileSync(stop, "");
		await eventually(() => owned(t).length === 0, 10_000, "the job to end");
		assert.deepEqual(bodies.map((b) => b.step), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
		assert.deepEqual(bodies.filter((b) => b.raw.includes(REMOVED)).map((b) => b.step), [], "no request removes the open mission");
		assert.deepEqual(bodies.map((b) => b.raw.split(GUIDANCE).length - 1), [0, 1, 1, 1, 1, 1, 1, 1, 1], "every request after mission_start carries the mission once");
	},
};
