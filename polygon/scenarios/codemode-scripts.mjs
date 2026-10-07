import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

// A lead's codemode script starts a job and lists the roster. Both resolve to the text the model reads, so the script
// gets the job's id and output file with its notes, and the roster's end-your-turn line while the job runs. A detached
// bash is still refused, and Agent, ask_user, collaborator_start, todo_list and Workflow are not callable: agents fan out
// from the model's own calls or a Workflow, which runs its own script; ask_user waits on a person, collaborator_start
// opens Herdr tabs, and the todo list is rebuilt only from top-level todo_list results.
const CODE = [
	"const job = await tools.job_start({ command: 'sleep 3; echo job-ok', description: 'probe', timeout: 30000 });",
	"const listed = await tools.ListAgents({});",
	"const bg = await tools.bash({ command: 'sleep 30 & echo bg' }).then(() => 'ran', () => 'refused');",
	"return JSON.stringify({ job, listed, bg, callable: ['Agent', 'ListAgents', 'job_start', 'bash', 'ask_user', 'collaborator_start', 'todo_list', 'Workflow'].filter((name) => name in tools).join() });",
].join("\n");

export default {
	name: "codemode-scripts",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "c1", tool: "codemode", args: { code: CODE } }, { id: "c2", text: "launched" }] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 60_000, "the job's report");
		const call = toolCalls(lead.events).find((c) => c.name === "codemode");
		assert.equal(call.isError, false, call.text);
		const { job, listed, bg, callable } = JSON.parse(/\{"job".*\}/.exec(call.text)?.[0] ?? "null");
		const id = /^Command running in background with ID: (b\w+)\. Output is being written to: \S+\nYou will be notified when it exits\. Do not poll/.exec(job)?.[1];
		assert.ok(id, job);
		assert.match(listed, new RegExp(`${id}[\\s\\S]*end your turn instead of polling`), listed);
		assert.deepEqual([bg, callable], ["refused", "ListAgents,job_start,bash"]);
	},
};
