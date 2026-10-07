import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { agentIds, taskNotifications, toolCalls } from "../look.mjs";

// A lead's codemode script launches an agent, starts a job and lists the roster: Agent, job_start and ListAgents resolve to
// structured values, and the agent reports once. A detached bash from a script is still refused.
const child = (agent) => JSON.stringify(script({ agent, steps: [{ id: "r1", text: `${agent} done` }] }));
const CODE = [
	`const agents = await Promise.allSettled([tools.Agent({ description: "one", prompt: ${child("one")} })]);`,
	"const job = await tools.job_start({ command: 'echo job-ok', description: 'probe', timeout: 30000 });",
	"const listed = await tools.ListAgents({});",
	"const bg = await tools.bash({ command: 'sleep 30 & echo bg' }).then(() => 'ran', () => 'refused');",
	"return JSON.stringify({ agents: agents.map((a) => a.status === 'fulfilled' ? Object.keys(a.value).sort().join() : 'rejected'), job: Object.keys(job).sort().join(), kinds: listed.tasks.map((task) => task.kind).sort().join(), bg });",
].join("\n");
const EXPECTED = { agents: ["agentId,outputFile"], job: "outputFile,taskId", kinds: "agent,job", bg: "refused" };
const agentNotes = (notes) => notes.filter((n) => agentIds(n.taskId ?? "").length);

export default {
	name: "codemode-scripts",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "c1", tool: "codemode", args: { code: CODE } }, { id: "c2", text: "launched" }] });
		await lead.until((_, events) => agentNotes(taskNotifications(events)).length >= 1, 60_000, "the agent's report");
		const call = toolCalls(lead.events).find((c) => c.name === "codemode");
		assert.equal(call.isError, false, call.text);
		assert.deepEqual(JSON.parse(/\{"agents".*\}/.exec(call.text)?.[0] ?? "null"), EXPECTED, call.text);
	},
};
