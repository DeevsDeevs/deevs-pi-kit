import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const ClaudeProjects = Type.Record(Type.String(), Type.Object({ hasTrustDialogAccepted: Type.Optional(Type.Boolean()) }));
const ClaudeConfig = Type.Object({ projects: Type.Optional(ClaudeProjects) });

/**
 * Claude Code stops at a folder-trust dialog in any cwd it has not seen, and a collaborator worktree is a new cwd every time.
 * A worktree inherits the trust its repository already has; an untrusted repository is left for Claude to ask about.
 */
export function inheritClaudeTrust(cwd: string, repoRoot: string, configPath = CLAUDE_CONFIG): boolean {
	let config: unknown;
	try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { return false; }
	if (!Value.Check(ClaudeConfig, config)) return false;
	const projects = config.projects ?? {};
	if (projects[cwd]?.hasTrustDialogAccepted === true) return true;
	if (projects[repoRoot]?.hasTrustDialogAccepted !== true) return false;
	const next = { ...config, projects: { ...projects, [cwd]: { ...projects[cwd], hasTrustDialogAccepted: true } } };
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	const temporary = `${configPath}.pi-kit.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, configPath);
	return true;
}
