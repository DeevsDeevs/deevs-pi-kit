import assert from "node:assert/strict";
import { rpc } from "../drive.mjs";
import { notifications, requests, runs, toolCalls } from "../look.mjs";

const FIRE = "deevs.cron-fire.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A deleted every-minute task and a one-shot for the next minute: exactly one fire, then a quiet minute after it.
export default {
	name: "ext-cron",
	gate: ["M0", "M5"],
	slow: true,
	timeoutMs: 200_000,
	async run(t) {
		t.env.DEEVS_PI_CRON_NO_JITTER = "1";
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "cron", args: { action: "create", cron: "* * * * *", prompt: "polygon-cron-deleted", recurring: true } },
			{ id: "s2", tool: "cron", args: { action: "delete", id: "$/[0-9a-f]{8}(?=  )/" } },
			{ id: "s3", tool: "cron", args: { action: "create", cron: "* * * * *", prompt: "polygon-cron-fired", recurring: false } },
			{ id: "s4", text: "scheduled" },
			{ id: "s5", on: "polygon-cron-fired", text: "fired" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the scheduling turn to settle");
		await lead.until((e) => e.type === "message_end" && e.message?.customType === FIRE, 75_000, "the one-shot to fire");
		await sleep(Math.ceil(Date.now() / 60_000) * 60_000 - Date.now() + 5_000);

		const calls = toolCalls(lead.events);
		assert.deepEqual(calls.map((c) => [c.name, c.isError]), [["cron", false], ["cron", false], ["cron", false]]);
		const [deleted, , oneShot] = calls.map((c) => c.details);
		const fires = notifications(lead.events).filter((n) => n.customType === FIRE);
		assert.deepEqual(fires.map((n) => n.details.taskId), [oneShot.task.id], `the deleted task ${deleted.task.id} must never fire`);
		assert.equal(runs(lead.events), 2);
		assert.deepEqual(requests(t).filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3", "s4", "s5"]);
	},
};
