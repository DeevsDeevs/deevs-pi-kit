import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { requests, settled } from "../look.mjs";

// Pi's built-in openai-codex provider, repointed at the puppet with a fake ChatGPT OAuth token (sandbox.mjs), then Pi 1.0.4's openai.
const setFast = (t, on) => writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ codexFast: on }));
const edit = (t, file, change) => writeFileSync(join(t.agentDir, file), JSON.stringify(change(JSON.parse(readFileSync(join(t.agentDir, file), "utf8")))));

export default {
	name: "ext-codex-fast",
	gate: "M0",
	async run(t) {
		mkdirSync(join(t.repo, ".pi"));
		setFast(t, true);
		const lead = rpc(t, { model: "openai-codex/gpt-5.5" });
		await lead.script({ agent: "lead", steps: [{ id: "s1", text: "fast" }, { id: "s2", on: "again", text: "slow" }] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the fast turn to settle");
		setFast(t, false);
		await lead.prompt("again");
		await lead.until((_, events) => settled(events) >= 2, 30_000, "the second turn to settle");
		const codex = requests(t).filter((r) => r.url.endsWith("/codex/responses"));
		assert.deepEqual(codex.map((r) => [r.step, r.serviceTier]), [["s1", "priority"], ["s2", null]]);
		edit(t, "auth.json", (auth) => ({ ...auth, openai: { type: "oauth", access: "polygon", refresh: "polygon", expires: 4102444800000 } }));
		edit(t, "models.json", (models) => ({ providers: { ...models.providers, openai: { baseUrl: `http://127.0.0.1:${t.port}/v1` } } }));
		setFast(t, true);
		const chatgpt = rpc(t, { model: "openai/gpt-5.5" });
		await chatgpt.script({ agent: "lead", steps: [{ id: "s3", text: "fast" }] });
		await chatgpt.until((e) => e.type === "agent_settled", 30_000, "the openai turn to settle");
		assert.deepEqual(requests(t).filter((r) => r.url.endsWith("/v1/responses")).map((r) => [r.step, r.serviceTier]), [["s3", "priority"]]);
	},
};
