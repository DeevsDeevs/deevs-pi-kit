import assert from "node:assert/strict";
import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { exec, rpc } from "../drive.mjs";
import { taskNotifications } from "../look.mjs";

const child = `POLYGON ${JSON.stringify({ agent: "child", steps: [{ id: "c1", text: "loaded" }] })}`;
const launchMs = (events) => {
	const start = events.findLast((e) => e.type === "tool_execution_start" && e.toolName === "Agent");
	const end = events.findLast((e) => e.type === "tool_execution_end" && e.toolName === "Agent");
	return end.receivedAt - start.receivedAt;
};

// Durable loads from the kit's install inside Pi. The first Agent call of a fresh Pi (durable import, store open,
// launch) takes 300 ms or less in Pi's Bun release binary; Pi from npm (--pi-runtime node) runs on Node, where jiti caches nothing for it.
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
		// The engine opens bun:sqlite exactly when `"Bun" in globalThis`; ask the lead's own executable (Bun has no node:sqlite).
		const exe = readlinkSync(`/proc/${lead.pid}/exe`);
		const probe = await exec(t, exe, ["-e", "process.stdout.write(String('Bun' in globalThis))"], { env: { ...t.env, BUN_BE_BUN: "1" } });
		assert.equal(probe.stdout === "true" ? "bun" : "node", t.piRuntime, `the lead runs ${exe}`);
		const stores = readdirSync(join(t.agentDir, "pi-kit", "agents"), { recursive: true }).filter((f) => f.endsWith("engine.sqlite"));
		assert.equal(stores.length, 2, "one engine store per session");
		const warm = launchMs(lead.events);
		assert.ok(warm <= (t.piRuntime === "node" ? 600 : 300), `a warm Agent launch took ${warm} ms on ${t.piRuntime}`);
	},
};
