import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";

const lines = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

export default {
	name: "ext-notifier",
	gate: "M0",
	async run(t) {
		const log = join(t.home, "notified.log");
		writeFileSync(join(t.home, "bin", "polygon-notify"), `#!/bin/sh\necho "$1" >> ${log}\n`, { mode: 0o755 });
		mkdirSync(join(t.repo, ".pi"));
		writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ notifier: { terminal: false, command: ["polygon-notify", "{project}"] } }));

		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "todo_list", args: { operation: "read" } },
			{ id: "s2", text: "done" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");
		// The command runs detached; give it a moment, then make sure a second one does not follow.
		for (let i = 0; i < 50 && !lines(log).length; i++) await new Promise((r) => setTimeout(r, 100));
		await new Promise((r) => setTimeout(r, 1_000));
		assert.deepEqual(lines(log), ["repo"], "one settled turn of two model turns runs the notifier command once");
	},
};
