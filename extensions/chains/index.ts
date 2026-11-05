import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Where `npx skills add DeevsDeevs/agent-system` puts the chains skill.
const SCRIPTS = [".agents/skills/chains/chain.mjs", ".claude/skills/chains/chain.mjs"];

/** The chains skill's startup digest (`list --max 5`) for `cwd`; empty when there is none or the script fails. */
export function chainsBrief(cwd: string): string {
	const script = SCRIPTS.map((path) => join(homedir(), path)).find((path) => existsSync(path));
	if (!script) return "";
	try {
		const out = execFileSync("node", [script, "list", "--max", "5"], { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		// An older chain.mjs prints its own list format, or "no chains in …", which isn't a digest.
		return out.startsWith("Chains") ? out : "";
	} catch {
		return "";
	}
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
}
