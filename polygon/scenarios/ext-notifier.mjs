import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";

export default {
	name: "ext-notifier",
	gate: "M0",
	async run(t) {
		const bin = join(t.home, "bin");
		const log = join(t.dir, "notified.log");
		mkdirSync(bin);
		writeFileSync(join(bin, "polygon-notify"), `#!/bin/sh\necho "$1" >> ${log}\n`);
		chmodSync(join(bin, "polygon-notify"), 0o755);
		t.env.PATH = `${bin}:${t.env.PATH}`;
		mkdirSync(join(t.repo, ".pi"));
		writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ notifier: { terminal: false, command: ["polygon-notify", "{project}"] } }));

		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", text: "done" }] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the turn to settle");
		for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 100));
		await new Promise((r) => setTimeout(r, 500));
		assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), ["repo"]);
	},
};
