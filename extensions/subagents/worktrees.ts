import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentsSettings } from "./catalog-types.ts";
import type { DelegateWorktree } from "./runtime-types.ts";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 15 * 60_000;

export async function provisionWorktree(cwd: string, persona: string, settings: AgentsSettings): Promise<DelegateWorktree> {
	const top = await revParse(cwd, "--show-toplevel");
	if (!top) throw new Error(`A dedicated worktree requires a git repository: ${cwd}`);
	const label = `${persona.replace(/[^A-Za-z0-9_-]/g, "-")}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	const root = settings.worktreeRoot ? path.resolve(top, settings.worktreeRoot) : path.join(path.dirname(top), `${path.basename(top)}-worktrees`);
	const target = path.join(root, label);
	if (existsSync(target)) throw new Error(`Worktree path already exists: ${target}`);
	const branch = `subagent/${label}`;
	await exec("git", ["-C", top, "worktree", "add", "-b", branch, target, "HEAD"], { timeout: GIT_TIMEOUT_MS });
	try {
		for (const command of settings.worktreeSetup) await exec("/bin/sh", ["-c", command], { cwd: target, timeout: SETUP_TIMEOUT_MS, maxBuffer: 4_000_000 });
	} catch (error) {
		await exec("git", ["-C", top, "worktree", "remove", "--force", target], { timeout: GIT_TIMEOUT_MS }).catch(() => undefined);
		throw new Error(`Worktree setup failed for ${target}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { path: target, branch };
}

/** True when cwd is a linked git worktree distinct from the orchestrator's own working tree. */
export async function isIsolatedWorktree(cwd: string, parentCwd: string): Promise<boolean> {
	const top = await revParse(cwd, "--show-toplevel");
	const parentTop = await revParse(parentCwd, "--show-toplevel") ?? await realpath(parentCwd).catch(() => path.resolve(parentCwd));
	if (!top || path.resolve(top) === path.resolve(parentTop)) return false;
	const gitDir = await revParse(cwd, "--absolute-git-dir");
	const commonDir = await revParse(cwd, "--git-common-dir");
	if (!gitDir || !commonDir) return false;
	return path.resolve(cwd, gitDir) !== path.resolve(cwd, commonDir);
}

async function revParse(cwd: string, flag: string): Promise<string | undefined> {
	try {
		const { stdout } = await exec("git", ["-C", cwd, "rev-parse", flag], { timeout: GIT_TIMEOUT_MS });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}
