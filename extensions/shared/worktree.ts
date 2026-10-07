import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { agentDir as defaultAgentDir } from "./config.ts";

const MAX_GIT_BUFFER = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/** A git command that failed or timed out; Runtime reports it as `host_unavailable`. */
export class GitError extends Error {}

/** An agent's worktree: outside the repository, on `agent/<agentId>`; `base` is the repository's HEAD when it was made, so a reattached branch with older commits is never "unchanged". */
export interface AgentWorktree {
	path: string;
	branch: string;
	repoRoot: string;
	base: string;
}

export interface AgentWorktreeInput {
	cwd: string;
	agentId: string;
	agentDir?: string;
}

let creating: Promise<unknown> = Promise.resolve();

// ponytail: one in-process queue for every repository; per-repo queues if parallel creation ever matters.
export function createAgentWorktree(input: AgentWorktreeInput): Promise<AgentWorktree> {
	const created = creating.then(() => addAgentWorktree(input));
	creating = created.catch(() => undefined);
	return created;
}

async function addAgentWorktree({ cwd, agentId, agentDir = defaultAgentDir() }: AgentWorktreeInput): Promise<AgentWorktree> {
	const repoRoot = await resolveRepoRoot(cwd);
	const branch = `agent/${agentId}`;
	const path = join(agentDir, "pi-kit", "worktrees", createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16), agentId);
	const base = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
	mkdirSync(dirname(path), { recursive: true });
	await addWorktree(repoRoot, branch, path, base);
	return { path: realpathSync(path), branch, repoRoot, base };
}

/** The kit-made agent worktree that holds `cwd`, if any: an isolated agent may `rm` inside its own tree, outside the lead's project. */
export function agentWorktreeAt(cwd: string, agentDir = defaultAgentDir()): string | undefined {
	const base = join(agentDir, "pi-kit", "worktrees");
	const realBase = existsSync(base) ? realpathSync(base) : base;
	const [hash, agentId] = relative(realBase, cwd).split(sep);
	return hash && agentId && hash !== ".." ? join(realBase, hash, agentId) : undefined;
}

/** Removes the worktree and its branch when nothing changed; otherwise keeps both and returns the worktree. */
export async function finishAgentWorktree(worktree: AgentWorktree): Promise<AgentWorktree | undefined> {
	const head = (await git(worktree.path, ["rev-parse", "HEAD"])).trim();
	const dirty = (await git(worktree.path, ["status", "--porcelain"])).length > 0;
	if (dirty || head !== worktree.base) return worktree;
	await git(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
	await git(worktree.repoRoot, ["branch", "-D", worktree.branch]);
	return undefined;
}

/** Whether another running writer works in, above or below `cwd` (its worktree when isolated): the launch result then nudges toward worktrees. */
export function sharesCwd(running: { cwd: string }[], cwd: string): boolean {
	const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
	return running.some((agent) => overlaps(agent.cwd, cwd));
}

/** The top level of the repository holding `cwd`; a folder of repositories names them so the caller can pick one. */
export async function resolveRepoRoot(cwd: string): Promise<string> {
	const top = await gitTopLevel(cwd);
	if (top) return top;
	const repositories = await repositoriesUnder(cwd);
	if (!repositories.length) throw new Error(`${cwd} is not inside a Git repository.`);
	throw new Error(`${cwd} is not a Git repository; pass cwd as one of the repositories under ${cwd}: ${repositories.join(", ")}`);
}

/** A leftover branch outrules `-b`, so an interrupted removal or a manually pruned directory still reattaches. */
export async function addWorktree(repoRoot: string, branch: string, path: string, start = "HEAD"): Promise<void> {
	if (await branchExists(repoRoot, branch)) await git(repoRoot, ["worktree", "add", path, branch]);
	else await git(repoRoot, ["worktree", "add", "-b", branch, path, start]);
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
	try {
		await git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

// ponytail: one level deep; nested repositories are reachable by an explicit path.
export async function repositoriesUnder(root: string): Promise<string[]> {
	const names: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
		let path: string;
		try { path = realpathSync(join(root, entry.name)); } catch { continue; }
		if (await gitTopLevel(path) === path) names.push(entry.name);
	}
	return names.sort();
}

export async function gitTopLevel(cwd: string): Promise<string | undefined> {
	try { return realpathSync((await git(cwd, ["rev-parse", "--show-toplevel"])).trim()); } catch { return undefined; }
}

export async function isProjectWorktree(path: string, projectRoot: string): Promise<boolean> {
	try {
		return await commonDir(path) === await commonDir(projectRoot);
	} catch {
		return false;
	}
}

async function commonDir(cwd: string): Promise<string> {
	return realpathSync((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}

export function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
		const options = { cwd, encoding: "utf8" as const, maxBuffer: MAX_GIT_BUFFER, timeout: GIT_TIMEOUT_MS, env };
		execFile("git", args, options, (error, stdout, stderr) => {
			if (error) reject(new GitError(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});
}
