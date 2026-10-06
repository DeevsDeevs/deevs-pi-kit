// Claude Code / Codex PreToolUse hook: reads the hook payload on stdin and denies a shell command the kit guard refuses.
import { readFileSync } from "node:fs";
import { guardHookPayload } from "./guard.ts";

const reason = guardHookPayload(readFileSync(0, "utf8"));
if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
