import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, script } from "../drive.mjs";
import { poll, procs, requests } from "../look.mjs";
import { reports } from "./durable-kill9-tool.mjs";

const owned = (t) => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
	try {
		const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
		return env.includes(`POLYGON_RUN=${t.tag}`) && env.some((v) => v.startsWith("PI_KIT_OWNER="));
	} catch { return false; }
});

/** Interrupts a Claude worker mid-command; the next start resumes its session (the command is not run again) and it reports once. */
export async function interruptAndResume(t, interrupt) {
	const marker = join(t.repo, "cli-started");
	const child = { agent: "cw", steps: [{ id: "b1", tool: "Bash", args: { command: `touch ${marker}; sleep 300` } }, { id: "c1", text: "done" }] };
	const lead = rpc(t);
	await lead.script({ agent: "lead", steps: [
		{ id: "s1", tool: "Agent", args: { description: "cli survivor", prompt: script(child), model: "opus", subagent_type: "Explore" } },
		{ id: "s2", text: "launched" },
	] });
	await poll(() => existsSync(marker), 60_000, "the worker's command to start");
	await interrupt(lead);
	await lead.restart();
	await poll(() => reports(t).length > 0, 60_000, "the resumed worker's report");
	await new Promise((r) => setTimeout(r, 1_000));
	assert.equal(reports(t).length, 1, "the report landed more than once");
	assert.ok(!procs(t).some((p) => p.argv.includes("sleep")), "the interrupted command outlived the reaper");
	const cw = requests(t).filter((r) => r.agent === "cw");
	assert.deepEqual(cw.map((r) => r.step), ["b1", "c1"], "the worker started over instead of resuming");
	assert.ok(cw[1].messages > cw[0].messages, "the resumed run lost its session");
}

// kill -9: the worker's process group outlives Pi until the next start reaps it.
export default {
	name: "cli-kill9-resume",
	gate: "M4",
	timeoutMs: 120_000,
	run: (t) => interruptAndResume(t, async (lead) => {
		await lead.kill9();
		assert.ok(owned(t).length > 0, "kill -9 left no worker process to reap");
	}),
};
