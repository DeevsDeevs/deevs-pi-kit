import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, sleep } from "../drive.mjs";
import { poll, sessionNotes, toolCalls } from "../look.mjs";

// A folder watch, an `until` script and a one-shot timer, all due while Pi is closed: each catches up exactly once on
// reopen; a /reload afterwards loses and repeats nothing.
export default {
	name: "monitor-restart",
	gate: "M5",
	slow: true,
	timeoutMs: 180_000,
	async run(t) {
		const dir = join(t.repo, "watched");
		const condition = join(t.repo, "condition");
		mkdirSync(dir);
		// The timer must come due after the kill below.
		if (new Date().getSeconds() > 40) await sleep((62 - new Date().getSeconds()) * 1_000);
		const lead = rpc(t, { args: ["-e", "/polygon/fixtures/polygon-reload.ts"] });
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Monitor", args: { path: "watched", every: 1, description: "restart folder" } },
			{ id: "s2", tool: "Monitor", args: { command: `until [ -e ${condition} ]; do sleep 0.2; done; echo condition-met`, description: "until condition" } },
			{ id: "s3", tool: "Monitor", args: { cron: "* * * * *", prompt: "polygon-cron-restart", once: true, description: "restart timer" } },
			{ id: "s4", text: "armed" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		const [folder, until, timer] = toolCalls(lead.events).map((c) => c.details.taskId);
		await lead.kill9();
		writeFileSync(join(dir, "one.txt"), "1\n");
		writeFileSync(join(dir, "two.txt"), "2\n");
		writeFileSync(condition, "");
		await sleep(Math.ceil(Date.now() / 60_000) * 60_000 - Date.now() + 2_000);
		await lead.restart();

		const of = (id) => sessionNotes(t).filter((n) => n.taskId === id);
		await poll(() => of(folder).length && of(until).length && of(timer).length, 30_000, "all three catch-up events");
		await sleep(2_000);
		assert.equal(of(folder).length, 1);
		assert.deepEqual(of(folder)[0].event.split("\n").sort(), ["added one.txt", "added two.txt"]);
		assert.ok(of(folder)[0].caughtUp, "the folder's catch-up event is not marked caught_up");
		assert.equal(of(until).length, 1);
		assert.match(of(until)[0].event, /condition-met/);
		assert.deepEqual(of(timer).map((n) => n.event), ["polygon-cron-restart"]);

		await lead.prompt("/polygon-reload");
		writeFileSync(join(dir, "three.txt"), "3\n");
		await poll(() => of(folder).length >= 2, 15_000, "the folder's event after the reload");
		await sleep(2_500);
		assert.deepEqual(of(folder).slice(1).map((n) => [n.event, n.caughtUp]), [["added three.txt", undefined]], "the reload repeated or lost a folder event");
		assert.equal(new Set(sessionNotes(t).map((n) => n.notificationId)).size, sessionNotes(t).length, "a notification reached the session twice");
	},
};
