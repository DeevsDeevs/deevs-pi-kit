import assert from "node:assert/strict";
import { pi, script } from "../drive.mjs";
import { procs, requests } from "../look.mjs";
import { say } from "./wf-shapes.mjs";

// The agents run luna on the openai-codex login, whose WebSocket Pi caches per provider session for 5 min.
const work = (text) => [{ id: "w", tool: "bash", args: { command: "sleep 2" } }, { id: "c", text }];
const LAUNCH = {
	agent: { tool: "Agent", args: { description: "probe", model: "luna", prompt: script({ agent: "child", steps: work("pong") }) } },
	workflow: { tool: "Workflow", args: { script: `export const meta = { name: "probe", description: "one agent" };\nreturn await agent(${say("wfchild", work("wf out"))}, { model: "luna" });` } },
	job: { tool: "job_start", args: { command: "sleep 2; echo job-ok", description: "probe", timeout: 60_000 } },
};

// Print mode holds the run while a background task runs, answers its report, then exits at once, as CC's -p does.
export default {
	name: "print-exit",
	gate: "M1",
	async run(t) {
		const runs = await Promise.all(Object.entries(LAUNCH).map(async ([kind, launch]) => {
			const started = Date.now();
			const run = await pi(t, ["-p", "--no-session", "--model", "polygon/puppet", script({ agent: "lead", steps: [
				{ id: "s1", ...launch },
				{ id: "s2", text: "launched" },
				{ id: "s3", on: "task-notification", text: `answered ${kind}` },
			] })], { timeoutMs: 45_000 });
			return { kind, ...run, seconds: (Date.now() - started) / 1000 };
		}));
		for (const run of runs) {
			assert.equal(run.signal, null, `print mode with a background ${run.kind} never exited (killed after ${run.seconds} s)`);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, new RegExp(`answered ${run.kind}`), `print mode exited before answering the ${run.kind}'s report`);
			assert.ok(run.seconds < 20, `print mode with a background ${run.kind} took ${run.seconds} s to exit`);
		}
		assert.deepEqual(requests(t).filter((r) => r.agent !== "lead").map((r) => r.url), Array(4).fill("ws:/codex/responses"), "the agents did not run on the openai-codex WebSocket");
		assert.deepEqual(procs(t), [], "census: a print run left processes behind");
	},
};
