import assert from "node:assert/strict";
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { eventually, exec, rpc, script, sleep } from "../drive.mjs";
import { procs, requests, sessionNotes, toolCalls } from "../look.mjs";

// kill -9 mid-bash, then mid-grep: bash is reported interrupted, the replay-safe grep runs again, one report lands.
// grep blocks reading a fifo the scenario holds open read-write, so no ripgrep ever waits in open(): a plain writer could feed
// the orphaned ripgrep while the re-run was spawned but not yet opening, and leave the re-run blocked for good.
const holds = (pid, path) => {
	try { return readdirSync(`/proc/${pid}/fd`).some((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`) === path); } catch { return false; }
};
export default {
	name: "durable-kill9-tool",
	gate: "M1",
	timeoutMs: 120_000,
	async run(t) {
		const marker = join(t.repo, "bash-started");
		const fifo = join(t.repo, "fifo");
		await exec(t, "mkfifo", [fifo]);
		let writer = openSync(fifo, constants.O_RDWR);
		const release = () => {
			if (writer !== undefined) closeSync(writer);
			writer = undefined;
		};
		t.closers.push(async () => release());
		const child = { agent: "child", steps: [
			{ id: "b1", tool: "bash", args: { command: `touch ${marker}; sleep 30; echo slept` } },
			{ id: "r1", tool: "grep", args: { pattern: "fifo-data", path: fifo } },
			{ id: "c1", text: "child done" },
		] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "survivor", prompt: script(child) } },
			{ id: "s2", text: "launched" },
		] });
		await eventually(() => existsSync(marker), 30_000, "the agent's bash to start");
		await lead.restart();
		await eventually(() => requests(t).some((r) => r.agent === "child" && r.step === "r1"), 30_000, "the agent to call grep after the interrupted bash");
		await sleep(1_000);
		await lead.restart();
		await eventually(() => procs(t).filter((p) => p.argv[0] === "rg" && holds(p.pid, fifo)).length >= 2, 30_000, "the re-run grep and the orphaned one to open the fifo");
		writeSync(writer, "fifo-data\n");
		release();
		await eventually(() => sessionNotes(t).length > 0, 45_000, "the agent's report in the session");
		await sleep(1_000);
		assert.equal(sessionNotes(t).length, 1, "the report landed more than once");
		const log = readFileSync(toolCalls(lead.events).find((c) => c.name === "Agent").details.outputFile, "utf8");
		assert.match(log, /→ bash .*\n← error [^\n]*\n\[error\] Tool bash was interrupted/, "bash was not reported interrupted");
		assert.match(log, /→ grep .*\n← (?!error)/, "grep did not re-run to a result");
		assert.equal(requests(t).filter((r) => r.agent === "child" && r.step === "c1").length, 1);
	},
};
