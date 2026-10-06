import assert from "node:assert/strict";
import { eventually, fixtureModels, herdr, rpc } from "../drive.mjs";
import { dialogs, notifications, requests, toolCalls } from "../look.mjs";

// TaskStop stands a collaborator down with its reply in flight; a later SendMessage resumes its transcript.
export default {
	name: "collab-standdown",
	gate: "M6",
	live: true,
	timeoutMs: 240_000,
	async run(t) {
		const { cli } = await herdr(t);
		fixtureModels(t, "polygon", ["worker"]);
		t.scripts.worker = { agent: "worker", steps: [
			{ id: "w1", tool: "bash", args: { command: "sleep 3" } },
			{ id: "w2", tool: "SendMessage", args: { to: "main", message: "standdown-reply" } },
			{ id: "w3", text: "replied" },
		] };
		t.marks.push("standdown-go", "standdown-again");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_start", args: { participants: [{ name: "worker", model: "polygon/worker", profile: "read-only" }] } },
			{ id: "s2", tool: "SendMessage", args: { to: "worker", message: "standdown-go" } },
			{ id: "s3", tool: "TaskStop", args: { task_id: "worker" } },
			{ id: "s4", tool: "bash", args: { command: "sleep 2" } },
			{ id: "s5", tool: "SendMessage", args: { to: "worker", message: "standdown-again" } },
			{ id: "s6", text: "done" },
		] });
		await lead.until((_, events) => toolCalls(events).length >= 3, 150_000, "the stand-down");
		const [start, , stop] = toolCalls(lead.events);
		assert.equal(stop.isError, false, stop.text);
		const pane = start.details.results[0].paneId;
		assert.ok(!(await cli("pane", "list")).panes.some((p) => p.pane_id === pane), "the stood-down collaborator's tab is still open");
		await lead.until((_, events) => toolCalls(events).length >= 5, 120_000, "the resuming send");
		assert.deepEqual(toolCalls(lead.events).map((c) => [c.name, c.isError]), [["collaborator_start", false], ["SendMessage", false], ["TaskStop", false], ["bash", false], ["SendMessage", false]], toolCalls(lead.events).at(-1).text);
		const resumed = await eventually(() => requests(t).find((r) => r.agent === "worker" && r.marks.includes("standdown-again")), 60_000, "the resumed collaborator's request");
		assert.ok(resumed.marks.includes("standdown-go"), "the resumed collaborator lost its transcript");
		await eventually(() => notifications(lead.events).some((n) => n.customType === "collaborator-message"), 30_000, "the reply sent mid-stand-down");
		assert.equal(notifications(lead.events).filter((n) => n.customType === "collaborator-message").length, 1, "the in-flight reply arrived other than once");
		assert.equal((await cli("tab", "list")).tabs.filter((tab) => tab.label === "collaborator:worker").length, 1, "the resumed collaborator has other than one tab");
		assert.equal(dialogs(lead.events), 0);
	},
};
