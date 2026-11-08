import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Where `npx skills add DeevsDeevs/agent-system` puts the chains skill.
const SCRIPTS = [".agents/skills/chains/chain.mjs", ".claude/skills/chains/chain.mjs"];

function chain(cwd: string, args: string[]): string {
	const script = SCRIPTS.map((path) => join(homedir(), path)).find((path) => existsSync(path));
	if (!script) return "";
	try {
		return execFileSync("node", [script, ...args], { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** The chains skill's startup digest (`list --max 5`) for `cwd`; empty when there is none or the script fails. */
export function chainsBrief(cwd: string): string {
	const out = chain(cwd, ["list", "--max", "5"]);
	// An older chain.mjs prints its own list format, or "no chains in …", which isn't a digest.
	return out.startsWith("Chains") ? out : "";
}

/** The chains skill's once-per-session save reminder (`remind`) when it's due; empty otherwise. */
export function chainsReminder(cwd: string, session: string, startedMs: number): string {
	const out = chain(cwd, ["remind", "--session", session, ...(startedMs > 0 ? ["--since", String(startedMs)] : [])]);
	return out.startsWith("[chains reminder]") ? out : "";
}

export default function chainsExtension(pi: ExtensionAPI): void {
	let brief = "";
	pi.on("session_start", (_event, ctx) => {
		brief = chainsBrief(ctx.cwd);
	});
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (brief && !options.appendSystemPrompt.includes(brief)) options.appendSystemPrompt = [options.appendSystemPrompt, brief].filter(Boolean).join("\n\n");
	});
	// One more turn so the agent saves a link or says why not, at most once per session (chain.mjs keeps the state).
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed") return;
		const sessions = ctx.sessionManager;
		const text = chainsReminder(ctx.cwd, sessions.getSessionId(), Date.parse(sessions.getHeader()?.timestamp ?? ""));
		if (!text) return;
		return { entries: [...event.entries, { type: "custom_message", customType: "chains-reminder", content: text, display: true }], continue: true };
	});
}
