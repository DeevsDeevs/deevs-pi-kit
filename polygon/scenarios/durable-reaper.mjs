import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { poll } from "../look.mjs";

const owned = () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
	try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").some((v) => v.startsWith("PI_KIT_OWNER=")); } catch { return false; }
});

// A bash child orphaned by kill -9 carries PI_KIT_OWNER; the next start of its session reaps it before resuming.
export default {
	name: "durable-reaper",
	gate: "M1",
	async run(t) {
		const marker = join(t.repo, "bash-started");
		const child = { agent: "child", steps: [{ id: "b1", tool: "bash", args: { command: `touch ${marker}; sleep 300` } }, { id: "c1", text: "done" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [{ id: "s1", tool: "Agent", args: { description: "orphan maker", prompt: `POLYGON ${JSON.stringify(child)}` } }, { id: "s2", text: "launched" }] });
		await poll(() => existsSync(marker), 30_000, "the agent's bash to start");
		await lead.kill9();
		assert.ok(owned().length > 0, "kill -9 left no orphan to reap");
		await lead.restart();
		await poll(() => owned().length === 0, 15_000, "the reaper to kill every PI_KIT_OWNER process");
	},
};
