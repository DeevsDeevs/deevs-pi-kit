import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureModels, rpc } from "../drive.mjs";
import { requests } from "../look.mjs";

/** One lead, one scripted turn; returns the model it ran and Pi's state after it. */
async function turn(t, opts) {
	const lead = rpc(t, opts);
	await lead.script({ agent: "lead", steps: [{ id: "s1", text: "hi" }] });
	await lead.until((e) => e.type === "agent_settled", 30_000, "the turn to settle");
	const { data } = await lead.send({ type: "get_state" });
	await lead.close();
	return { ran: requests(t).at(-1).model, model: data.model?.id, level: data.thinkingLevel };
}

export default {
	name: "model-lead-latest",
	gate: "M1",
	pending: "step 1.2 resolves a new session's lead model through resolveLead",
	async run(t) {
		fixtureModels(t, "polygon", ["gpt-6-sol", "gpt-6.2-sol", "gpt-6.10-sol"]);
		const settings = join(t.agentDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), defaultThinkingLevel: "high" }));
		const kit = (config) => writeFileSync(join(t.agentDir, "pi-kit.json"), JSON.stringify({ models: { sol: "polygon/gpt-*-sol" }, ...config }));
		kit({});
		assert.deepEqual(await turn(t, { model: null }), { ran: "gpt-6.10-sol", model: "gpt-6.10-sol", level: "high" }, "a new session did not switch to the newest sol at the settings level");
		assert.equal((await turn(t, {})).ran, "puppet", "--model was overridden");
		assert.equal((await turn(t, { model: null, args: ["--continue"] })).ran, "puppet", "a restored session was switched");
		kit({ lead: null });
		assert.equal((await turn(t, { model: null })).ran, "puppet", "lead:null still switched the model");
	},
};
