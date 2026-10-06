import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { requests, taskNotifications } from "../look.mjs";

const NUDGE = "structured-output-enforce";
const prompt = (agent, steps) => `POLYGON ${JSON.stringify({ agent, steps })}`;
const bad = (id) => ({ id, tool: "StructuredOutput", args: { n: "x" } });
const agents = {
	retry: prompt("retry", [bad("r1"), { id: "r2", tool: "StructuredOutput", args: { n: 7 } }]),
	nudged: prompt("nudged", [{ id: "n1", text: "plain" }, { id: "n2", on: NUDGE, tool: "StructuredOutput", args: { n: 3 } }]),
	silent: prompt("silent", [{ id: "p1", text: "plain" }, { id: "p2", on: NUDGE, text: "still plain" }]),
	capped: prompt("capped", [...[1, 2, 3, 4, 5].map((i) => bad(`c${i}`)), { id: "c6", tool: "StructuredOutput", args: { n: 1 } }]),
	unusable: prompt("unusable", [{ id: "u1", text: "never started" }]),
};

// agent(prompt, {schema}) returns the validated object, retries a rejected call in-conversation, nudges once, and throws
// CC's errors for an unusable schema, a run that never calls StructuredOutput, and the fifth failed call.
const script = `export const meta = { name: "wf-schema", description: "StructuredOutput contract" };
const agents = ${JSON.stringify(agents)};
const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
const thrown = (run) => run().then(() => "no throw", (error) => error.message);
return {
	retry: await agent(agents.retry, { label: "retry", schema }),
	nudged: await agent(agents.nudged, { label: "nudged", schema }),
	silent: await thrown(() => agent(agents.silent, { label: "silent", schema })),
	capped: await thrown(() => agent(agents.capped, { label: "capped", schema })),
	unusable: await thrown(() => agent(agents.unusable, { label: "unusable", schema: { type: "object", properties: {}, required: ["n"] } })),
};`;

export default {
	name: "wf-schema",
	gate: "M3",
	pending: "needs Workflow (3.3)",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Workflow", args: { script } }, { id: "s2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 60_000, "the workflow's report");
		const [note] = taskNotifications(lead.events);
		assert.equal(note.status, "completed");
		const result = JSON.parse(note.result);
		assert.deepEqual([result.retry, result.nudged], [{ n: 7 }, { n: 3 }]);
		assert.equal(result.silent, "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)");
		assert.match(result.capped, /^agent\(\{schema\}\): StructuredOutput retry cap \(5\) exceeded — 5 failed calls with no valid output/);
		assert.match(result.unusable, /^agent\(\{schema\}\) received an unusable JSON Schema — /);
		const log = requests(t);
		const steps = (agent) => log.filter((r) => r.agent === agent).map((r) => r.step);
		assert.ok(log.filter((r) => r.agent === "retry").every((r) => r.tools.includes("StructuredOutput")), "a schema agent was not offered StructuredOutput");
		assert.deepEqual(steps("capped"), ["c1", "c2", "c3", "c4", "c5"], "the model was asked again after the fifth failed call");
		assert.deepEqual(steps("unusable"), [], "an agent with an unusable schema started");
	},
};
