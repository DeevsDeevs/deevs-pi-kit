import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rpc } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

// The user's recorded Claude Code workflow scripts run unchanged: every one parses, completes with its agents
// answering schema-shaped stubs, and journals their results. They live in the gitignored polygon/private/
// (with their recorded args as <script>.args.json), copied from ~/.claude/projects/*/*/workflows/scripts/.
const PRIVATE = fileURLToPath(new URL("../private/", import.meta.url));
const recorded = existsSync(PRIVATE) ? readdirSync(PRIVATE).filter((f) => f.endsWith(".js")).sort() : [];
const GO = "RUN-RECORDED";

export default {
	name: "wf-cc-scripts",
	gate: ["M3", "M7"],
	pending: recorded.length ? undefined : "no recorded scripts in polygon/private/",
	timeoutMs: 600_000,
	async run(t) {
		assert.ok(recorded.length, "polygon/private/ holds no recorded scripts");
		// Every agent is a puppet Pi agent: Claude names point at the puppet too.
		writeFileSync(join(t.agentDir, "pi-kit.json"), JSON.stringify({ models: Object.fromEntries(["opus", "sonnet", "haiku", "fable"].map((n) => [n, "polygon/puppet"])) }));
		t.scripts.puppet = { agent: "wf", steps: [{ id: "a1", schema: "auto", text: "stub" }] };
		const launches = recorded.map((file, i) => {
			const argsFile = join(PRIVATE, file.replace(/\.js$/, ".args.json"));
			const args = existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : undefined;
			return { id: `w${i}`, tool: "Workflow", args: { scriptPath: join(PRIVATE, file), ...(args === undefined ? {} : { args }) } };
		});
		const lead = rpc(t);
		// The workflows launch from a second, plain prompt, so the user request agents see carries no POLYGON script.
		await lead.script({ agent: "lead", steps: [{ id: "ready", text: "ready" }, { ...launches[0], on: GO }, ...launches.slice(1), { id: "done", text: "launched" }] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the first turn");
		await lead.prompt(GO);
		await lead.until((_, events) => toolCalls(events).filter((c) => c.name === "Workflow").length === recorded.length, 120_000, "every launch");

		const calls = toolCalls(lead.events).filter((c) => c.name === "Workflow");
		assert.deepEqual(calls.filter((c) => c.isError).map((c) => c.text.split("\n")[0]), [], "a recorded script was refused");
		const runs = calls.map((c) => ({ taskId: /Task ID: (w[0-9a-z]+)/.exec(c.text)?.[1], runId: /Run ID: (wf_[0-9a-z-]+)/.exec(c.text)?.[1] }));
		const taskIds = new Set(runs.map((r) => r.taskId));
		await lead.until((_, events) => taskNotifications(events).filter((n) => taskIds.has(n.taskId)).length >= recorded.length, 480_000, "every workflow notification");

		const notes = taskNotifications(lead.events).filter((n) => taskIds.has(n.taskId));
		assert.equal(notes.length, recorded.length, "each workflow notifies exactly once");
		const unfinished = runs.filter((r) => notes.find((n) => n.taskId === r.taskId)?.status !== "completed");
		assert.deepEqual(unfinished.map((r) => recorded[runs.indexOf(r)]), [], "a recorded script did not complete");
		const journals = readdirSync(join(t.agentDir, "pi-kit", "workflows"), { recursive: true }).filter((p) => p.endsWith("journal.jsonl"));
		for (const [i, { runId }] of runs.entries()) {
			const journal = journals.find((p) => p.endsWith(join(runId, "journal.jsonl")));
			assert.ok(journal, `${recorded[i]}: no journal for ${runId}`);
			const rows = readFileSync(join(t.agentDir, "pi-kit", "workflows", journal), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
			assert.ok(rows.some((r) => r.type === "result"), `${recorded[i]}: ${runId} journaled no agent result`);
		}
		assert.doesNotMatch(lead.stderr, /unhandled/i, "an unhandled rejection reached the lead");
	},
};
