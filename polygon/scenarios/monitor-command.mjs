import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { poll, procs, taskNotifications, toolCalls } from "../look.mjs";

// A three-line script ends with its exit code; `yes` is suppressed, then stopped; TaskStop leaves no process.
export default {
	name: "monitor-command",
	gate: "M5",
	timeoutMs: 120_000,
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Monitor", args: { command: "echo one; sleep 0.5; echo two; sleep 0.5; echo three; exit 3", description: "three lines" } },
			{ id: "s2", tool: "Monitor", args: { command: "yes", description: "firehose" } },
			{ id: "s3", tool: "Monitor", args: { command: "sleep 300", description: "quiet script" } },
			{ id: "s4", tool: "TaskStop", args: { task_id: "$/(?<=task )b[0-9a-z]{8}/" } },
			{ id: "s5", text: "armed" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 4, 30_000, "the launches and the stop");
		const [lines, firehose, quiet, stop] = toolCalls(lead.events);
		assert.deepEqual([lines, firehose, quiet, stop].map((c) => c.isError), [false, false, false, false]);
		const of = (call) => taskNotifications(lead.events).filter((n) => n.taskId === call.details.taskId);

		await lead.until(() => of(lines).some((n) => n.status), 30_000, "the three-line script's exit notice");
		assert.ok(of(lines).length <= 4, `the three-line script gave ${of(lines).length} notifications`);
		assert.deepEqual(of(lines).flatMap((n) => n.event.split("\n")).filter((l) => !l.startsWith("[")), ["one", "two", "three"]);
		assert.equal(of(lines).at(-1).status, "failed");
		assert.match(of(lines).at(-1).event, /code 3\b/);

		await lead.until(() => of(firehose).some((n) => n.status), 60_000, "the firehose to be stopped");
		assert.ok(of(firehose).some((n) => /events suppressed/.test(n.event)), "no event carried the suppression note");
		assert.match(of(firehose).at(-1).event, /Monitor stopped/);
		assert.equal(of(firehose).at(-1).status, "failed");

		assert.deepEqual(of(quiet), [], "a monitor stopped with TaskStop notified");
		await poll(() => procs(t).every((p) => p.pid === lead.pid || !["sleep", "yes"].includes(p.argv[0])), 10_000, "every monitor script to exit");
	},
};
