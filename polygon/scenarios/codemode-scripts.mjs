import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { agentIds, taskNotifications, toolCalls } from "../look.mjs";

// A lead's codemode script fans out two agents, one asking for the foreground, starts a job and lists the roster. Agent,
// job_start and ListAgents resolve to structured values. Both agents launch in the background, since a script cannot wait
// and a foreground report would also be notified. A detached bash is still refused, and ask_user, collaborator_start and
// Workflow are not callable: one waits on a person, one opens Herdr tabs, one runs its own script.
const child = (agent) => JSON.stringify(script({ agent, steps: [{ id: "r1", text: `${agent} done` }] }));
const CODE = [
	`const agents = await Promise.allSettled([tools.Agent({ description: "one", prompt: ${child("one")} }), tools.Agent({ description: "two", prompt: ${child("two")}, run_in_background: false })]);`,
	"const job = await tools.job_start({ command: 'echo job-ok', description: 'probe', timeout: 30000 });",
	"const listed = await tools.ListAgents({});",
	"const bg = await tools.bash({ command: 'sleep 30 & echo bg' }).then(() => 'ran', () => 'refused');",
	"return JSON.stringify({ agents: agents.map((a) => a.status === 'fulfilled' ? Object.keys(a.value).sort().join() : 'rejected'), job: Object.keys(job).sort().join(), kinds: listed.tasks.map((task) => task.kind).sort().join(), bg, callable: ['Agent', 'ListAgents', 'job_start', 'bash', 'ask_user', 'collaborator_start', 'Workflow'].filter((name) => name in tools).join() });",
].join("\n");
const EXPECTED = { agents: ["agentId,outputFile", "agentId,outputFile"], job: "outputFile,taskId", kinds: "agent,agent,job", bg: "refused", callable: "Agent,ListAgents,job_start,bash" };
const agentNotes = (notes) => notes.filter((n) => agentIds(n.taskId ?? "").length);

export default {
	name: "codemode-scripts",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "c1", tool: "codemode", args: { code: CODE } }, { id: "c2", text: "launched" }] });
		await lead.until((_, events) => agentNotes(taskNotifications(events)).length >= 2, 60_000, "both agents' reports");
		const call = toolCalls(lead.events).find((c) => c.name === "codemode");
		assert.equal(call.isError, false, call.text);
		assert.deepEqual(JSON.parse(/\{"agents".*\}/.exec(call.text)?.[0] ?? "null"), EXPECTED, call.text);
		assert.deepEqual(toolCalls(lead.events).filter((c) => c.name === "Agent").map((c) => c.details.status), ["async_launched", "async_launched"], "an agent a script started ran in the foreground");
		assert.equal(new Set(agentNotes(taskNotifications(lead.events)).map((n) => n.taskId)).size, 2);
	},
};
