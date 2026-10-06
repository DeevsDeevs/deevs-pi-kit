import assert from "node:assert/strict";
import { rpc, sleep } from "../drive.mjs";
import { taskNotifications } from "../look.mjs";
import { launches, progressEvents, usageOf } from "./wf-shapes.mjs";

const N = 2_000;
const SOURCE = [
	'export const meta = { name: "scale", description: "Two thousand agents" };',
	`const results = await parallel(Array.from({ length: ${N} }, (_, i) => () => agent(\`POLYGON {"agent":"s\${i}","steps":[{"id":"c","text":"ok","delayMs":300}]}\`, { label: \`s\${i}\` })));`,
	"return results.filter((r) => r !== null).length;",
].join("\n");

// 2,000 agent() calls: no cap, never more than 16 running, and the lead answers within 150 ms throughout.
export default {
	name: "wf-scale",
	gate: "M3",
	slow: true,
	timeoutMs: 600_000,
	async run(t) {
		const lead = rpc(t);
		await lead.send({ type: "get_state" }, 30_000);
		let worst = 0, pinging = true;
		const pinger = (async () => { while (pinging) { const at = Date.now(); await lead.send({ type: "get_state" }); worst = Math.max(worst, Date.now() - at); await sleep(50); } })();
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Workflow", args: { script: SOURCE } }, { id: "s2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 540_000, "the workflow notification");
		pinging = false;
		await pinger;
		const [note] = taskNotifications(lead.events);
		assert.equal(note.status, "completed");
		assert.equal(JSON.parse(note.result), N);
		const usage = usageOf(note);
		assert.deepEqual([usage.agent_count, usage.agents_done, usage.agents_error], [N, N, 0]);
		let running = 0, peak = 0;
		for (const e of progressEvents(launches(lead.events)[0])) {
			if (e.type !== "workflow_agent") continue;
			if (e.state === "start") peak = Math.max(peak, ++running);
			else if (e.state === "done" || e.state === "error") running--;
		}
		assert.equal(peak, 16, "the run did not peak at 16 running agents");
		assert.ok(worst < 150, `worst lead stall ${worst} ms over ${N} agents`);
	},
};
