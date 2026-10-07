import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eventually, rpc, script } from "../drive.mjs";
import { procs, taskNotifications, toolCalls } from "../look.mjs";

const sleeper = (agent, marker) => script({ agent, steps: [{ id: "b1", tool: "Bash", args: { command: `touch ${marker}; sleep 300` } }, { id: "c1", text: "never" }] });
const writer = script({ agent: "fg", steps: [{ id: "w1", tool: "Bash", args: { command: "printf fg > fg.txt && git add fg.txt && git commit -qm fg" } }, { id: "w2", text: "committed" }] });

// Claude workers: a foreground one in its own worktree answers in the tool result with the kept branch; TaskStop and
// /agents stop kill a running one's process group, and SendMessage refuses the one the user stopped.
export default {
	name: "cli-stop",
	gate: "M4",
	timeoutMs: 150_000,
	async run(t) {
		const markers = ["lead-stop", "user-stop"].map((name) => join(t.dir, name));
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "fg writer", prompt: writer, model: "opus", isolation: "worktree", run_in_background: false } },
			{ id: "s2", tool: "Agent", args: { description: "lead stops", name: "lead-stop", prompt: sleeper("ls", markers[0]), model: "opus" } },
			{ id: "s3", tool: "Agent", args: { description: "user stops", name: "user-stop", prompt: sleeper("us", markers[1]), model: "opus" } },
			{ id: "s4", text: "launched" },
			{ id: "s5", on: "polygon-stop", tool: "TaskStop", args: { task_id: "lead-stop" } },
			{ id: "s6", text: "stopped" },
			{ id: "s7", on: "polygon-send", tool: "SendMessage", args: { to: "user-stop", message: "go on" } },
			{ id: "s8", text: "sent" },
		] });
		await eventually(() => markers.every(existsSync), 90_000, "both workers' commands to start");
		const [fg] = toolCalls(lead.events);
		assert.equal(fg.isError, false, fg.text);
		const branch = /worktreeBranch: (\S+)/.exec(fg.text)?.[1];
		assert.ok(branch, "the foreground result did not report its kept worktree");
		assert.equal(t.git("log", "-1", "--format=%s", branch).trim(), "fg");
		assert.equal(t.git("status", "--porcelain"), "", "the foreground worker wrote outside its worktree");
		await lead.prompt("polygon-stop");
		await lead.prompt("/agents stop user-stop");
		await lead.until((_, events) => taskNotifications(events).length >= 2, 30_000, "both stopped workers' reports");
		assert.deepEqual(taskNotifications(lead.events).map((n) => n.status), ["killed", "killed"]);
		await lead.prompt("polygon-send");
		await lead.until((_, events) => toolCalls(events).some((c) => c.name === "SendMessage"), 30_000, "the SendMessage result");
		assert.deepEqual(toolCalls(lead.events).filter((c) => c.name !== "Agent").map((c) => [c.name, c.isError]), [["TaskStop", false], ["SendMessage", true]]);
		await eventually(() => !procs(t).some((p) => p.argv.includes("sleep")), 10_000, "the stopped workers' commands to exit");
	},
};
