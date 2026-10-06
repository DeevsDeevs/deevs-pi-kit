import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { toolCalls } from "../look.mjs";

const todos = (second) => [{ id: "1", title: "first", status: "done" }, { id: "2", title: "second", status: second }];

export default {
	name: "ext-todos",
	gate: "M0",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "todo_list", args: { operation: "write", todos: todos("pending") } },
			{ id: "s2", tool: "todo_list", args: { operation: "read" } },
			{ id: "s3", tool: "todo_list", args: { operation: "write", todos: todos("done") } },
			{ id: "s4", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["todo_list", false], ["todo_list", false], ["todo_list", false]]);
		const [added, listed, finished] = calls.map((c) => c.details);
		assert.deepEqual([added.stats.total, added.stats.done], [2, 1]);
		assert.deepEqual(listed.todos.map((todo) => [todo.id, todo.status]), [["1", "done"], ["2", "pending"]]);
		assert.deepEqual([finished.stats.total, finished.stats.done], [2, 2]);
	},
};
