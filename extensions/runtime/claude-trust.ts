import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { strictObject, type SerializedObject } from "./responses.ts";

/** Claude Code refuses to start in an untrusted directory; this accepts that one dialog for one exact cwd. */
export function markClaudeWorkspaceTrusted(cwd: string, configPath = join(homedir(), ".claude.json")): void {
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	const config = readClaudeConfig(configPath);
	const projects = config.projects === undefined ? {} : strictObject(config.projects, "Claude workspace trust projects");
	const existing = projects[cwd] === undefined ? undefined : strictObject(projects[cwd], "Claude workspace trust entry");
	if (existing?.hasTrustDialogAccepted === true) return;
	const next = { ...config, projects: { ...projects, [cwd]: { ...existing, hasTrustDialogAccepted: true } } };
	const temporary = `${configPath}.pi-kit.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, configPath);
}

function readClaudeConfig(configPath: string): SerializedObject {
	if (!existsSync(configPath)) return {};
	return strictObject(JSON.parse(readFileSync(configPath, "utf8")), "Claude workspace trust store");
}
