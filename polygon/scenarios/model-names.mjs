import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureModels, rpc, script } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

const agent = (id, name, model, on) => ({ id, on, tool: "Agent", args: { description: `model ${name}`, prompt: script({ agent: name, steps: [{ id: "c1", text: "ran" }] }), model, run_in_background: false } });

export default {
	name: "model-names",
	gate: "M1",
	timeoutMs: 150_000,
	async run(t) {
		fixtureModels(t, "polygon", ["gpt-6-sol", "gpt-6.2-sol", "gpt-6.10-sol", "gpt-6-astra", "gpt-6-astra-20260901", "gpt-6-luna"]);
		writeFileSync(join(t.agentDir, "pi-kit.json"), JSON.stringify({ models: { sol: "polygon/gpt-*-sol", astra: "polygon/gpt-*-astra" } }));
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			agent("s1", "sol1", "sol"), agent("s2", "astra", "astra"), agent("s3", "luna", "gpt-6-luna"), agent("s4", "opus", "opus"),
			agent("s5", "nope", "gpt-9-nope"), agent("s6", "sool", "sool"),
			{ id: "s7", text: "first round" },
			agent("s8", "sol2", "sol", "polygon-edited"),
		] });
		await lead.until((e) => e.type === "agent_settled", 140_000, "the first round to settle");
		mkdirSync(join(t.repo, ".pi"), { recursive: true });
		writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ models: { sol: "polygon/gpt-6-sol" } }));
		await lead.prompt("polygon-edited");
		await lead.until((_, events) => toolCalls(events).length >= 7, 30_000, "the call after the edit");

		const first = (name) => requests(t).find((r) => r.agent === name);
		assert.equal(first("sol1")?.model, "gpt-6.10-sol", "sol is not the newest polygon/gpt-*-sol");
		assert.equal(first("astra")?.model, "gpt-6-astra", "astra did not prefer the undated id");
		assert.equal(first("luna")?.model, "gpt-6-luna", "a unique bare id did not resolve");
		assert.equal(first("opus")?.wire, "anthropic", "opus did not reach the Anthropic wire");
		assert.equal(first("sol2")?.model, "gpt-6-sol", "the .pi/pi-kit.json edit did not apply to the next call");
		for (const [name, call] of [["nope", toolCalls(lead.events)[4]], ["sool", toolCalls(lead.events)[5]]]) {
			assert.equal(call.isError, true, `${name} did not fail`);
			assert.ok(!first(name), `${name} started an agent before failing`);
			assert.ok(call.text.includes("astra") && call.text.includes("polygon/gpt-6-luna"), `${name}'s error lists no names or models`);
		}
	},
};
