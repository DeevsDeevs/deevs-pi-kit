import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { requests } from "../look.mjs";

// Pi's built-in openai-codex provider, repointed at the puppet with a fake ChatGPT OAuth token (sandbox.mjs).
const MODEL = "openai-codex/gpt-5.5";

async function oneTurn(t) {
	const lead = rpc(t, { model: MODEL });
	await lead.script({ agent: "lead", steps: [{ id: "s1", text: "done" }] });
	await lead.until((e) => e.type === "agent_settled", 30_000, "agent_settled");
	await lead.close();
}

export default {
	name: "ext-codex-fast",
	gate: "M0",
	async run(t) {
		await oneTurn(t);
		// The legacy file: the controls step migrates it into pi-kit.json's codexFast, so this holds before and after.
		mkdirSync(join(t.repo, ".pi"));
		writeFileSync(join(t.repo, ".pi", "codex-fast.json"), JSON.stringify({ enabled: true }));
		await oneTurn(t);

		const codex = requests(t).filter((r) => r.url.endsWith("/codex/responses"));
		assert.deepEqual(codex.map((r) => [r.step, r.serviceTier]), [["s1", null], ["s1", "priority"]]);
	},
};
