import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc } from "../drive.mjs";
import { requests } from "../look.mjs";

// Pi's built-in openai-codex provider, repointed at the puppet with a fake ChatGPT login, so codex-fast sees an eligible model.
function codexLogin(t) {
	const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "polygon" } })).toString("base64url");
	const access = `e30.${claims}.polygon`;
	writeFileSync(join(t.agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "polygon", expires: Date.now() + 86_400_000, accountId: "polygon" } }));
	const models = JSON.parse(readFileSync(join(t.agentDir, "models.json"), "utf8"));
	models.providers["openai-codex"] = { baseUrl: `http://127.0.0.1:${t.port}` };
	writeFileSync(join(t.agentDir, "models.json"), JSON.stringify(models));
	const settings = JSON.parse(readFileSync(join(t.agentDir, "settings.json"), "utf8"));
	writeFileSync(join(t.agentDir, "settings.json"), JSON.stringify({ ...settings, transport: "sse" }));
}

const setFast = (t, on) => writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ codexFast: on }));

export default {
	name: "ext-codex-fast",
	gate: "M0",
	async run(t) {
		codexLogin(t);
		mkdirSync(join(t.repo, ".pi"));
		setFast(t, true);
		const lead = rpc(t);
		await lead.send({ type: "set_model", provider: "openai-codex", modelId: "gpt-5.5" });
		await lead.script({ agent: "lead", steps: [{ id: "s1", text: "fast" }, { id: "s2", on: "again", text: "slow" }] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the fast turn to settle");
		setFast(t, false);
		await lead.prompt("again");
		await lead.until((_, events) => events.filter((e) => e.type === "agent_settled").length >= 2, 30_000, "the second turn to settle");
		const codex = requests(t).filter((r) => r.url.includes("/codex/responses"));
		assert.deepEqual(codex.map((r) => [r.step, r.tier]), [["s1", "priority"], ["s2", null]]);
	},
};
