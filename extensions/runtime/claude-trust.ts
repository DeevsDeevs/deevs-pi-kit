import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

const CLAUDE_CONFIG = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
const ClaudeProjects = Type.Record(Type.String(), Type.Object({ hasTrustDialogAccepted: Type.Optional(Type.Boolean()) }));
const ClaudeConfig = Type.Object({ projects: Type.Optional(ClaudeProjects), bypassPermissionsModeAccepted: Type.Optional(Type.Boolean()) });

/**
 * Pre-seeds Claude Code's one-time prompts for a collaborator launch: the bypass-permissions acceptance, and folder trust
 * for a cwd it has not seen (a worktree is new every time), inherited from its repository. An untrusted repository is
 * left for Claude to ask about. Returns whether the cwd is trusted.
 */
export function seedClaude(cwd: string, repoRoot: string, configPath = CLAUDE_CONFIG): boolean {
	let config;
	try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { config = {}; }
	if (!Value.Check(ClaudeConfig, config)) return false;
	const projects = config.projects ?? {};
	const trusted = projects[cwd]?.hasTrustDialogAccepted === true || projects[repoRoot]?.hasTrustDialogAccepted === true;
	if (config.bypassPermissionsModeAccepted === true && (!trusted || projects[cwd]?.hasTrustDialogAccepted === true)) return trusted;
	const next = { ...config, bypassPermissionsModeAccepted: true, projects: trusted ? { ...projects, [cwd]: { ...projects[cwd], hasTrustDialogAccepted: true } } : projects };
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	const temporary = `${configPath}.pi-kit.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, configPath);
	return trusted;
}
