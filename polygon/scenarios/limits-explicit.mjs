import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

// No limit fields: none shown. Set limits: shown. A run stopped by its limit with no output is failed.
export default {
	name: "limits-explicit",
	gate: "M1",
	async run(t) {
		const free = { agent: "free", steps: [{ id: "f1", text: "free done" }] };
		const limited = { agent: "limited", steps: [{ id: "l1", tool: "bash", args: { command: "true" } }, { id: "l2", tool: "bash", args: { command: "true" } }, { id: "l3", text: "never" }] };
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "free", prompt: script(free) } },
			{ id: "s2", tool: "Agent", args: { description: "limited", prompt: script(limited), maxTurns: 1 } },
			{ id: "s3", text: "launched" },
		] });
		await lead.until((_, events) => taskNotifications(events).length >= 2, 30_000, "both reports");
		const launches = toolCalls(lead.events);
		assert.deepEqual(launches.map((c) => [c.name, c.isError]), [["Agent", false], ["Agent", false]]);
		const launch = (id) => launches.find((c) => c.id === id).text;
		assert.doesNotMatch(launch("s1"), /^Limits:/m);
		assert.match(launch("s2"), /^Limits: maxTurns 1$/m);
		const [free1, limited1] = ["s1", "s2"].map((id) => taskNotifications(lead.events).find((n) => n.toolUseId === id));
		assert.equal(free1.status, "completed");
		assert.equal(free1.limited, undefined);
		assert.equal(limited1.status, "failed");
		assert.ok(limited1.limited, "the limited report does not say which limit stopped it");
	},
};
