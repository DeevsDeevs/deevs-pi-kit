import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureModels, rpc, script } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

const agent = (id, name, model) => ({ id, tool: "Agent", args: { description: `codex ${name}`, prompt: script({ agent: name, steps: [{ id: "c1", text: "ran" }] }), model, run_in_background: false } });

export default {
	name: "model-codex",
	gate: "M1",
	timeoutMs: 150_000,
	async run(t) {
		// The lead runs openai-codex/gpt-6-sol on the puppet; Codex's cache lacks gpt-6.1-sol and its config.toml names it.
		fixtureModels(t, "openai-codex", ["gpt-6-sol"]);
		const codex = join(t.home, ".codex");
		writeFileSync(join(codex, "config.toml"), readFileSync(join(codex, "config.toml"), "utf8").replace('model = "puppet"', 'model = "gpt-6.1-sol"'));
		writeFileSync(join(codex, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-6-sol" }] }));
		const lead = rpc(t, { model: "openai-codex/gpt-6-sol" });
		await lead.script({ agent: "lead", steps: [agent("s1", "pinned", "codex:gpt-6.1-sol"), agent("s2", "glob", "codex:gpt-*-sol"), agent("s3", "bare", "codex:"), { id: "s4", text: "done" }] });
		await lead.until((e) => e.type === "agent_settled", 140_000, "the three Codex agents");
		assert.deepEqual(toolCalls(lead.events).map((c) => c.isError), [false, false, false]);
		const ran = (name) => requests(t).filter((r) => r.agent === name && r.wire === "responses").map((r) => r.model)[0];
		assert.equal(ran("pinned"), "gpt-6.1-sol", "a config.toml model missing from the cache was refused");
		assert.equal(ran("glob"), "gpt-6.1-sol", "codex:gpt-*-sol did not pick the newest sol");
		assert.equal(ran("bare"), "gpt-6-sol", "a bare codex: did not take the lead's id");
	},
};
