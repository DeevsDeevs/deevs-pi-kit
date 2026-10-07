import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pi, script } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";
import { say } from "./wf-shapes.mjs";

// `pi --print --mode json`, as the benchmarks run it: the lead ends its turn while a Workflow or an Agent still works, and Pi
// stays open until the report has run its turn. A job without a timeout is not waited for, and its result says so.
// The report's run checks with a tool before it answers, and the headless rule still reaches that answer.
// Each run keeps its session: the engine store is per session.
const slow = (agent, file) => [{ id: "w", tool: "bash", args: { command: `sleep 3 && touch ${file}` } }, { id: "c", text: `${agent} out` }];
const WORKFLOW = ['export const meta = { name: "slow", description: "One slow agent" };', `return await agent(${say("slowwf", slow("slowwf", "wf-done"))});`].join("\n");
const HEADLESS = "Non-interactive run: nobody will reply before Pi exits.";
const lead = (first) => script({ agent: "lead", steps: [{ id: "s1", ...first }, { id: "s2", text: "still running" }, { id: "s3", on: "<task-notification>", tool: "bash", args: { command: "true" } }, { id: "s4", text: "reported" }] });
const print = (t, prompt) => pi(t, ["--print", "--mode", "json", "--model", "polygon/puppet", prompt], { timeoutMs: 90_000 });
const texts = (events) => events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => [events.indexOf(e), (e.message.content ?? []).map((b) => b.text ?? "").join("")]).filter(([, text]) => text);

export default {
	name: "print-wait",
	gate: "M1",
	async run(t) {
		t.marks.push(HEADLESS);
		for (const [first, file] of [[{ tool: "Workflow", args: { script: WORKFLOW } }, "wf-done"], [{ tool: "Agent", args: { description: "slow", prompt: script({ agent: "slowagent", steps: slow("slowagent", "agent-done") }) } }, "agent-done"]]) {
			const run = await print(t, lead(first));
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(taskNotifications(run.events).map((n) => n.status), ["completed"], `${first.tool}: one completed report`);
			const noteAt = run.events.findIndex((e) => e.type === "message_end" && e.message?.customType === "task-notification");
			const [at, text] = texts(run.events).at(-1);
			assert.equal(text, "[polygon:s4] reported", `${first.tool}: the report's turn ran before Pi exited`);
			assert.ok(at > noteAt, `${first.tool}: the last answer follows the report`);
			assert.ok(existsSync(join(t.repo, file)), `${first.tool}: the agent's work landed`);
		}
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead" && r.step === "s4").map((r) => r.marks), [[HEADLESS], [HEADLESS]], "the headless rule left the lead's answer after a report and a tool turn");

		const started = Date.now();
		const job = await print(t, lead({ tool: "job_start", args: { command: "sleep 60", description: "untimed" } }));
		assert.equal(job.status, 0, job.stderr);
		assert.ok(Date.now() - started < 30_000, "print mode waited for a job without a timeout");
		assert.deepEqual(taskNotifications(job.events), []);
		assert.match(toolCalls(job.events).find((c) => c.name === "job_start").text, /^Non-interactive run: Pi exits when your turn ends/m);
		assert.equal(texts(job.events).at(-1)[1], "[polygon:s2] still running");
	},
};
