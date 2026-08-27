import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeGit } from "../extensions/runtime/service/git.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}

function repository() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-git-"));
	roots.push(root);
	const project = join(root, "project");
	const managed = join(root, "managed");
	mkdirSync(project);
	mkdirSync(managed);
	git(project, ["init", "-b", "main"]);
	writeFileSync(join(project, "shared.txt"), "base\n");
	writeFileSync(join(project, "old.txt"), "old\n");
	writeFileSync(join(project, "delete.txt"), "delete\n");
	writeFileSync(join(project, ".gitignore"), "*.ignored\n");
	git(project, ["add", "-A"]);
	git(project, ["commit", "-m", "base"]);
	return { root, project, managed };
}

describe("Runtime Git workspace adapter", () => {
	it("checkpoints concurrent writers and stages clean/conflicting integration without touching main early", async () => {
		const fixture = repository();
		const runtime = new RuntimeGit();
		const repo = await runtime.discover(fixture.project);
		const alicePath = join(fixture.managed, "alice");
		const bobPath = join(fixture.managed, "bob");
		const alice = await runtime.createWorktree(repo, alicePath, "refs/heads/runtime/collab/alice", repo.headCommit);
		const bob = await runtime.createWorktree(repo, bobPath, "refs/heads/runtime/collab/bob", repo.headCommit);

		writeFileSync(join(alicePath, "shared.txt"), "alice\n");
		renameSync(join(alicePath, "old.txt"), join(alicePath, "renamed.txt"));
		rmSync(join(alicePath, "delete.txt"));
		writeFileSync(join(alicePath, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		writeFileSync(join(bobPath, "shared.txt"), "bob\n");
		const aliceHandoff = await runtime.checkpoint(repo, alice, repo.headCommit, "alice checkpoint");
		const bobHandoff = await runtime.checkpoint(repo, bob, repo.headCommit, "bob checkpoint");
		expect(aliceHandoff).toMatchObject({ baseCommit: repo.headCommit, changedFiles: 5 });
		expect(bobHandoff).toMatchObject({ baseCommit: repo.headCommit, changedFiles: 1 });
		expect(readFileSync(join(fixture.project, "shared.txt"), "utf8")).toBe("base\n");

		const stageAlice = await runtime.createIntegrationWorktree(repo, join(fixture.managed, "stage-alice"), "refs/heads/runtime/integrate/alice", repo.headCommit);
		const preparedAlice = await runtime.cherryPick(stageAlice.path, aliceHandoff.commits);
		expect(preparedAlice.status).toBe("prepared");
		const aliceTip = preparedAlice.status === "prepared" ? preparedAlice.headCommit : "";
		expect(readFileSync(join(fixture.project, "shared.txt"), "utf8")).toBe("base\n");
		expect(await runtime.finalize(repo, repo.headCommit, aliceTip)).toBe(aliceTip);
		expect(await runtime.finalize(repo, repo.headCommit, aliceTip)).toBe(aliceTip);
		expect(readFileSync(join(fixture.project, "shared.txt"), "utf8")).toBe("alice\n");
		expect(readFileSync(join(fixture.project, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));

		const current = await runtime.discover(fixture.project);
		const stageBob = await runtime.createIntegrationWorktree(current, join(fixture.managed, "stage-bob"), "refs/heads/runtime/integrate/bob", current.headCommit);
		const conflicted = await runtime.cherryPick(stageBob.path, bobHandoff.commits);
		expect(conflicted).toMatchObject({ status: "conflicted", paths: expect.arrayContaining(["shared.txt"]) });
		expect(readFileSync(join(fixture.project, "shared.txt"), "utf8")).toBe("alice\n");
		if (conflicted.status === "conflicted") await runtime.discardWorktree(current, { ...stageBob, headCommit: conflicted.headCommit });
		expect(existsSync(stageBob.path)).toBe(false);

		await runtime.removeWorktree(current, { ...stageAlice, headCommit: aliceTip });
		await runtime.removeWorktree(current, { ...stageAlice, headCommit: aliceTip });
		await runtime.removeWorktree(current, { ...alice, headCommit: aliceHandoff.headCommit });
		await runtime.removeWorktree(current, { ...bob, headCommit: bobHandoff.headCommit });
	});

	it("fails finalization when main advances and preserves the prepared candidate", async () => {
		const fixture = repository();
		const runtime = new RuntimeGit();
		const repo = await runtime.discover(fixture.project);
		const writer = await runtime.createWorktree(repo, join(fixture.managed, "writer"), "refs/heads/runtime/collab/writer", repo.headCommit);
		writeFileSync(join(writer.path, "new.txt"), "candidate\n");
		const handoff = await runtime.checkpoint(repo, writer, repo.headCommit, "candidate");
		const stage = await runtime.createIntegrationWorktree(repo, join(fixture.managed, "stage"), "refs/heads/runtime/integrate/stage", repo.headCommit);
		const prepared = await runtime.cherryPick(stage.path, handoff.commits);
		expect(prepared.status).toBe("prepared");
		writeFileSync(join(fixture.project, "main-only.txt"), "advance\n");
		git(fixture.project, ["add", "-A"]);
		git(fixture.project, ["commit", "-m", "main advances"]);
		await expect(runtime.finalize(repo, repo.headCommit, prepared.status === "prepared" ? prepared.headCommit : "")).rejects.toThrow("changed before finalization");
		expect(readFileSync(join(stage.path, "new.txt"), "utf8")).toBe("candidate\n");
	});

	it("rejects destination merge drivers and oversized blobs from already-committed handoffs", async () => {
		const fixture = repository();
		const runtime = new RuntimeGit();
		const repo = await runtime.discover(fixture.project);
		const writer = await runtime.createWorktree(repo, join(fixture.managed, "writer-policy"), "refs/heads/runtime/collab/writer-policy", repo.headCommit);
		writeFileSync(join(writer.path, "shared.txt"), "writer\n");
		const handoff = await runtime.checkpoint(repo, writer, repo.headCommit, "writer policy");
		const marker = join(fixture.root, "merge-ran");
		writeFileSync(join(fixture.project, ".gitattributes"), "shared.txt merge=evil\n");
		git(fixture.project, ["add", ".gitattributes"]);
		git(fixture.project, ["commit", "-m", "target merge policy"]);
		git(fixture.project, ["config", "merge.evil.driver", `touch ${marker}`]);
		const current = await runtime.discover(fixture.project);
		await expect(runtime.createIntegrationWorktree(current, join(fixture.managed, "blocked-stage"), "refs/heads/runtime/integrate/blocked-stage", current.headCommit)).rejects.toThrow("merge attributes");
		expect(existsSync(marker)).toBe(false);
		expect(handoff.commits).toHaveLength(1);

		rmSync(join(fixture.project, ".gitattributes"));
		git(fixture.project, ["add", "-A"]);
		git(fixture.project, ["commit", "-m", "remove target policy"]);
		const clean = await runtime.discover(fixture.project);
		const large = await runtime.createWorktree(clean, join(fixture.managed, "large"), "refs/heads/runtime/collab/large", clean.headCommit);
		writeFileSync(join(large.path, "large.bin"), Buffer.alloc(20 * 1024 * 1024 + 1));
		git(large.path, ["add", "large.bin"]);
		git(large.path, ["commit", "-m", "oversized committed blob"]);
		const largeHead = git(large.path, ["rev-parse", "HEAD"]);
		await expect(runtime.handoff(large.path, clean.headCommit, largeHead)).rejects.toThrow("per-blob size limit");
		rmSync(join(large.path, "large.bin"));
		git(large.path, ["add", "-A"]);
		git(large.path, ["commit", "-m", "delete oversized blob"]);
		await expect(runtime.handoff(large.path, clean.headCommit, git(large.path, ["rev-parse", "HEAD"]))).rejects.toThrow("per-blob size limit");

		const magic = await runtime.createWorktree(clean, join(fixture.managed, "magic"), "refs/heads/runtime/collab/magic", clean.headCommit);
		git(magic.path, ["update-index", "--add", "--cacheinfo", `160000,${clean.headCommit},:(exclude)*`]);
		git(magic.path, ["commit", "-m", "magic gitlink"]);
		await expect(runtime.handoff(magic.path, clean.headCommit, git(magic.path, ["rev-parse", "HEAD"]))).rejects.toThrow("submodules are not allowed");

		const gitlinkTarget = git(fixture.project, ["rev-parse", "HEAD"]);
		git(fixture.project, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkTarget},nested-module`]);
		git(fixture.project, ["commit", "-m", "gitlink"]);
		const withGitlink = await runtime.discover(fixture.project);
		await expect(runtime.createWorktree(withGitlink, join(fixture.managed, "gitlink"), "refs/heads/runtime/collab/gitlink", withGitlink.headCommit)).rejects.toThrow("submodules are not allowed");
	});

	it("rejects repository filters, escaping symlinks, and ignored cleanup data without executing configured commands", async () => {
		const fixture = repository();
		const marker = join(fixture.root, "filter-ran");
		writeFileSync(join(fixture.project, ".gitattributes"), "*.txt filter=evil\n");
		git(fixture.project, ["add", ".gitattributes"]);
		git(fixture.project, ["commit", "-m", "attributes"]);
		git(fixture.project, ["config", "filter.evil.smudge", `touch ${marker}`]);
		git(fixture.project, ["config", "filter.evil.clean", `touch ${marker}`]);
		const runtime = new RuntimeGit();
		const filtered = await runtime.discover(fixture.project);
		await expect(runtime.createWorktree(filtered, join(fixture.managed, "filtered"), "refs/heads/runtime/collab/filtered", filtered.headCommit)).rejects.toThrow("filter attributes");
		expect(() => readFileSync(marker)).toThrow();

		rmSync(join(fixture.project, ".gitattributes"));
		git(fixture.project, ["add", "-A"]);
		git(fixture.project, ["commit", "-m", "remove attributes"]);
		const repo = await runtime.discover(fixture.project);
		const writer = await runtime.createWorktree(repo, join(fixture.managed, "unsafe"), "refs/heads/runtime/collab/unsafe", repo.headCommit);
		symlinkSync("../../outside", join(writer.path, "escape"));
		await expect(runtime.checkpoint(repo, writer, repo.headCommit, "unsafe")).rejects.toThrow("symlink escapes");
		rmSync(join(writer.path, "escape"));
		writeFileSync(join(writer.path, "keep.ignored"), "retained\n");
		await expect(runtime.removeWorktree(repo, writer)).rejects.toThrow("retained or unsettled data");
	});
});
