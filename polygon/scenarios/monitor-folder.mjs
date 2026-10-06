import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, sleep } from "../drive.mjs";
import { requests, taskNotifications, toolCalls } from "../look.mjs";

// Three creates, an edit and a delete each land in exactly one event; a quiet folder costs nothing.
export default {
	name: "monitor-folder",
	gate: "M5",
	async run(t) {
		const dir = join(t.repo, "watched");
		mkdirSync(dir);
		writeFileSync(join(dir, "seed.txt"), "seed\n");
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Monitor", args: { path: "watched", every: 1, description: "fixture folder" } },
			{ id: "s2", text: "watching" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launch turn to settle");
		const [monitor] = toolCalls(lead.events);
		assert.equal(monitor.isError, false);
		assert.equal(monitor.details.baseline, "1 files");

		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			writeFileSync(join(dir, name), `${name}\n`);
			await sleep(1_500);
		}
		appendFileSync(join(dir, "a.txt"), "edited\n");
		await sleep(1_500);
		rmSync(join(dir, "b.txt"));
		const lines = () => taskNotifications(lead.events).filter((n) => n.taskId === monitor.details.taskId).flatMap((n) => n.event.split("\n"));
		await lead.until(() => lines().includes("removed b.txt"), 15_000, "the delete's event");
		await sleep(3_000);
		assert.deepEqual(lines().sort(), ["added a.txt", "added b.txt", "added c.txt", "changed a.txt", "removed b.txt"]);

		const asked = requests(t).length;
		const seen = taskNotifications(lead.events).length;
		await sleep(5_000);
		assert.equal(taskNotifications(lead.events).length, seen, "a quiet folder produced an event");
		assert.equal(requests(t).length, asked, "a quiet folder cost a lead request");
	},
};
