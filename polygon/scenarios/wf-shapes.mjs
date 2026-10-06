import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, script } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";

/** A JS string literal holding an agent's puppet script; its default answer is `[polygon:c] <agent> out`. */
export const say = (agent, steps = [{ id: "c", text: `${agent} out` }]) => JSON.stringify(script({ agent, steps }));
export const out = (agent) => `[polygon:c] ${agent} out`;
export const launches = (events) => toolCalls(events).filter((c) => c.name === "Workflow" && !c.isError).map((c) => c.details);
const jsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
export const journal = (run) => jsonl(join(run.transcriptDir, "journal.jsonl"));
export const progressEvents = (run) => jsonl(join(run.transcriptDir, "progress.jsonl"));
export const usageOf = (note) => Object.fromEntries([...(note.usage ?? "").matchAll(/<(\w+)>(\d+)<\/\1>/g)].map((m) => [m[1], Number(m[2])]));

// CC's run record keys (wf_<id>.json); `error` appears only on a failed run.
const RECORD_KEYS = ["agentCount", "args", "defaultModel", "durationMs", "logs", "phases", "result", "runId", "script", "scriptPath", "startTime", "status", "summary", "taskId", "timestamp", "title", "totalTokens", "totalToolCalls", "workflowName", "workflowProgress"];

const SOURCE = [
	'export const meta = { name: "shapes", description: "Fan out, then chain", phases: [{ title: "Fan out" }, { title: "Chain" }] };',
	'phase("Fan out");',
	`const fan = await parallel([() => agent(${say("par1")}, { label: "par 1" }), () => agent(${say("par2")}, { label: "par 2" })]);`,
	'phase("Chain");',
	`const chain = await pipeline([args.seed], () => agent(${say("pipe1")}, { label: "pipe 1" }), () => agent(${say("pipe2")}, { label: "pipe 2", phase: "Tail" }));`,
	'log("shapes done");',
	"return { fan, chain };",
].join("\n");

export default {
	name: "wf-shapes",
	gate: "M3",
	live: true,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Workflow", args: { script: SOURCE, args: '{"seed":"x"}' } }, { id: "s2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 60_000, "the workflow notification");
		const [run] = launches(lead.events);
		assert.match(run.taskId, /^w[0-9a-z]{8}$/);
		assert.match(run.runId, /^wf_[0-9a-f]{8}-[0-9a-f]{3}$/);
		assert.equal(readFileSync(run.scriptPath, "utf8"), SOURCE, "the persisted script differs");
		const [note] = taskNotifications(lead.events);
		assert.equal(note.status, "completed");
		assert.equal(note.taskId, run.taskId);
		assert.deepEqual(JSON.parse(note.result), { fan: [out("par1"), out("par2")], chain: [out("pipe2")] });
		assert.match(note.diagnostics, /journal\.jsonl[\s\S]*BEFORE diagnosing[\s\S]*the longest unchanged prefix of agent\(\) calls replays from cache/);
		assert.deepEqual(usageOf(note), { agent_count: 4, agents_done: 4, agents_error: 0, agents_skipped: 0, agents_empty_result: 0, subagent_tokens: usageOf(note).subagent_tokens, tool_uses: 0, duration_ms: usageOf(note).duration_ms });

		const rows = journal(run);
		assert.deepEqual(rows.map((r) => (r.type === "started" ? `started ${r.label} ${r.phase}` : r.type === "result" ? `result ${r.result}` : r.type)).sort(), [
			"launched",
			`result ${out("par1")}`, `result ${out("par2")}`, `result ${out("pipe1")}`, `result ${out("pipe2")}`,
			"started par 1 Fan out", "started par 2 Fan out", "started pipe 1 Chain", "started pipe 2 Tail",
		].sort());
		const started = new Map(rows.filter((r) => r.type === "started").map((r) => [r.key, r.agentId]));
		assert.ok(rows.filter((r) => r.type === "result").every((r) => /^v2:[0-9a-f]{64}$/.test(r.key) && started.get(r.key) === r.agentId), "a result row does not match its started row");

		const record = JSON.parse(readFileSync(join(run.transcriptDir, `${run.runId}.json`), "utf8"));
		assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
		assert.deepEqual([record.status, record.workflowName, record.agentCount, record.phases, record.logs], ["completed", "shapes", 4, ["Fan out", "Chain", "Tail"], ["shapes done"]]);
		assert.deepEqual(progressEvents(run).filter((e) => e.type === "workflow_phase").map((e) => e.title), ["Fan out", "Chain", "Tail"]);
		assert.deepEqual(requests(t).filter((r) => r.agent !== "lead").map((r) => r.agent).sort(), ["par1", "par2", "pipe1", "pipe2"]);
	},
};
