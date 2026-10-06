// Claude Code / Codex PreToolUse hook: reads the hook payload on stdin and denies a shell command the kit guard refuses.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Standalone Node has only the production `runtime-typebox` alias, like the Runtime daemon.
registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier.replace(/^typebox(?=\/|$)/, "runtime-typebox"), context);
	},
});

const { guardHookPayload } = await import("./guard.ts");
const reason = guardHookPayload(readFileSync(0, "utf8"));
if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
