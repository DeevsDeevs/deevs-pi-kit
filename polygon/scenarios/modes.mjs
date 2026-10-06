import assert from "node:assert/strict";
import { pi, rpc } from "../drive.mjs";

// One command per kept extension; the kit loads from settings.json `packages`, as installed.
const EXPECTED = ["agents", "arxiv:search", "chains", "codex-fast", "cron", "jobs", "notifier:settings", "runtime", "todos", "wiki:search"];

export default {
	name: "modes",
	gate: "M0",
	async run(t) {
		const { data } = await rpc(t).send({ type: "get_commands" });
		const names = new Set(data.commands.map((c) => c.name));
		assert.deepEqual(EXPECTED.filter((name) => !names.has(name)), [], "commands missing from get_commands");

		const print = await pi(t, ["--print", "--no-session", "/jobs"]);
		assert.equal(print.status, 0, print.stderr);
		assert.notEqual(`${print.stdout}${print.stderr}`.trim(), "", "print mode was silent");

		const json = await pi(t, ["--mode", "json", "--print", "--no-session", "/jobs"]);
		assert.equal(json.status, 0, json.stderr);
		assert.ok(json.events.some((e) => e.type === "extension_output"), "json mode emitted no extension_output");
	},
};
