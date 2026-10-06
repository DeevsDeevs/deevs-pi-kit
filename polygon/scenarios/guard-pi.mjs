import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rpc } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

const BLOCKED = ["nohup sleep 1 &", "git push --force origin main", "rm -rf ~/x"];
const ALLOWED = "rm -rf /tmp/polygon-guard-x";
const bash = (prefix) => [...BLOCKED, ALLOWED].map((command, i) => ({ id: `${prefix}${i}`, tool: "bash", args: { command } }));

// The guard refuses detached processes, force pushes to main and rm -rf outside the cwd, in the lead and in an agent.
export default {
	name: "guard-pi",
	gate: ["M0", "M1"],
	async run(t) {
		const child = { agent: "child", steps: [...bash("g"), { id: "c1", text: "guarded" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			...bash("b"),
			{ id: "s1", tool: "Agent", args: { description: "guarded", prompt: `POLYGON ${JSON.stringify(child)}` } },
			{ id: "s2", text: "launched" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 1, 30_000, "the agent's report");
		assert.deepEqual(toolCalls(lead.events).filter((c) => c.name === "bash").map((c) => c.isError), [true, true, true, false]);
		const outputFile = toolCalls(lead.events).find((c) => c.name === "Agent").details.outputFile;
		const results = readFileSync(outputFile, "utf8").split("\n").filter((line) => line.startsWith("← "));
		assert.deepEqual(results.map((line) => line.startsWith("← error")), [true, true, true, false]);
	},
};
