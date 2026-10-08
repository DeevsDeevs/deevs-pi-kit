import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rpc, script } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";
import { ALLOWED, BLOCKED } from "./guard-claude.mjs";

const bash = (prefix) => [...BLOCKED, ALLOWED, "sleep 60"].map((command, i) => ({ id: `${prefix}${i}`, tool: "bash", args: { command } }));
const ERRORS = [true, true, true, false, true];

// The guard refuses detached processes, force pushes to main and rm -rf outside the cwd, in the lead and in an agent,
// and a foreground sleep of a minute.
export default {
	name: "guard-pi",
	gate: ["M0", "M1"],
	async run(t) {
		const child = { agent: "child", steps: [...bash("g"), { id: "c1", text: "guarded" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			...bash("b"),
			{ id: "s1", tool: "Agent", args: { description: "guarded", prompt: script(child) } },
			{ id: "s2", text: "launched" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the agent's report");
		const calls = toolCalls(lead.events).filter((c) => c.name === "bash");
		assert.deepEqual(calls.map((c) => c.isError), ERRORS);
		assert.match(calls[4].text, /^A foreground sleep of 60 s or more is blocked/);
		const log = readFileSync(toolCalls(lead.events).find((c) => c.name === "Agent").details.outputFile, "utf8");
		assert.deepEqual(log.split("\n").filter((line) => line.startsWith("← ")).map((line) => line.startsWith("← error")), ERRORS);
	},
};
