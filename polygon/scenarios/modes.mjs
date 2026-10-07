import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pi, rpc, script } from "../drive.mjs";
import { requests } from "../look.mjs";

// The kit registers exactly two commands; it loads from settings.json `packages`, as installed.
const EXPECTED = ["agents", "chains"];
const UI_ONLY = ["ask_user", "collaborator_start", "collaborator_workspace"];

export default {
	name: "modes",
	gate: "M0",
	async run(t) {
		const legacy = join(t.repo, ".pi", "codex-fast.json");
		mkdirSync(join(t.repo, ".pi"));
		writeFileSync(legacy, JSON.stringify({ enabled: true }));

		const { data } = await rpc(t).send({ type: "get_commands" });
		const names = data.commands.filter((c) => c.source === "extension" && c.sourceInfo?.source === "/kit").map((c) => c.name).sort();
		assert.deepEqual(names, EXPECTED, "the kit's extension commands");
		assert.equal(existsSync(legacy), false, "the legacy .pi/codex-fast.json is migrated away");
		assert.deepEqual(JSON.parse(readFileSync(join(t.repo, ".pi", "pi-kit.json"), "utf8")), { codexFast: true });

		const print = await pi(t, ["--print", "--no-session", "/chains"]);
		assert.equal(print.status, 0, print.stderr);
		assert.notEqual(`${print.stdout}${print.stderr}`.trim(), "", "print mode was silent");

		const json = await pi(t, ["--mode", "json", "--print", "--no-session", "/chains"]);
		assert.equal(json.status, 0, json.stderr);
		assert.ok(json.events.some((e) => e.type === "extension_output"), "json mode emitted no extension_output");

		// Nobody will reply in print or json mode: the tools that need a person or Herdr's UI are not offered.
		for (const mode of [["--print"], ["--mode", "json", "--print"]]) {
			const run = await pi(t, [...mode, "--no-session", "--model", "polygon/puppet", script({ agent: "lead", steps: [{ id: "x1", text: "ok" }] })]);
			assert.equal(run.status, 0, run.stderr);
		}
		const offered = requests(t).map((r) => r.tools);
		assert.equal(offered.length, 2);
		for (const tools of offered) {
			assert.ok(tools.includes("Agent"), "the kit's tools were not offered");
			assert.deepEqual(tools.filter((name) => UI_ONLY.includes(name)), [], "a UI-only tool was offered in print or json mode");
		}
	},
};
