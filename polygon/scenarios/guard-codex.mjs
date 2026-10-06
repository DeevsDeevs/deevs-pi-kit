import { guardThroughCli } from "./guard-claude.mjs";

// Codex runs the kit's guard as a PreToolUse hook passed with -c, trusted for the run by --dangerously-bypass-hook-trust.
export default {
	name: "guard-codex",
	gate: "M4",
	timeoutMs: 120_000,
	run: (t) => guardThroughCli(t, { model: "codex:puppet", tool: "exec_command", arg: "cmd" }),
};
