import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, readlink, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

const MAX_GIT_BUFFER = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_PATHS = 10_000;
const MAX_COMMITS = 1_000;
const MAX_CHANGED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHANGED_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_REPLAY_PATCH_BYTES = 160 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40,64}$/;
const PRIVATE_BRANCH = /^refs\/heads\/runtime\/(?:collab|integrate)\/[A-Za-z0-9._-]+$/;

export interface RuntimeRepository {
	root: string;
	gitDir: string;
	commonDir: string;
	branchRef: string;
	headCommit: string;
}

export interface RuntimeWorktreeIdentity {
	path: string;
	branchRef: string;
	headCommit: string;
}

interface RuntimeWorktreeRecord {
	path: string;
	headCommit: string;
	branchRef?: string;
	detached: boolean;
}

export interface RuntimeCheckpoint {
	baseCommit: string;
	headCommit: string;
	commits: string[];
	changedFiles: number;
	additions: number;
	deletions: number;
}

export interface RuntimeStatus {
	clean: boolean;
	paths: string[];
}

export class RuntimeGitError extends Error {
	readonly code = "git_error" as const;
}

export class RuntimeGit {
	async discover(root: string): Promise<RuntimeRepository> {
		await this.requireVersion();
		const canonical = await realpath(resolve(root));
		const top = await realpath((await this.text(canonical, ["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim());
		if (top !== canonical) throw new RuntimeGitError("Project must be the canonical Git worktree root.");
		const gitDir = await realpath((await this.text(canonical, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"])).trim());
		const commonDir = await realpath((await this.text(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
		const branchRef = (await this.text(canonical, ["symbolic-ref", "-q", "HEAD"])).trim();
		if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(branchRef)) throw new RuntimeGitError("Project HEAD must be an ordinary local branch.");
		const headCommit = commit((await this.text(canonical, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim());
		return { root: canonical, gitDir, commonDir, branchRef, headCommit };
	}

	async createWorktree(repository: RuntimeRepository, path: string, branchRef: string, baseCommit: string, kind: "collab" | "integrate" = "collab"): Promise<RuntimeWorktreeIdentity> {
		const base = commit(baseCommit);
		privateBranch(branchRef, kind);
		await this.rejectExternalAttributes(repository.root, base, undefined, kind === "integrate");
		await this.boundTree(repository.root, base, undefined, 100 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
		const branch = branchRef.slice("refs/heads/".length);
		await this.run(repository.root, ["worktree", "add", "--no-checkout", "--no-track", "-b", branch, "--", path, base]);
		await this.run(path, ["checkout", "--no-recurse-submodules", branch]);
		const verified = await this.verifyWorktree(repository, path, branchRef, base);
		await this.assertMaterialized(path);
		return verified;
	}

	async verifyWorktree(repository: RuntimeRepository, path: string, branchRef: string, expectedHead?: string): Promise<RuntimeWorktreeIdentity> {
		privateBranch(branchRef);
		const canonical = await realpath(path);
		const commonDir = await realpath((await this.text(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
		const actualRef = (await this.text(canonical, ["symbolic-ref", "-q", "HEAD"])).trim();
		const headCommit = commit((await this.text(canonical, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim());
		if (commonDir !== repository.commonDir || actualRef !== branchRef || (expectedHead && headCommit !== expectedHead)) throw new RuntimeGitError("Runtime worktree identity changed.");
		const registered = (await this.worktrees(repository.root)).find((entry) => entry.path === canonical);
		if (!registered || registered.branchRef !== branchRef || registered.headCommit !== headCommit) throw new RuntimeGitError("Git worktree registry does not match Runtime ownership.");
		return { path: canonical, branchRef, headCommit };
	}

	async status(path: string): Promise<RuntimeStatus> {
		const output = await this.output(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"]);
		const paths = parsePorcelain(output);
		return { clean: paths.length === 0, paths };
	}

	async checkpoint(repository: RuntimeRepository, worktree: RuntimeWorktreeIdentity, baseCommit: string, message: string): Promise<RuntimeCheckpoint> {
		const base = commit(baseCommit);
		const verified = await this.verifyWorktree(repository, worktree.path, worktree.branchRef);
		await this.assertFullCheckout(worktree.path);
		await this.requireLinearRange(worktree.path, base, verified.headCommit);
		await this.rejectChangedAttributes(worktree.path);
		const before = await this.status(worktree.path);
		if (!before.clean) {
			await this.boundChangedPaths(worktree.path, before.paths);
			await this.rejectExternalAttributes(worktree.path, "HEAD", before.paths);
			await this.rejectEscapingSymlinks(worktree.path, before.paths);
			await this.run(worktree.path, ["add", "-A", "--", "."]);
			const staged = await this.runCodes(worktree.path, ["diff", "--cached", "--quiet", "--exit-code"], [0, 1]);
			if (staged.code === 1) {
				const tree = commitish((await this.text(worktree.path, ["write-tree"])).trim(), "tree");
				const next = commit((await this.text(worktree.path, ["commit-tree", tree, "-p", verified.headCommit, "-F", "-"], `${message.trim() || "Runtime collaborator checkpoint"}\n`, checkpointIdentity())).trim());
				await this.run(repository.root, ["update-ref", worktree.branchRef, next, verified.headCommit]);
			}
		}
		const after = await this.verifyWorktree(repository, worktree.path, worktree.branchRef);
		const status = await this.status(worktree.path);
		if (!status.clean) throw new RuntimeGitError("Checkpoint did not leave the worktree clean; preserve it for attention.");
		return this.handoff(worktree.path, base, after.headCommit);
	}

	async handoff(path: string, baseCommit: string, headCommit: string): Promise<RuntimeCheckpoint> {
		const base = commit(baseCommit);
		const head = commit(headCommit);
		const commits = await this.requireLinearRange(path, base, head);
		const changedPaths = splitNul(await this.output(path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", base, head]));
		await this.boundTree(path, head, changedPaths, MAX_CHANGED_FILE_BYTES, MAX_CHANGED_TOTAL_BYTES);
		for (const source of commits) {
			const paths = splitNul(await this.output(path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", `${source}^`, source]));
			await this.rejectExternalAttributes(path, source, paths, true);
			await this.boundTree(path, source, paths, MAX_CHANGED_FILE_BYTES, MAX_CHANGED_TOTAL_BYTES);
		}
		const output = await this.text(path, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", base, head]);
		let changedFiles = 0;
		let additions = 0n;
		let deletions = 0n;
		for (const line of output.split("\n")) {
			if (!line) continue;
			const [added, deleted] = line.split("\t", 3);
			changedFiles++;
			if (added !== "-") additions += BigInt(added!);
			if (deleted !== "-") deletions += BigInt(deleted!);
		}
		return { baseCommit: base, headCommit: head, commits, changedFiles, additions: safeNumber(additions), deletions: safeNumber(deletions) };
	}

	async createIntegrationWorktree(repository: RuntimeRepository, path: string, branchRef: string, mainHead: string): Promise<RuntimeWorktreeIdentity> {
		privateBranch(branchRef, "integrate");
		return this.createWorktree(repository, path, branchRef, mainHead, "integrate");
	}

	async cherryPick(path: string, commits: string[]): Promise<{ status: "prepared"; headCommit: string } | { status: "conflicted"; headCommit: string; paths: string[] }> {
		if (commits.length < 1 || commits.length > MAX_COMMITS || commits.some((value) => !COMMIT.test(value))) throw new RuntimeGitError("Integration commit list is invalid.");
		for (const source of commits) {
			await this.rejectExternalAttributes(path, "HEAD", undefined, true);
			const paths = splitNul(await this.output(path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", `${source}^`, source]));
			await this.rejectExternalAttributes(path, source, paths, true);
			await this.boundTree(path, source, paths, MAX_CHANGED_FILE_BYTES, MAX_CHANGED_TOTAL_BYTES);
			const picked = await this.runCodes(path, ["cherry-pick", "--no-gpg-sign", "-x", source], [0, 1, 128], undefined, checkpointIdentity());
			if (picked.code !== 0) {
				const status = await this.status(path);
				return { status: "conflicted", headCommit: commit((await this.text(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()), paths: status.paths.slice(0, MAX_PATHS) };
			}
		}
		const status = await this.status(path);
		if (!status.clean || await this.hasSequencer(path)) throw new RuntimeGitError("Prepared integration is not clean and settled.");
		return { status: "prepared", headCommit: commit((await this.text(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()) };
	}

	async verifyCherryPicks(path: string, mainHead: string, preparedHead: string, sourceCommits: string[]): Promise<RuntimeCheckpoint> {
		const sources = sourceCommits.map(commit);
		const recovered = await this.handoff(path, mainHead, preparedHead);
		if (recovered.commits.length !== sources.length) throw new RuntimeGitError("Prepared integration commit count does not match its source handoff.");
		const replayedTrees = await this.replayTrees(path, mainHead, sources);
		for (let index = 0; index < sources.length; index++) {
			const source = sources[index]!;
			const prepared = recovered.commits[index]!;
			const message = (await this.text(path, ["show", "-s", "--format=%B", prepared])).trimEnd();
			const preparedTree = commitish((await this.text(path, ["rev-parse", "--verify", "--end-of-options", `${prepared}^{tree}`])).trim(), "tree");
			if (!message.endsWith(`(cherry picked from commit ${source})`) || preparedTree !== replayedTrees[index]) throw new RuntimeGitError("Prepared integration does not match exact source commits replayed from main.");
		}
		return recovered;
	}

	async finalize(repository: RuntimeRepository, expectedMainHead: string, preparedHead: string): Promise<string> {
		const expected = commit(expectedMainHead);
		const prepared = commit(preparedHead);
		const current = await this.discover(repository.root);
		if (current.commonDir !== repository.commonDir || current.branchRef !== repository.branchRef) throw new RuntimeGitError("Main repository identity changed before finalization.");
		if (!(await this.status(repository.root)).clean) throw new RuntimeGitError("Main worktree must be clean before finalization.");
		if (current.headCommit === prepared) return prepared;
		if (current.headCommit !== expected) throw new RuntimeGitError("Main repository HEAD changed before finalization.");
		if (await this.hasIgnoredCollision(repository.root, expected, prepared)) throw new RuntimeGitError("Prepared integration would overwrite ignored main-worktree data.");
		await this.run(repository.root, ["merge", "--ff-only", "--no-edit", "--no-verify", "--no-overwrite-ignore", prepared]);
		const after = await this.discover(repository.root);
		if (after.headCommit !== prepared || !(await this.status(repository.root)).clean) throw new RuntimeGitError("Finalized main state does not match the prepared commit.");
		return after.headCommit;
	}

	async removeWorktree(repository: RuntimeRepository, worktree: RuntimeWorktreeIdentity): Promise<void> {
		let verified: RuntimeWorktreeIdentity;
		try { verified = await this.verifyWorktree(repository, worktree.path, worktree.branchRef, worktree.headCommit); }
		catch (error) {
			if (await this.finishRemovedWorktree(repository, worktree)) return;
			throw error;
		}
		if (!(await this.status(verified.path)).clean || await this.hasIgnored(verified.path) || await this.hasSequencer(verified.path)) throw new RuntimeGitError("Runtime worktree contains retained or unsettled data.");
		await this.run(repository.root, ["worktree", "remove", "--", verified.path]);
		if (!await this.finishRemovedWorktree(repository, worktree)) throw new RuntimeGitError("Removed worktree identity did not settle.");
	}

	async discardWorktree(repository: RuntimeRepository, worktree: RuntimeWorktreeIdentity): Promise<void> {
		let verified: RuntimeWorktreeIdentity;
		try { verified = await this.verifyWorktree(repository, worktree.path, worktree.branchRef, worktree.headCommit); }
		catch (error) {
			if (await this.finishRemovedWorktree(repository, worktree)) return;
			throw error;
		}
		await this.run(repository.root, ["worktree", "remove", "--force", "--", verified.path]);
		if (!await this.finishRemovedWorktree(repository, worktree)) throw new RuntimeGitError("Discarded worktree identity did not settle.");
	}

	async assertClean(path: string): Promise<void> {
		if (!(await this.status(path)).clean || await this.hasIgnored(path) || await this.hasSequencer(path)) throw new RuntimeGitError("Worktree is not clean, settled, and free of ignored data.");
	}

	async assertFullCheckout(path: string): Promise<void> {
		const records = splitNul(await this.output(path, ["ls-files", "-v", "-z", "--"]));
		if (records.length > MAX_PATHS || records.some((record) => !/^H .+$/s.test(record) || Buffer.byteLength(record.slice(2)) > MAX_PATH_BYTES)) throw new RuntimeGitError("Worktree index is sparse, assumed-unchanged, incomplete, or exceeds safety bounds.");
	}

	async assertMaterialized(path: string): Promise<void> { await this.assertClean(path); await this.assertFullCheckout(path); }

	private async finishRemovedWorktree(repository: RuntimeRepository, worktree: RuntimeWorktreeIdentity): Promise<boolean> {
		if ((await this.worktreeRecords(repository.root)).some((entry) => entry.path === worktree.path || entry.branchRef === worktree.branchRef || entry.detached && entry.headCommit === worktree.headCommit)) return false;
		try { await lstat(worktree.path); return false; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RuntimeGitError("Unable to verify removed worktree path."); }
		const ref = await this.runCodes(repository.root, ["show-ref", "--verify", "--quiet", worktree.branchRef], [0, 1]);
		if (ref.code === 1) return true;
		const head = commitish((await this.text(repository.root, ["rev-parse", "--verify", "--end-of-options", worktree.branchRef])).trim(), "worktree ref head");
		if (head !== worktree.headCommit) return false;
		await this.run(repository.root, ["update-ref", "-d", worktree.branchRef, worktree.headCommit]);
		return (await this.runCodes(repository.root, ["show-ref", "--verify", "--quiet", worktree.branchRef], [0, 1])).code === 1;
	}

	private async requireVersion(): Promise<void> {
		const output = (await this.raw(["--version"])).toString("utf8").trim();
		const match = /git version (\d+)\.(\d+)/.exec(output);
		if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 42)) throw new RuntimeGitError("Runtime workspaces require Git 2.42 or newer.");
	}

	private async rejectChangedAttributes(cwd: string): Promise<void> {
		const listed = splitNul(await this.output(cwd, ["ls-files", "--cached", "--others", "-z"]));
		if (listed.length > MAX_PATHS) throw new RuntimeGitError(`Repository exceeds the ${MAX_PATHS}-path workspace admission limit.`);
		const head = new Map<string, string>();
		for (const record of splitNul(await this.output(cwd, ["ls-tree", "-r", "-z", "HEAD"]))) {
			const tab = record.indexOf("\t");
			const metadata = tab < 0 ? [] : record.slice(0, tab).split(/ +/);
			const path = tab < 0 ? "" : record.slice(tab + 1);
			if (metadata.length !== 3) throw new RuntimeGitError("Git ls-tree returned malformed attribute metadata.");
			if (path === ".gitattributes" || path.endsWith("/.gitattributes")) head.set(path, commitish(metadata[2]!, "attribute blob"));
		}
		const candidates = new Set([...head.keys(), ...listed.filter((path) => path === ".gitattributes" || path.endsWith("/.gitattributes"))]);
		for (const path of candidates) {
			const absolute = resolve(cwd, path);
			if (!inside(cwd, absolute)) throw new RuntimeGitError("Workspace attribute path escapes its root.");
			const info = await lstat(absolute).catch(() => undefined);
			const blob = head.get(path);
			if (!blob || !info?.isFile() || info.size > MAX_GIT_BUFFER) throw new RuntimeGitError("Changing .gitattributes is not allowed in Runtime workspace handoffs.");
			const [current, committed] = await Promise.all([readFile(absolute), this.output(cwd, ["cat-file", "blob", blob])]);
			if (!current.equals(committed)) throw new RuntimeGitError("Changing .gitattributes is not allowed in Runtime workspace handoffs.");
		}
	}

	private async rejectExternalAttributes(cwd: string, source: string, paths?: string[], integration = false): Promise<void> {
		if (paths?.some((path) => path === ".gitattributes" || path.endsWith("/.gitattributes"))) throw new RuntimeGitError("Changing .gitattributes is not allowed in Runtime workspace handoffs.");
		const candidates = paths ?? splitNul(await this.output(cwd, ["ls-tree", "-r", "--name-only", "-z", source]));
		if (candidates.length > MAX_PATHS) throw new RuntimeGitError(`Repository exceeds the ${MAX_PATHS}-path workspace admission limit.`);
		if (candidates.length === 0) return;
		const input = Buffer.from(`${candidates.join("\0")}\0`);
		if (input.length > MAX_GIT_BUFFER) throw new RuntimeGitError("Repository paths exceed the workspace admission byte limit.");
		const args = ["check-attr", ...(source === "HEAD" ? [] : ["--source", source]), "-z", "--stdin", "filter", "merge"];
		const values = splitNul(await this.output(cwd, args, input));
		for (let index = 0; index + 2 < values.length; index += 3) {
			const attribute = values[index + 1]!;
			const value = values[index + 2]!;
			if (value !== "unspecified" && value !== "unset" && (attribute === "filter" || integration && attribute === "merge")) throw new RuntimeGitError(`Repository ${attribute} attributes are not allowed for Runtime workspace operations.`);
		}
	}

	private async boundTree(cwd: string, tree: string, paths: string[] | undefined, maxFileBytes: number, maxTotalBytes: number): Promise<void> {
		const candidates = paths ? [...new Set(paths)] : undefined;
		if (candidates && candidates.length > MAX_PATHS) throw new RuntimeGitError(`Git tree selection exceeds ${MAX_PATHS} paths.`);
		const batches = candidates ? Array.from({ length: Math.ceil(candidates.length / 200) }, (_, index) => candidates.slice(index * 200, index * 200 + 200)) : [undefined];
		let files = 0;
		let total = 0;
		for (const batch of batches) {
			const output = await this.output(cwd, ["ls-tree", "-r", "-l", "-z", tree, ...(batch ? ["--", ...batch] : [])]);
			for (const record of splitNul(output)) {
				const tab = record.indexOf("\t");
				const metadata = tab < 0 ? [] : record.slice(0, tab).split(/ +/);
				if (metadata.length !== 4) throw new RuntimeGitError("Git ls-tree returned malformed bounded metadata.");
				if (metadata[0] === "160000" || metadata[1] === "commit") throw new RuntimeGitError("Git submodules are not allowed in Runtime collaborator workspaces.");
				if (metadata[1] !== "blob") continue;
				const size = Number(metadata[3]);
				if (!Number.isSafeInteger(size) || size < 0) throw new RuntimeGitError("Git blob size is invalid.");
				files++;
				if (files > MAX_PATHS || size > maxFileBytes) throw new RuntimeGitError("Git tree exceeds its file count or per-blob size limit.");
				total += size;
				if (!Number.isSafeInteger(total) || total > maxTotalBytes) throw new RuntimeGitError("Git tree exceeds its aggregate blob size limit.");
			}
		}
	}

	private async boundChangedPaths(root: string, paths: string[]): Promise<void> {
		if (paths.length > MAX_PATHS) throw new RuntimeGitError(`Workspace change set exceeds ${MAX_PATHS} paths.`);
		let total = 0;
		for (const item of paths) {
			if (Buffer.byteLength(item) > MAX_PATH_BYTES) throw new RuntimeGitError("Workspace path exceeds its byte limit.");
			const absolute = resolve(root, item);
			if (!inside(root, absolute)) throw new RuntimeGitError("Workspace status path escapes its root.");
			const info = await lstat(absolute).catch(() => undefined);
			if (!info?.isFile()) continue;
			if (info.size > MAX_CHANGED_FILE_BYTES) throw new RuntimeGitError(`Workspace file exceeds ${MAX_CHANGED_FILE_BYTES} bytes.`);
			total += info.size;
			if (total > MAX_CHANGED_TOTAL_BYTES) throw new RuntimeGitError(`Workspace changes exceed ${MAX_CHANGED_TOTAL_BYTES} bytes.`);
		}
	}

	private async rejectEscapingSymlinks(root: string, paths: string[]): Promise<void> {
		for (const item of paths) {
			const absolute = resolve(root, item);
			const info = await lstat(absolute).catch(() => undefined);
			if (!info?.isSymbolicLink()) continue;
			const target = await readlink(absolute);
			const resolved = resolve(dirname(absolute), target);
			if (isAbsolute(target) || !inside(root, resolved)) throw new RuntimeGitError("Workspace symlink escapes its root.");
		}
	}

	private async replayTrees(cwd: string, mainHead: string, sources: string[]): Promise<string[]> {
		const indexPath = (await this.text(cwd, ["rev-parse", "--path-format=absolute", "--git-path", `runtime-replay-${randomUUID()}.index`])).trim();
		if (await lstat(indexPath).then(() => true, () => false)) throw new RuntimeGitError("Temporary replay index already exists.");
		const environment = { GIT_INDEX_FILE: indexPath };
		try {
			await this.run(cwd, ["read-tree", commit(mainHead)], undefined, environment);
			const trees: string[] = [];
			for (const source of sources) {
				const patch = (await this.runCodes(cwd, ["diff-tree", "-p", "--binary", "--full-index", "--no-renames", "--no-commit-id", "--no-ext-diff", "--no-textconv", `${source}^`, source], [0], undefined, undefined, MAX_REPLAY_PATCH_BYTES)).stdout;
				await this.run(cwd, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], patch, environment);
				trees.push(commitish((await this.text(cwd, ["write-tree"], undefined, environment)).trim(), "tree"));
			}
			return trees;
		} finally {
			await Promise.all([unlink(indexPath).catch(() => undefined), unlink(`${indexPath}.lock`).catch(() => undefined)]);
		}
	}

	private async requireLinearRange(cwd: string, base: string, head: string): Promise<string[]> {
		if ((await this.runCodes(cwd, ["merge-base", "--is-ancestor", base, head], [0, 1])).code !== 0) throw new RuntimeGitError("Workspace head is not a descendant of its base.");
		const merges = (await this.text(cwd, ["rev-list", "--merges", `${base}..${head}`])).trim();
		if (merges) throw new RuntimeGitError("Runtime handoff ranges must not contain merge commits.");
		const commits = (await this.text(cwd, ["rev-list", "--reverse", `${base}..${head}`])).trim().split("\n").filter(Boolean).map(commit);
		if (commits.length > MAX_COMMITS) throw new RuntimeGitError(`Runtime handoff exceeds ${MAX_COMMITS} commits.`);
		for (const value of commits) if ((await this.runCodes(cwd, ["diff-tree", "--quiet", `${value}^`, value], [0, 1])).code === 0) throw new RuntimeGitError("Runtime handoff contains an empty commit.");
		return commits;
	}

	private async worktrees(cwd: string): Promise<RuntimeWorktreeIdentity[]> {
		return (await this.worktreeRecords(cwd)).flatMap((record) => record.branchRef ? [{ path: record.path, branchRef: record.branchRef, headCommit: record.headCommit }] : []);
	}

	private async worktreeRecords(cwd: string): Promise<RuntimeWorktreeRecord[]> {
		const values = splitNul(await this.output(cwd, ["worktree", "list", "--porcelain", "-z"]));
		const result: RuntimeWorktreeRecord[] = [];
		let current: { path?: string; headCommit?: string; branchRef?: string; detached?: boolean } = {};
		for (const value of values) {
			if (!value) {
				if (Object.keys(current).length > 0) {
					if (!current.path || !current.headCommit || (!current.branchRef && !current.detached)) throw new RuntimeGitError("Git returned an incomplete worktree registration.");
					result.push({ path: current.path, headCommit: current.headCommit, ...(current.branchRef ? { branchRef: current.branchRef } : {}), detached: current.detached === true });
				}
				current = {};
				continue;
			}
			const space = value.indexOf(" ");
			const key = space < 0 ? value : value.slice(0, space);
			const item = space < 0 ? "" : value.slice(space + 1);
			if (key === "worktree") current.path = item;
			else if (key === "HEAD") current.headCommit = commit(item);
			else if (key === "branch") current.branchRef = item;
			else if (key === "detached") current.detached = true;
		}
		return result;
	}

	private async hasIgnored(cwd: string): Promise<boolean> {
		return (await this.output(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).length > 0;
	}

	private async hasIgnoredCollision(cwd: string, from: string, to: string): Promise<boolean> {
		const raw = splitNul(await this.output(cwd, ["diff-tree", "--raw", "-r", "-z", "--no-abbrev", "--no-renames", "--no-commit-id", from, to]));
		if (raw.length % 2 !== 0) throw new RuntimeGitError("Git returned malformed integration paths.");
		const materialized: string[] = [];
		for (let index = 0; index < raw.length; index += 2) {
			const metadata = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} [A-Z]$/.exec(raw[index]!);
			const path = raw[index + 1]!;
			if (!metadata || !path || Buffer.byteLength(path) > MAX_PATH_BYTES) throw new RuntimeGitError("Git returned malformed integration paths.");
			if (metadata[1] !== "000000") materialized.push(path);
		}
		const ignored = splitNul(await this.output(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--"]));
		if (materialized.length > MAX_PATHS || ignored.length > MAX_PATHS || ignored.some((path) => !path || Buffer.byteLength(path) > MAX_PATH_BYTES)) throw new RuntimeGitError("Main worktree exceeds ignored-path safety bounds.");
		const configuredIgnoreCase = (await this.runCodes(cwd, ["config", "--type=bool", "--get", "core.ignorecase"], [0, 1])).stdout.toString("utf8").trim() === "true";
		const ignoreCase = configuredIgnoreCase || await this.caseInsensitiveFilesystem(cwd);
		const comparable = (path: string) => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
		return ignored.some((ignoredPath) => materialized.some((changedPath) => overlaps(comparable(ignoredPath), comparable(changedPath))));
	}

	private async caseInsensitiveFilesystem(directory: string): Promise<boolean> {
		const probe = join(directory, `.pi-kit-case-probe-${randomUUID()}a`);
		const alias = `${probe.slice(0, -1)}A`;
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(probe, "wx", 0o600);
			await file.close();
			file = undefined;
			return await lstat(alias).then(() => true, () => false);
		} finally {
			await file?.close().catch(() => undefined);
			await unlink(probe).catch(() => undefined);
		}
	}

	private async hasSequencer(cwd: string): Promise<boolean> {
		for (const name of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
			const path = (await this.text(cwd, ["rev-parse", "--git-path", name])).trim();
			if (await lstat(path).then(() => true, () => false)) return true;
		}
		return false;
	}

	private async text(cwd: string, args: string[], stdin?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<string> {
		return new TextDecoder("utf-8", { fatal: true }).decode(await this.output(cwd, args, stdin, env));
	}

	private async output(cwd: string, args: string[], stdin?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<Buffer> {
		return (await this.runCodes(cwd, args, [0], stdin, env)).stdout;
	}

	private async run(cwd: string, args: string[], stdin?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<void> {
		await this.runCodes(cwd, args, [0], stdin, env);
	}

	private runCodes(cwd: string, args: string[], allowed: number[], stdin?: string | Buffer, extraEnv?: NodeJS.ProcessEnv, maxBuffer = MAX_GIT_BUFFER): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
		return new Promise((resolvePromise, reject) => {
			const child = execFile("git", gitArgs(args), { cwd, env: gitEnvironment(extraEnv), encoding: "buffer", maxBuffer, timeout: 30_000 }, (error, stdout, stderr) => {
				const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? (error as unknown as { code: number }).code : error ? 1 : 0;
				if (!allowed.includes(code)) {
					const detail = Buffer.from(stderr).toString("utf8").trim().slice(0, 2_000);
					reject(new RuntimeGitError(`Git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : "."}`));
					return;
				}
				resolvePromise({ code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
			});
			if (stdin !== undefined) child.stdin?.end(stdin); else child.stdin?.end();
		});
	}

	private raw(args: string[]): Promise<Buffer> {
		return new Promise((resolvePromise, reject) => execFile("git", args, { encoding: "buffer", maxBuffer: 64 * 1024, timeout: 5_000 }, (error, stdout) => error ? reject(new RuntimeGitError("Git is unavailable.")) : resolvePromise(Buffer.from(stdout))));
	}
}

function gitArgs(args: string[]): string[] {
	return ["--literal-pathspecs", "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "submodule.recurse=false", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "merge.autoStash=false", ...args];
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
	return { ...environment, ...extra, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", LC_ALL: "C" };
}

function checkpointIdentity(): NodeJS.ProcessEnv {
	return { GIT_AUTHOR_NAME: "Pi Runtime", GIT_AUTHOR_EMAIL: "runtime@localhost", GIT_COMMITTER_NAME: "Pi Runtime", GIT_COMMITTER_EMAIL: "runtime@localhost" };
}

function parsePorcelain(output: Buffer): string[] {
	const values = splitNul(output);
	const paths: string[] = [];
	for (let index = 0; index < values.length; index++) {
		const record = values[index]!;
		if (!record) continue;
		if (record.length < 4 || record[2] !== " ") throw new RuntimeGitError("Git status returned malformed porcelain output.");
		paths.push(record.slice(3));
		if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
			const source = values[++index];
			if (!source) throw new RuntimeGitError("Git status rename record is incomplete.");
			paths.push(source);
		}
	}
	return [...new Set(paths)];
}

function splitNul(output: Buffer): string[] {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
	return text.split("\0").filter((value, index, all) => value.length > 0 || index < all.length - 1);
}

function commit(value: string): string { return commitish(value, "commit"); }
function commitish(value: string, name: string): string {
	if (!COMMIT.test(value)) throw new RuntimeGitError(`Git ${name} identity is invalid.`);
	return value;
}
function privateBranch(value: string, kind?: "collab" | "integrate"): string {
	if (!PRIVATE_BRANCH.test(value) || kind && !value.startsWith(`refs/heads/runtime/${kind}/`)) throw new RuntimeGitError("Runtime branch identity is invalid.");
	return value;
}
function inside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function safeNumber(value: bigint): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RuntimeGitError("Git statistics exceed safe integer bounds.");
	return Number(value);
}
