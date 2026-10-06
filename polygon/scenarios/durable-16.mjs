import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, rpc, script, sleep } from "../drive.mjs";
import { sessionNotes, toolCalls } from "../look.mjs";

const N = 16;
const child = (i) => script({ agent: `c${i}`, steps: [1, 2, 3].map((n) => ({ id: `b${n}`, tool: "bash", args: { command: "sleep 1" } })).concat({ id: "done", text: "done" }) });

/** Owner pids in every engine.lock (A.8): a reopened session's engine holds the lock under the new Pi. */
function lockPids(t) {
	const root = join(t.agentDir, "pi-kit", "agents");
	try { return readdirSync(root, { recursive: true }).filter((f) => f.endsWith("engine.lock")).map((f) => JSON.parse(readFileSync(join(root, f), "utf8")).pid); } catch { return []; }
}

export default {
	name: "durable-16",
	gate: "M1",
	timing: true,
	slow: true,
	timeoutMs: 240_000,
	async run(t) {
		const lead = rpc(t);
		await lead.send({ type: "get_state" }, 30_000);
		let worst = 0, pinging = true;
		const pinger = (async () => { while (pinging) { const at = Date.now(); await lead.send({ type: "get_state" }); worst = Math.max(worst, Date.now() - at); await sleep(50); } })();
		await lead.script({ agent: "lead", steps: Array.from({ length: N }, (_, i) => ({ id: `s${i}`, tool: "Agent", args: { description: `stall probe ${i}`, prompt: child(i), run_in_background: true } })) });
		await lead.until((_, events) => toolCalls(events).length >= N, 60_000, `${N} Agent launches`);
		await sleep(3_000);
		pinging = false;
		await pinger;
		assert.ok(worst < 150, `worst lead stall ${worst} ms with ${N} agents`);
		for (let run = 1; run <= 10; run++) {
			await lead.restart();
			await eventually(() => lockPids(t).includes(lead.pid), 10_000, `the engine to reopen under the new Pi (run ${run} of 10)`);
			await sleep(700);
		}
		await eventually(() => new Set(sessionNotes(t).map((n) => n.taskId)).size >= N, 120_000, `all ${N} notifications`);
		await sleep(2_000);
		assert.equal(sessionNotes(t).length, N, "an agent reported more than once");
	},
};
