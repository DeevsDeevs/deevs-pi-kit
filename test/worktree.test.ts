import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentWorktreeAt, createAgentWorktree, finishAgentWorktree, resolveRepoRoot, sharesCwd } from "../extensions/shared/worktree.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}

function initRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	git(path, ["init", "-q", "-b", "main"]);
	writeFileSync(join(path, "app.txt"), "base\n");
	git(path, ["add", "-A"]);
	git(path, ["commit", "-qm", "base"]);
	return realpathSync(path);
}

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-kit-worktree-")));
	roots.push(root);
	return { root, repo: initRepo(join(root, "repo")), agentDir: join(root, "agent") };
}

describe("agent worktrees", () => {
	it("puts each agent outside the repo on agent/<id>, and removes a worktree nothing changed in", async () => {
		const { repo, agentDir } = setup();
		const worktree = await createAgentWorktree({ cwd: repo, agentId: "a0123456789abcdef", agentDir });
		expect(worktree.path.startsWith(join(agentDir, "pi-kit", "worktrees"))).toBe(true);
		expect(worktree.path.endsWith("/a0123456789abcdef")).toBe(true);
		expect(worktree).toMatchObject({ branch: "agent/a0123456789abcdef", repoRoot: repo, base: git(repo, ["rev-parse", "HEAD"]) });
		expect(git(worktree.path, ["branch", "--show-current"])).toBe("agent/a0123456789abcdef");

		expect(await finishAgentWorktree(worktree)).toBeUndefined();
		expect(existsSync(worktree.path)).toBe(false);
		expect(git(repo, ["branch", "--list", "agent/*"])).toBe("");
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	});

	it("finds the agent worktree holding a cwd, so its rm root is that tree and not a sibling or the repo", async () => {
		const { repo, agentDir } = setup();
		const worktree = await createAgentWorktree({ cwd: repo, agentId: "a0123456789abcdef", agentDir });
		expect(agentWorktreeAt(join(worktree.path, "src"), agentDir)).toBe(worktree.path);
		expect(agentWorktreeAt(worktree.path, agentDir)).toBe(worktree.path);
		expect(agentWorktreeAt(dirname(worktree.path), agentDir)).toBeUndefined();
		expect(agentWorktreeAt(repo, agentDir)).toBeUndefined();
	});

	it("keeps a worktree with a commit or with uncommitted work, and leaves the main tree alone", async () => {
		const { repo, agentDir } = setup();
		const [committed, dirty] = await Promise.all(["a1", "a2"].map((agentId) => createAgentWorktree({ cwd: repo, agentId, agentDir })));
		writeFileSync(join(committed.path, "a1.txt"), "one\n");
		git(committed.path, ["add", "-A"]);
		git(committed.path, ["commit", "-qm", "a1"]);
		writeFileSync(join(dirty.path, "a2.txt"), "two\n");

		expect(await finishAgentWorktree(committed)).toEqual(committed);
		expect(await finishAgentWorktree(dirty)).toEqual(dirty);
		expect(existsSync(join(committed.path, "a1.txt")) && existsSync(join(dirty.path, "a2.txt"))).toBe(true);
		expect(git(repo, ["log", "--format=%s", "-1", "agent/a1"])).toBe("a1");
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	});

	it("serialises concurrent creation in one repository", async () => {
		const { repo, agentDir } = setup();
		const ids = Array.from({ length: 6 }, (_, index) => `a${index}`);
		const worktrees = await Promise.all(ids.map((agentId) => createAgentWorktree({ cwd: repo, agentId, agentDir })));
		expect(new Set(worktrees.map((worktree) => worktree.path)).size).toBe(ids.length);
		expect(git(repo, ["branch", "--list", "agent/*", "--format=%(refname:short)"]).split("\n").sort()).toEqual(ids.map((id) => `agent/${id}`));
	});

	it("never deletes a reattached branch that already carries commits", async () => {
		const { repo, agentDir } = setup();
		git(repo, ["checkout", "-q", "-b", "agent/a7"]);
		git(repo, ["commit", "-q", "--allow-empty", "-m", "earlier run"]);
		git(repo, ["checkout", "-q", "main"]);
		const worktree = await createAgentWorktree({ cwd: repo, agentId: "a7", agentDir });
		expect(await finishAgentWorktree(worktree)).toEqual(worktree);
	});
});

describe("resolveRepoRoot", () => {
	it("resolves a subfolder to its repository's top level", async () => {
		const { repo } = setup();
		mkdirSync(join(repo, "src"));
		expect(await resolveRepoRoot(join(repo, "src"))).toBe(repo);
	});

	it("names the repositories under a parent folder of several", async () => {
		const { root } = setup();
		const parent = join(root, "projects");
		initRepo(join(parent, "api"));
		initRepo(join(parent, "web"));
		mkdirSync(join(parent, "notes"));
		await expect(resolveRepoRoot(parent)).rejects.toThrow(`repositories under ${parent}: api, web`);
		await expect(resolveRepoRoot(join(parent, "notes"))).rejects.toThrow("is not inside a Git repository");
	});
});

describe("sharesCwd", () => {
	it("is true when another running agent writes in, above or below the cwd, not from its own worktree", () => {
		expect(sharesCwd([], "/repo")).toBe(false);
		expect(sharesCwd([{ cwd: "/repo" }], "/repo")).toBe(true);
		expect(sharesCwd([{ cwd: "/repo/pkg" }], "/repo")).toBe(true);
		expect(sharesCwd([{ cwd: "/repo" }], "/repo/pkg")).toBe(true);
		expect(sharesCwd([{ cwd: "/agent/pi-kit/worktrees/x/a1" }, { cwd: "/repo-other" }], "/repo")).toBe(false);
	});
});
