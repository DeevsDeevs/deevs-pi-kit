import assert from "node:assert/strict";
import { fixtureModels, herdr, rpc, sleep } from "../drive.mjs";
import { missionStates, notifications, toolCalls } from "../look.mjs";

// A collaborator's roster row stays running while its tab lives; it wakes the lead by mail, so an idle one must not
// hold the Mission's continue.
export default {
	name: "mission-collab",
	gate: "M5",
	timeoutMs: 180_000,
	async run(t) {
		await herdr(t);
		fixtureModels(t, "polygon", ["quiet"]);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_manage", args: { action: "start", participants: [{ participantId: "quiet", model: "polygon/quiet", profile: "read-only" }] } },
			{ id: "s2", tool: "mission_start", args: { title: "collab probe", goal: "Continue beside an idle collaborator.", done: "A continue arrived." } },
			{ id: "s3", tool: "ListAgents", args: {} },
			{ id: "s4", text: "started" },
			{ id: "s5", on: "Mission continue", tool: "mission_update", args: { log: "Continued.", next: "none", status: "done" } },
			{ id: "s6", text: "closed" },
		] });
		await lead.until((e) => e.type === "tool_execution_end" && e.toolName === "mission_update", 120_000, "the continue's mission_update");
		await lead.until((e, events) => e.type === "agent_settled" && events.indexOf(e) > events.findIndex((x) => x.type === "tool_execution_end" && x.toolName === "mission_update"), 30_000, "the continued run to settle");
		await sleep(1_500);
		const list = toolCalls(lead.events).find((c) => c.name === "ListAgents");
		assert.match(list.text, /collaborator.*running|running.*collaborator/, `no running collaborator row: ${list.text}`);
		assert.ok(toolCalls(lead.events).every((c) => !c.isError), "a lead tool call failed");
		assert.equal(notifications(lead.events).filter((n) => n.customType === "mission-continue").length, 1);
		assert.deepEqual(missionStates(t).map((s) => s.status), ["done"]);
	},
};
