import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { exec, rpc, script } from "../drive.mjs";
import { dialogs, requests, taskNotifications } from "../look.mjs";

export const AGENT_ID = "$/\\ba[0-9a-f]{16}\\b/";
export const SCHEMA = { type: "object", properties: { verdict: { type: "string", enum: ["ok", "bad"] }, note: { type: "string" } }, required: ["verdict"] };

let typeboxAlias = false;
/** The kit's own argv builder and stream reader, run against the real CLI. Outside Pi, like guard-hook.mjs, typebox is the `runtime-typebox` alias. */
export function cli(t) {
	if (!typeboxAlias) registerHooks({ resolve: (specifier, context, next) => next(specifier.replace(/^typebox(?=\/|$)/, "runtime-typebox"), context) });
	typeboxAlias = true;
	return import(join(t.kit, "extensions/subagents/engine/cli.ts"));
}

/** Lead steps: launch one CLI worker in the background, then message it once its first report arrives. */
export const workerThenResume = (model, child, message) => [
	{ id: "s1", tool: "Agent", args: { description: "cli probe", prompt: script(child), model, subagent_type: "Explore" } },
	{ id: "s2", text: "launched" },
	{ id: "s3", on: "<task-notification", tool: "SendMessage", args: { to: AGENT_ID, message } },
	{ id: "s4", text: "sent" },
];

// A Claude Code worker on the Anthropic wire: structured output through --json-schema, and a resume by session id.
// The raw streams land in the scenario dir; test/fixtures/cli/ holds copies for the unit tests.
export default {
	name: "claude-worker",
	gate: "M4",
	timeoutMs: 150_000,
	async run(t) {
		const { cliArgv, newProgress, readEvent } = await cli(t);
		const worker = { harness: "claude", model: "opus", level: "high", cwd: t.repo, instructions: "polygon worker", tools: ["read", "grep", "find", "ls", "bash"], writer: false, schema: SCHEMA, dir: join(t.dir, "cli") };
		writeFileSync(join(t.dir, "claude-help.txt"), (await exec(t, "claude", ["--help"])).stdout);
		const direct = { agent: "direct", steps: [{ id: "b1", tool: "Bash", args: { command: "echo polygon" } }, { id: "so", tool: "StructuredOutput", args: { verdict: "ok" } }, { id: "d2", on: "polygon-resume", text: "resumed" }] };
		const first = await exec(t, "claude", cliArgv(worker), { input: script(direct) });
		writeFileSync(join(t.dir, "claude-schema.jsonl"), first.stdout);
		assert.equal(first.status, 0, first.stderr);
		const progress = newProgress();
		for (const line of first.stdout.split("\n")) readEvent("claude", progress, line);
		assert.deepEqual(progress.structured, { verdict: "ok" }, "structured_output did not come back");
		const again = await exec(t, "claude", cliArgv({ ...worker, schema: undefined }, progress.sessionId), { input: "polygon-resume" });
		writeFileSync(join(t.dir, "claude-resume.jsonl"), again.stdout);
		assert.equal(again.status, 0, again.stderr);

		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: workerThenResume("opus", { agent: "cw", steps: [{ id: "c1", text: "first" }, { id: "c2", on: "polygon-resume", text: "resumed" }] }, "polygon-resume") });
		await lead.until((_, events) => taskNotifications(events).length >= 2, 90_000, "the run's and the resumed run's notifications");
		const notes = taskNotifications(lead.events);
		assert.deepEqual(notes.map((n) => n.status), ["completed", "completed"]);
		assert.equal(notes[0].taskId, notes[1].taskId, "the resume did not notify under the same id");
		for (const agent of ["direct", "cw"]) {
			const seen = requests(t).filter((r) => r.agent === agent);
			assert.ok(seen.length >= 2 && seen.every((r) => r.wire === "anthropic"), `${agent} did not run on the Anthropic wire`);
			assert.ok(seen.at(-1).messages > seen[0].messages, `${agent}'s resume lost its session`);
		}
		assert.deepEqual(requests(t).filter((r) => r.agent === "cw").map((r) => r.step), ["c1", "c2"]);
		assert.equal(dialogs(lead.events), 0);
	},
};
