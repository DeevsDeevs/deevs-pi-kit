import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { herdr } from "../drive.mjs";

// Interactive Pi in a Herdr pane: herdr-compat only acts in the TUI with HERDR_ENV=1. A cold TUI start can take over
// 10 s, so the wait allows 20.
// ponytail: asserts the load only. Shift+Enter gives a newline with or without the extension here, so its mapping has no
// request-log check; send-text then send-keys enter does submit (collab-user-types proves it through the request log).
export default {
	name: "ext-herdr-compat",
	gate: "M0",
	timing: true,
	async run(t) {
		const { cli } = await herdr(t);
		const pane = "w1:p1";
		await cli("pane", "run", pane, "pi --model polygon/puppet");
		await cli("pane", "wait-output", pane, "--match", "herdr-compat", "--source", "visible", "--timeout", "20000");

		const [tui] = (await cli("pane", "process-info", "--pane", pane)).process_info.foreground_processes;
		assert.equal(tui?.name, "pi", "no interactive pi in the pane's foreground");
		assert.ok(readFileSync(`/proc/${tui.pid}/environ`, "utf8").split("\0").includes("HERDR_ENV=1"), "the pane's pi lacks HERDR_ENV=1");
		await cli("pane", "send-keys", pane, "ctrl+d");
	},
};
