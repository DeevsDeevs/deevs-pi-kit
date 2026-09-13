import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HostedParticipant } from "../hosted-types.ts";
import type { HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const BRANCH_PREFIX = "refs/heads/runtime/collab/";
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_GIT_BUFFER = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export class RuntimeWorktreeError extends Error {
	readonly code: "invalid_request" | "not_found" | "conflict" | "git_error";

	constructor(code: RuntimeWorktreeError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

export interface RuntimeWorktree {
	participantId: string;
	path: string;
	branchRef: string;
}

export interface WorktreeAuthority {
	callerParticipantKey: string;
	expectedCallerGeneration: string;
}

export interface EnsureWorktreeInput extends WorktreeAuthority {
	protocol: string;
	participantId: string;
}

export interface RemoveWorktreeInput extends EnsureWorktreeInput {
	discardConfirmed: boolean;
}

export interface WorktreeListing extends RuntimeWorktree {
	protocol?: string;
	participantState?: HostedParticipant["state"];
	recorded: boolean;
}

export class RuntimeWorktrees {
	private readonly root: string;
	private readonly store: HostedStateStore;

	constructor(root: string, store: HostedStateStore) {
		this.root = root;
		this.store = store;
	}

	async ensure(caller: HostedLiveRegistration, input: EnsureWorktreeInput): Promise<RuntimeWorktree> {
		const projectRoot = this.authorize(caller, input);
		const participant = this.store.read().participants[this.participantKey(projectRoot, input)];
		if (participant?.state === "held") throw new RuntimeWorktreeError("conflict", "Participant already has a live holder; stop it before reusing its worktree.");
		const recorded = participant?.worktreePath;
		const existing = (await listWorktrees(projectRoot)).find((worktree) => worktree.participantId === input.participantId);
		if (existing) {
			if (recorded && recorded !== existing.path) throw new RuntimeWorktreeError("conflict", "Recorded participant worktree does not match its Git worktree.");
			return existing;
		}
		const path = join(this.root, "workspaces", input.participantId);
		mkdirSync(join(this.root, "workspaces"), { recursive: true, mode: 0o700 });
		await git(projectRoot, ["worktree", "add", "-b", `runtime/collab/${input.participantId}`, path, "HEAD"]);
		return { participantId: input.participantId, path: realpathSync(path), branchRef: `${BRANCH_PREFIX}${input.participantId}` };
	}

	async list(caller: HostedLiveRegistration): Promise<WorktreeListing[]> {
		const projectRoot = this.projectRoot(caller);
		const participants = Object.values(this.store.read().participants).filter((participant) => participant.projectRoot === projectRoot);
		const listings = (await listWorktrees(projectRoot)).map((worktree): WorktreeListing => {
			const participant = participants.find((candidate) => candidate.worktreePath === worktree.path);
			if (!participant) return { ...worktree, recorded: false };
			return { ...worktree, protocol: participant.protocol, participantState: participant.state, recorded: true };
		});
		for (const participant of participants) {
			if (!participant.worktreePath || listings.some((listing) => listing.path === participant.worktreePath)) continue;
			listings.push({ participantId: participant.participantId, path: participant.worktreePath, branchRef: `${BRANCH_PREFIX}${participant.participantId}`, protocol: participant.protocol, participantState: participant.state, recorded: true });
		}
		return listings;
	}

	async remove(caller: HostedLiveRegistration, input: RemoveWorktreeInput): Promise<{ removed: true }> {
		if (input.discardConfirmed !== true) throw new RuntimeWorktreeError("invalid_request", "Worktree removal requires an explicit confirmed discard.");
		const projectRoot = this.authorize(caller, input);
		const participantKey = this.participantKey(projectRoot, input);
		if (this.store.read().participants[participantKey]?.state === "held") throw new RuntimeWorktreeError("conflict", "Stop the collaborator before removing its worktree.");
		const worktree = (await listWorktrees(projectRoot)).find((candidate) => candidate.participantId === input.participantId);
		if (!worktree) throw new RuntimeWorktreeError("not_found", "Participant has no Runtime worktree in this project.");
		await git(projectRoot, ["worktree", "remove", "--force", worktree.path]);
		await git(projectRoot, ["branch", "-D", `runtime/collab/${input.participantId}`]);
		if (this.store.read().participants[participantKey]) this.store.apply({ type: "participant.worktree.clear", participantKey });
		return { removed: true };
	}

	private authorize(caller: HostedLiveRegistration, input: EnsureWorktreeInput): string {
		const projectRoot = this.projectRoot(caller);
		if (!NAME.test(input.protocol) || !NAME.test(input.participantId)) throw new RuntimeWorktreeError("invalid_request", "Protocol and participant ID have invalid syntax.");
		const participant = this.store.read().participants[input.callerParticipantKey];
		if (!participant || participant.state !== "held" || participant.generation !== input.expectedCallerGeneration || participant.holderTargetKey !== caller.targetKey || participant.projectRoot !== projectRoot) {
			throw new RuntimeWorktreeError("conflict", "Worktree caller authority is absent or no longer held.");
		}
		if (this.participantKey(projectRoot, input) === input.callerParticipantKey) throw new RuntimeWorktreeError("conflict", "A caller cannot provision its own worktree.");
		return projectRoot;
	}

	private projectRoot(caller: HostedLiveRegistration): string {
		const target = this.store.read().targets[caller.targetKey];
		if (target?.kind !== "pi") throw new RuntimeWorktreeError("conflict", "Only an authenticated Pi target may manage collaborator worktrees.");
		return target.projectRoot;
	}

	private participantKey(projectRoot: string, input: EnsureWorktreeInput): string {
		return deriveParticipantKey(projectRoot, input.protocol, input.participantId);
	}
}

export async function listWorktrees(projectRoot: string): Promise<RuntimeWorktree[]> {
	const worktrees: RuntimeWorktree[] = [];
	let path: string | undefined;
	for (const line of (await git(projectRoot, ["worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		if (!line.startsWith("branch ") || !path) continue;
		const branchRef = line.slice("branch ".length);
		if (branchRef.startsWith(BRANCH_PREFIX)) worktrees.push({ participantId: branchRef.slice(BRANCH_PREFIX.length), path, branchRef });
		path = undefined;
	}
	return worktrees;
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

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_GIT_BUFFER, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
			if (error) reject(new RuntimeWorktreeError("git_error", `git ${args[0]} failed: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});
}
