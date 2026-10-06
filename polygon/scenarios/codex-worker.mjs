import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, rpc, script } from "../drive.mjs";
import { dialogs, requests, taskNotes } from "../look.mjs";
import { cli, SCHEMA, workerThenResume } from "./claude-worker.mjs";

const WRITE = "`sandbox_mode` is `workspace-write`";
const READ_ONLY = "`sandbox_mode` is `read-only`";
const NULLABLE = '"note":{"anyOf":[{"type":"string"},{"type":"null"}]}';

// A Codex worker on the Responses wire: --output-schema after strictify with the optional field nulled, and an
// `exec resume` that keeps the writer's sandbox mode. The raw stream lands in the scenario dir for test/fixtures/cli/.
export default {
	name: "codex-worker",
	gate: "M4",
	timeoutMs: 150_000,
	async run(t) {
		t.marks.push(WRITE, READ_ONLY, NULLABLE);
		const { cliArgv, dropNulls, lastMessageFile, schemaFile, strictify } = await cli(t);
		const worker = { harness: "codex", model: "puppet", level: "max", cwd: t.repo, instructions: "polygon worker", tools: ["read", "grep", "find", "ls", "bash"], writer: false, schema: SCHEMA, dir: join(t.dir, "cli") };
		mkdirSync(worker.dir, { recursive: true });
		writeFileSync(schemaFile(worker), JSON.stringify(strictify(SCHEMA)));
		for (const help of [["exec"], ["exec", "resume"]]) writeFileSync(join(t.dir, `codex-${help.join("-")}-help.txt`), (await exec(t, "codex", [...help, "--help"])).stdout);
		const steps = [{ id: "x1", tool: "exec_command", args: { cmd: "echo polygon" } }, { text: '{"verdict":"ok","note":null}' }];
		const direct = await exec(t, "codex", cliArgv(worker), { input: script({ agent: "direct", steps }) });
		writeFileSync(join(t.dir, "codex-schema.jsonl"), direct.stdout);
		assert.equal(direct.status, 0, direct.stderr);
		assert.deepEqual(dropNulls(JSON.parse(readFileSync(lastMessageFile(worker), "utf8"))), { verdict: "ok" });
		assert.ok(requests(t).find((r) => r.agent === "direct")?.marks.includes(NULLABLE), "the optional field was not nulled in the schema");

		const lead = rpc(t);
		const child = { agent: "xw", steps: [{ id: "c1", text: "first" }, { id: "c2", on: "polygon-resume", text: "resumed" }] };
		await lead.script({ agent: "lead", steps: workerThenResume("codex:puppet", child, "polygon-resume").map((s) => (s.id === "s1" ? { ...s, args: { ...s.args, subagent_type: "general-purpose" } } : s)) });
		await lead.until((_, events) => taskNotes(events).length >= 2, 90_000, "the run's and the resumed run's notifications");
		const notes = taskNotes(lead.events);
		assert.deepEqual(notes.map((n) => n.status), ["completed", "completed"]);
		assert.equal(notes[0].taskId, notes[1].taskId);
		const xw = requests(t).filter((r) => r.agent === "xw");
		assert.deepEqual(xw.map((r) => [r.wire, r.step]), [["responses", "c1"], ["responses", "c2"]]);
		assert.ok(xw[1].messages > xw[0].messages, "the resume lost its thread");
		assert.ok(xw[1].marks.includes(WRITE) && !xw[1].marks.includes(READ_ONLY), "exec resume dropped the writer's sandbox mode");
		assert.equal(dialogs(lead.events), 0);
	},
};
