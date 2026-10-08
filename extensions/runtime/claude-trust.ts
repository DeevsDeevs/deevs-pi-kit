import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { isNodeError } from "./errors.ts";

const CLAUDE_CONFIG = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
const ClaudeProjects = Type.Record(Type.String(), Type.Object({ hasTrustDialogAccepted: Type.Optional(Type.Boolean()) }));
const ClaudeConfig = Type.Object({ projects: Type.Optional(ClaudeProjects), bypassPermissionsModeAccepted: Type.Optional(Type.Boolean()) });

/**
 * Pre-seeds Claude Code's one-time prompts for a collaborator launch: the bypass-permissions acceptance, and folder trust
 * for a cwd it has not seen (a worktree is new every time), inherited from its repository. An untrusted repository is
 * left for Claude to ask about. This is the user's own Claude config: a file that cannot be read or parsed is left alone.
 */
export function seedClaude(cwd: string, repoRoot: string, configPath = CLAUDE_CONFIG): void {
	const target = existsSync(configPath) ? realpathSync(configPath) : configPath;
	// Running Claude Code instances rewrite this file too: a change replaces only the text it was computed from.
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = readConfig(target);
		const next = before === undefined ? undefined : seeded(before, cwd, repoRoot);
		if (next === undefined) return;
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		const temporary = `${target}.pi-kit.${process.pid}.tmp`;
		writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
		if (readConfig(target) === before) return renameSync(temporary, target);
		rmSync(temporary, { force: true });
	}
}

/** The config text, "" when there is none yet, undefined when it cannot be read. */
function readConfig(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		return isNodeError(error) && error.code === "ENOENT" ? "" : undefined;
	}
}

/** The seeded config text, or undefined when nothing changes or the text is not a config this may rewrite. */
function seeded(text: string, cwd: string, repoRoot: string): string | undefined {
	let config;
	try { config = text === "" ? {} : JSON.parse(text); } catch { return undefined; }
	if (!Value.Check(ClaudeConfig, config)) return undefined;
	const projects = config.projects ?? {};
	const seedTrust = projects[repoRoot]?.hasTrustDialogAccepted === true && projects[cwd]?.hasTrustDialogAccepted !== true;
	if (config.bypassPermissionsModeAccepted === true && !seedTrust) return undefined;
	const next = { ...config, bypassPermissionsModeAccepted: true };
	if (seedTrust) next.projects = { ...projects, [cwd]: { ...projects[cwd], hasTrustDialogAccepted: true } };
	return `${JSON.stringify(next, null, 2)}\n`;
}
