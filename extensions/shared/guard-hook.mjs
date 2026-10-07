// Claude Code / Codex PreToolUse hook: reads the hook payload on stdin and denies a shell command the kit guard refuses.
// It fails closed: any error (a payload it cannot read, a Node without module hooks or type stripping) blocks the call with exit 2.
import { readFileSync } from "node:fs";
import module from "node:module";

try {
	// Standalone Node has only the production `runtime-typebox` alias, like the Runtime daemon.
	module.registerHooks({
		resolve(specifier, context, nextResolve) {
			return nextResolve(specifier.replace(/^typebox(?=\/|$)/, "runtime-typebox"), context);
		},
	});
	const { guardHookPayload } = await import("./guard.ts");
	const reason = guardHookPayload(readFileSync(0, "utf8"));
	if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
} catch (error) {
	process.stderr.write(`pi-kit guard could not check this call, so it is blocked: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
}
