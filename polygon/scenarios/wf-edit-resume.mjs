import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { rpc } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";
import { launches, out, progressEvents, say } from "./wf-shapes.mjs";

const source = (last) => [
	'export const meta = { name: "edit resume", description: "Three agents, the last one edited" };',
	`const a = await agent(${say("e1", [{ id: "b", tool: "bash", args: { command: "sleep 2" } }, { id: "c", text: "e1 out" }])}, { label: "e1" });`,
	`const b = await agent(${say("e2")}, { label: "e2" });`,
	`return [a, b, await agent(${say(last)}, { label: "last" })];`,
].join("\n");

// Edit the last prompt in the persisted script, then resume the run: the unchanged prefix replays from the journal.
export default {
	name: "wf-edit-resume",
	gate: "M3",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Workflow", args: { script: source("e3") } },
			{ id: "s2", text: "launched" },
			{ id: "s3", on: "<status>completed</status>", tool: "Workflow", args: { scriptPath: "$/\\/[^\\s'\"]*\\/scripts\\/[^\\s'\"]+\\.js/", resumeFromRunId: "$/wf_[0-9a-f]{8}-[0-9a-f]{3}/" } },
			{ id: "s4", text: "resumed" },
		] });
		await lead.until((_, events) => launches(events).length >= 1, 30_000, "the first launch");
		const [first] = launches(lead.events);
		writeFileSync(first.scriptPath, source("e3b"));
		await lead.until((_, events) => taskNotifications(events).length >= 2, 60_000, "both notifications");
		const resume = toolCalls(lead.events).filter((c) => c.name === "Workflow")[1];
		assert.equal(resume.isError, false, resume.text);
		const second = resume.details;
		assert.deepEqual([second.runId, second.scriptPath, second.transcriptDir], [first.runId, first.scriptPath, first.transcriptDir]);
		const notes = taskNotifications(lead.events);
		assert.deepEqual(notes.map((n) => n.status), ["completed", "completed"]);
		assert.deepEqual(JSON.parse(notes[1].result), [out("e1"), out("e2"), out("e3b")]);
		const asked = requests(t).filter((r) => r.agent !== "lead").map((r) => `${r.agent}:${r.step}`);
		assert.deepEqual(asked.sort(), ["e1:b", "e1:c", "e2:c", "e3:c", "e3b:c"], "a request repeated");
		const cached = progressEvents(first).filter((e) => e.type === "workflow_agent" && e.cached).map((e) => e.label);
		assert.deepEqual(cached, ["e1", "e2"]);
	},
};
