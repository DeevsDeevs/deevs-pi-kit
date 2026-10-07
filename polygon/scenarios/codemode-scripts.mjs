import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

// A lead's codemode script starts a job and lists the roster; job_start and ListAgents resolve to structured values. A
// detached bash is still refused, and Agent, ask_user, collaborator_start and Workflow are not callable: agents fan out
// from the model's own calls or a Workflow, which runs its own script; ask_user waits on a person, collaborator_start
// opens Herdr tabs.
const CODE = [
	"const job = await tools.job_start({ command: 'echo job-ok', description: 'probe', timeout: 30000 });",
	"const listed = await tools.ListAgents({});",
	"const bg = await tools.bash({ command: 'sleep 30 & echo bg' }).then(() => 'ran', () => 'refused');",
	"return JSON.stringify({ job: Object.keys(job).sort().join(), kinds: listed.tasks.map((task) => task.kind).join(), bg, callable: ['Agent', 'ListAgents', 'job_start', 'bash', 'ask_user', 'collaborator_start', 'Workflow'].filter((name) => name in tools).join() });",
].join("\n");
const EXPECTED = { job: "outputFile,taskId", kinds: "job", bg: "refused", callable: "ListAgents,job_start,bash" };

export default {
	name: "codemode-scripts",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "c1", tool: "codemode", args: { code: CODE } }, { id: "c2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 60_000, "the job's report");
		const call = toolCalls(lead.events).find((c) => c.name === "codemode");
		assert.equal(call.isError, false, call.text);
		assert.deepEqual(JSON.parse(/\{"job".*\}/.exec(call.text)?.[0] ?? "null"), EXPECTED, call.text);
	},
};
