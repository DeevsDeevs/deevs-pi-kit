import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
		expect(await runtime.verifyCherryPicks(stageAlice.path, repo.headCommit, aliceTip, aliceHandoff.commits)).toMatchObject({ commits: [aliceTip] });
		const spoof = await runtime.createIntegrationWorktree(repo, join(fixture.managed, "stage-spoof"), "refs/heads/runtime/integrate/spoof", repo.headCommit);
		writeFileSync(join(spoof.path, "unrelated.txt"), "unrelated\n");
		git(spoof.path, ["add", "-A"]);
		git(spoof.path, ["commit", "-m", `alice checkpoint\n\n(cherry picked from commit ${aliceHandoff.commits[0]})`]);
		const spoofHead = git(spoof.path, ["rev-parse", "HEAD"]);
		await expect(runtime.verifyCherryPicks(spoof.path, repo.headCommit, spoofHead, aliceHandoff.commits)).rejects.toThrow("exact source commits");
		const whitespaceSpoof = await runtime.createIntegrationWorktree(repo, join(fixture.managed, "stage-whitespace-spoof"), "refs/heads/runtime/integrate/whitespace-spoof", repo.headCommit);
		writeFileSync(join(whitespaceSpoof.path, "shared.txt"), "alice \n");
		renameSync(join(whitespaceSpoof.path, "old.txt"), join(whitespaceSpoof.path, "renamed.txt"));
		rmSync(join(whitespaceSpoof.path, "delete.txt"));
		writeFileSync(join(whitespaceSpoof.path, "binary.bin"), Buffer.from([0, 1, 2, 3]));
		git(whitespaceSpoof.path, ["add", "-A"]);
		git(whitespaceSpoof.path, ["commit", "-m", `alice checkpoint\n\n(cherry picked from commit ${aliceHandoff.commits[0]})`]);
		const whitespaceSpoofHead = git(whitespaceSpoof.path, ["rev-parse", "HEAD"]);
		await expect(runtime.verifyCherryPicks(whitespaceSpoof.path, repo.headCommit, whitespaceSpoofHead, aliceHandoff.commits)).rejects.toThrow("exact source commits");
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

		const ambiguous = await runtime.createIntegrationWorktree(current, join(fixture.managed, "stage-ambiguous-cleanup"), "refs/heads/runtime/integrate/ambiguous-cleanup", current.headCommit);
		const movedAmbiguous = join(fixture.managed, "stage-ambiguous-moved");
		git(current.root, ["worktree", "move", ambiguous.path, movedAmbiguous]);
		git(movedAmbiguous, ["checkout", "--detach"]);
		await expect(runtime.removeWorktree(current, ambiguous)).rejects.toThrow();
		expect(git(current.root, ["rev-parse", ambiguous.branchRef])).toBe(ambiguous.headCommit);
		git(movedAmbiguous, ["checkout", ambiguous.branchRef.slice("refs/heads/".length)]);
		git(current.root, ["worktree", "move", movedAmbiguous, ambiguous.path]);
		await runtime.removeWorktree(current, ambiguous);

		const interrupted = await runtime.createIntegrationWorktree(current, join(fixture.managed, "stage-interrupted-cleanup"), "refs/heads/runtime/integrate/interrupted-cleanup", current.headCommit);
		git(current.root, ["worktree", "remove", "--", interrupted.path]);
		expect(existsSync(interrupted.path)).toBe(false);
		expect(git(current.root, ["rev-parse", interrupted.branchRef])).toBe(interrupted.headCommit);
		await runtime.removeWorktree(current, interrupted);
		expect(() => git(current.root, ["show-ref", "--verify", interrupted.branchRef])).toThrow();
		await runtime.removeWorktree(current, interrupted);

		await runtime.removeWorktree(current, { ...stageAlice, headCommit: aliceTip });
		await runtime.removeWorktree(current, { ...stageAlice, headCommit: aliceTip });
		await runtime.discardWorktree(current, { ...spoof, headCommit: spoofHead });
		await runtime.discardWorktree(current, { ...whitespaceSpoof, headCommit: whitespaceSpoofHead });
		await runtime.removeWorktree(current, { ...alice, headCommit: aliceHandoff.headCommit });
		await runtime.removeWorktree(current, { ...bob, headCommit: bobHandoff.headCommit });
	}, 15_000);

	it("recovers an exact replay when main has a nonconflicting edit in the same file", async () => {
		const fixture = repository();
		const runtime = new RuntimeGit();
		const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
		writeFileSync(join(fixture.project, "replay.txt"), `${original.join("\n")}\n`);
		git(fixture.project, ["add", "replay.txt"]);
		git(fixture.project, ["commit", "-m", "replay base"]);
		const base = await runtime.discover(fixture.project);
		const writer = await runtime.createWorktree(base, join(fixture.managed, "replay-writer"), "refs/heads/runtime/collab/replay-writer", base.headCommit);
		const writerLines = [...original];
		writerLines[0] = "writer change";
		writeFileSync(join(writer.path, "replay.txt"), `${writerLines.join("\n")}\n`);
		const handoff = await runtime.checkpoint(base, writer, base.headCommit, "writer replay");

		const mainLines = [...original];
		mainLines[19] = "main change";
		writeFileSync(join(fixture.project, "replay.txt"), `${mainLines.join("\n")}\n`);
		git(fixture.project, ["add", "replay.txt"]);
		git(fixture.project, ["commit", "-m", "main same-file change"]);
		const current = await runtime.discover(fixture.project);
		const stage = await runtime.createIntegrationWorktree(current, join(fixture.managed, "replay-stage"), "refs/heads/runtime/integrate/replay", current.headCommit);
		const prepared = await runtime.cherryPick(stage.path, handoff.commits);
		if (prepared.status !== "prepared") throw new Error("Expected clean replay preparation.");
		const expected = [...writerLines];
		expected[19] = "main change";
		expect(readFileSync(join(stage.path, "replay.txt"), "utf8")).toBe(`${expected.join("\n")}\n`);
		expect(await runtime.verifyCherryPicks(stage.path, current.headCommit, prepared.headCommit, handoff.commits)).toMatchObject({ commits: [prepared.headCommit] });
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

	it("refuses ignored-data collisions while preserving unrelated ignored main data", async () => {
		const fixture = repository();
		const runtime = new RuntimeGit();
		const repo = await runtime.discover(fixture.project);
		const writer = await runtime.createWorktree(repo, join(fixture.managed, "ignored-writer"), "refs/heads/runtime/collab/ignored-writer", repo.headCommit);
		writeFileSync(join(writer.path, "collision.ignored"), "candidate\n");
		writeFileSync(join(writer.path, "cache"), "tracked file\n");
		mkdirSync(join(writer.path, "ancestor.ignored"));
		writeFileSync(join(writer.path, "ancestor.ignored", "new.txt"), "tracked descendant\n");
		git(writer.path, ["add", "-f", "collision.ignored", "cache", "ancestor.ignored/new.txt"]);
		git(writer.path, ["commit", "-m", "tracked ignored path"]);
		const handoff = await runtime.handoff(writer.path, repo.headCommit, git(writer.path, ["rev-parse", "HEAD"]));
		const stage = await runtime.createIntegrationWorktree(repo, join(fixture.managed, "ignored-stage"), "refs/heads/runtime/integrate/ignored", repo.headCommit);
		const prepared = await runtime.cherryPick(stage.path, handoff.commits);
		if (prepared.status !== "prepared") throw new Error("Expected prepared ignored-path integration.");

		writeFileSync(join(fixture.project, "collision.ignored"), "user data\n");
		await expect(runtime.finalize(repo, repo.headCommit, prepared.headCommit)).rejects.toThrow("overwrite ignored main-worktree data");
		expect(readFileSync(join(fixture.project, "collision.ignored"), "utf8")).toBe("user data\n");
		expect(git(fixture.project, ["rev-parse", "HEAD"])).toBe(repo.headCommit);

		rmSync(join(fixture.project, "collision.ignored"));
		git(fixture.project, ["config", "core.ignoreCase", "true"]);
		writeFileSync(join(fixture.project, "COLLISION.ignored"), "case-aliased user data\n");
		await expect(runtime.finalize(repo, repo.headCommit, prepared.headCommit)).rejects.toThrow("overwrite ignored main-worktree data");
		expect(readFileSync(join(fixture.project, "COLLISION.ignored"), "utf8")).toBe("case-aliased user data\n");
		rmSync(join(fixture.project, "COLLISION.ignored"));
		git(fixture.project, ["config", "core.ignoreCase", "false"]);

		mkdirSync(join(fixture.project, "cache"));
		writeFileSync(join(fixture.project, "cache-foo.ignored"), "lexically intervening user data\n");
		writeFileSync(join(fixture.project, "cache", "child.ignored"), "nested user data\n");
		await expect(runtime.finalize(repo, repo.headCommit, prepared.headCommit)).rejects.toThrow("overwrite ignored main-worktree data");
		expect(readFileSync(join(fixture.project, "cache", "child.ignored"), "utf8")).toBe("nested user data\n");

		rmSync(join(fixture.project, "cache"), { recursive: true });
		writeFileSync(join(fixture.project, "ancestor.ignored"), "blocking user data\n");
		await expect(runtime.finalize(repo, repo.headCommit, prepared.headCommit)).rejects.toThrow("overwrite ignored main-worktree data");
		expect(readFileSync(join(fixture.project, "ancestor.ignored"), "utf8")).toBe("blocking user data\n");

		rmSync(join(fixture.project, "ancestor.ignored"));
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const bin = join(fixture.root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), `#!/bin/sh\nfor argument do\n  if [ "$argument" = merge ]; then printf 'racing user data\\n' > ${JSON.stringify(join(fixture.project, "collision.ignored"))}; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`);
		chmodSync(join(bin, "git"), 0o755);
		const path = process.env.PATH;
		try {
			process.env.PATH = `${bin}:${path ?? ""}`;
			await expect(runtime.finalize(repo, repo.headCommit, prepared.headCommit)).rejects.toThrow("Git merge failed");
		} finally { process.env.PATH = path; }
		expect(readFileSync(join(fixture.project, "collision.ignored"), "utf8")).toBe("racing user data\n");
		expect(git(fixture.project, ["rev-parse", "HEAD"])).toBe(repo.headCommit);

		rmSync(join(fixture.project, "collision.ignored"));
		const ignoredBulk = join(fixture.project, "bulk");
		mkdirSync(ignoredBulk);
		for (let index = 0; index <= 10_000; index++) writeFileSync(join(ignoredBulk, `${index}.ignored`), "");
		writeFileSync(join(fixture.project, "unrelated.ignored"), "preserve me\n");
		expect(await runtime.finalize(repo, repo.headCommit, prepared.headCommit)).toBe(prepared.headCommit);
		expect(readFileSync(join(fixture.project, "unrelated.ignored"), "utf8")).toBe("preserve me\n");
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
		rmSync(marker, { force: true });
		symlinkSync("../outside", join(fixture.project, "base-escape"));
		git(fixture.project, ["add", "base-escape"]);
		git(fixture.project, ["commit", "-m", "escaping base symlink"]);
		const escapingBase = await runtime.discover(fixture.project);
		await expect(runtime.createWorktree(escapingBase, join(fixture.managed, "base-escape"), "refs/heads/runtime/collab/base-escape", escapingBase.headCommit)).rejects.toThrow("symlink escapes");
		rmSync(join(fixture.project, "base-escape"));
		git(fixture.project, ["add", "-A"]);
		git(fixture.project, ["commit", "-m", "remove escaping base symlink"]);
		const repo = await runtime.discover(fixture.project);
		const writer = await runtime.createWorktree(repo, join(fixture.managed, "unsafe"), "refs/heads/runtime/collab/unsafe", repo.headCommit);
		rmSync(marker, { force: true });
		writeFileSync(join(writer.path, ".gitattributes"), "shared.txt filter=evil\n");
		await expect(runtime.checkpoint(repo, writer, repo.headCommit, "unsafe attributes")).rejects.toThrow("Changing .gitattributes");
		expect(existsSync(marker)).toBe(false);
		rmSync(join(writer.path, ".gitattributes"));
		symlinkSync("../../outside", join(writer.path, "escape"));
		await expect(runtime.checkpoint(repo, writer, repo.headCommit, "unsafe")).rejects.toThrow("symlink escapes");
		rmSync(join(writer.path, "escape"));
		writeFileSync(join(writer.path, "keep.ignored"), "retained\n");
		await expect(runtime.removeWorktree(repo, writer)).rejects.toThrow("retained or unsettled data");
	});

	it("rejects Git infrastructure failures even when exit status 1 is allowed", async () => {
		const fixture = repository();
		const runtime = new RuntimeGit() as unknown as { runCodes(cwd: string, args: string[], allowed: number[], stdin?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<unknown> };
		await expect(runtime.runCodes(fixture.project, ["status"], [0, 1], undefined, { PATH: join(fixture.root, "missing") })).rejects.toThrow("could not execute");
	});
});
