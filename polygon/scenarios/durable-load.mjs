import assert from "node:assert/strict";
import { exec, rpc } from "../drive.mjs";
import { taskNotifications } from "../look.mjs";

const child = `POLYGON ${JSON.stringify({ agent: "child", steps: [{ id: "c1", text: "loaded" }] })}`;
const launchMs = (events) => {
	const start = events.findLast((e) => e.type === "tool_execution_start" && e.toolName === "Agent");
	const end = events.findLast((e) => e.type === "tool_execution_end" && e.toolName === "Agent");
	return end.receivedAt - start.receivedAt;
};

// Durable loads from the kit's install inside Pi. The first Agent call of a fresh Pi (durable import, store open,
// launch) takes 300 ms or less in Pi's Bun release binary; Pi from npm runs on Node, where jiti caches nothing for it.
export default {
	name: "durable-load",
	gate: "M1",
	async run(t) {
		const lead = rpc(t);
		for (const round of [1, 2]) {
			if (round === 2) await lead.restart([]);
			await lead.script({ agent: "lead", steps: [{ id: `s${round}`, tool: "Agent", args: { description: "load", prompt: child } }, { id: `t${round}`, text: "launched" }] });
			await lead.until((_, events) => taskNotifications(events).length >= round, 30_000, `the report of round ${round}`);
		}
		const warm = launchMs(lead.events);
		const onNode = (await exec(t, "sh", ["-c", "head -c 2 \"$(readlink -f \"$(command -v pi)\")\""])).stdout === "#!";
		assert.ok(warm <= (onNode ? 600 : 300), `a warm Agent launch took ${warm} ms on ${onNode ? "Node" : "Bun"}`);
	},
};
