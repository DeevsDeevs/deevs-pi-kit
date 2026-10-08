import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, rpc, sleep } from "../drive.mjs";
import { dialogs, missionStates, notifications, runs, toolCalls } from "../look.mjs";

// kill -9 mid-turn, so no settle ran; reopening the session takes the dead owner's lock and continues unprompted.
export default {
	name: "mission-restart",
	gate: "M5",
	live: true,
	async run(t) {
		const started = join(t.dir, "bash-started");
		const release = join(t.dir, "bash-release");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "mission_start", args: { title: "restart probe", goal: "Survive a crash.", done: "A continue arrived after the restart." } },
			{ id: "s2", tool: "bash", args: { command: `touch ${started}; while [ ! -e ${release} ]; do sleep 0.2; done` } },
			{ id: "s3", on: "Mission continue", tool: "mission_update", args: { log: "Continued after the restart.", next: "none", status: "done" } },
			{ id: "s4", text: "closed" },
		] });
		await eventually(() => existsSync(started), 30_000, "the lead's bash to start");
		const [before] = missionStates(t);
		await lead.restart();
		writeFileSync(release, "");
		await lead.until((e) => e.type === "tool_execution_end" && e.toolName === "mission_update", 30_000, "the continued run's mission_update");
		await lead.until((e) => e.type === "agent_settled", 30_000, "the continued run to settle");
		await sleep(1_500);
		const [after] = missionStates(t);
		assert.equal(notifications(lead.events).filter((n) => n.customType === "mission-continue").length, 1);
		assert.equal(runs(lead.events), 2, "one prompted run before the kill, one continued run after");
		assert.equal(dialogs(lead.events), 0);
		assert.equal(toolCalls(lead.events).find((c) => c.name === "mission_update")?.isError, false);
		assert.equal(after.status, "done");
		assert.notEqual(after.owner.pid, before.owner.pid, "the reopened lead did not take the dead owner's lock");
	},
};
