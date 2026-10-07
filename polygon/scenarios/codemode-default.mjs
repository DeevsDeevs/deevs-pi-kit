import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pi, rpc, script } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

// The kit turns Pi's codemode on for every lead in mode on: the other tools stay declared and the working rules stay in the
// system prompt. "-codemode" in defaultTools and a --tools allowlist without it keep it off. A headless script runs bash.
const RULE = "Finish the task and verify it within your turn.";
const CODE = "const r = await tools.bash({ command: 'echo polygon-cm' }); return JSON.stringify({ exit: r.exit_code, out: r.output.trim() });";
const once = (agent) => script({ agent, steps: [{ id: "x1", text: "ok" }] });
const headless = (t, agent, extra = []) => pi(t, ["--print", "--mode", "json", "--no-session", "--model", "polygon/puppet", ...extra, once(agent)]);
const offered = (t, agent) => requests(t).filter((r) => r.agent === agent).map((r) => [r.tools.includes("codemode"), r.tools.includes("Agent"), r.marks]);

export default {
	name: "codemode-default",
	gate: "M0",
	async run(t) {
		t.marks.push(RULE);
		const lead = rpc(t);
		await lead.script({ agent: "rpc", steps: [{ id: "x1", text: "ok" }] });
		await lead.until((e) => e.type === "agent_settled");
		assert.deepEqual(offered(t, "rpc"), [[true, true, [RULE]]], "rpc lead: codemode, Agent and the working rules");

		for (const [agent, mode] of [["print", ["--print"]], ["json", ["--print", "--mode", "json"]]]) {
			const run = await pi(t, [...mode, "--no-session", "--model", "polygon/puppet", once(agent)]);
			assert.equal(run.status, 0, run.stderr);
			assert.deepEqual(offered(t, agent), [[true, true, [RULE]]], `${agent} lead: codemode, Agent and the working rules`);
		}

		const run = await pi(t, ["--print", "--mode", "json", "--no-session", "--model", "polygon/puppet", script({ agent: "script", steps: [{ id: "c1", tool: "codemode", args: { code: CODE } }, { id: "c2", text: "done" }] })]);
		assert.equal(run.status, 0, run.stderr);
		const call = toolCalls(run.events).find((c) => c.name === "codemode");
		assert.equal(call.isError, false, call.text);
		assert.match(call.text, /\{"exit":0,"out":"polygon-cm"\}/, "a headless script got bash's structured result");

		const settings = join(t.agentDir, "settings.json");
		const base = readFileSync(settings, "utf8");
		writeFileSync(settings, JSON.stringify({ ...JSON.parse(base), defaultTools: ["-codemode"] }));
		assert.equal((await headless(t, "off")).status, 0);
		writeFileSync(settings, base);
		assert.deepEqual(offered(t, "off"), [[false, true, [RULE]]], "\"-codemode\" in defaultTools left codemode on");

		assert.equal((await headless(t, "allowlist", ["--tools", "read,bash"])).status, 0);
		assert.deepEqual(requests(t).filter((r) => r.agent === "allowlist").map((r) => r.tools), [["read", "bash"]], "a --tools allowlist gained a tool");
	},
};
