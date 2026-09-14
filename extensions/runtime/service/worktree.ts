import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { RuntimeError } from "../errors.ts";
import { PARTICIPANT_NAME } from "../schemas/common.ts";
import { type HostedParticipant, isHeld, isPiTarget } from "../schemas/state.ts";
import type { HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore, projectScope } from "./state.ts";

const BRANCH_PREFIX = "refs/heads/runtime/collab/";
const MAX_GIT_BUFFER = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

interface RuntimeWorktree {
	protocol: string;
	participantId: string;
	path: string;
	branchRef: string;
}

interface WorktreeAuthority {
	callerParticipantKey: string;
	expectedCallerGeneration: string;
}

interface EnsureWorktreeInput extends WorktreeAuthority {
	protocol: string;
	participantId: string;
}

interface RemoveWorktreeInput extends EnsureWorktreeInput {
	discardConfirmed: boolean;
}

interface RemovedWorktree {
	removed: true;
}

interface WorktreeListing extends RuntimeWorktree {
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
		const participantKey = this.participantKey(projectRoot, input);
		const participant = this.store.read().participants[participantKey];
		if (isHeld(participant?.state)) {
			throw new RuntimeError("conflict", "Participant already has a live holder; stop it before reusing its worktree.");
		}
		const existing = (await listWorktrees(projectRoot)).find((worktree) => isWorktreeOf(worktree, input));
		if (existing) {
			this.assertWorktreeIsOwn(existing.path, participantKey);
			if (participant?.worktreePath && participant.worktreePath !== existing.path) {
				throw new RuntimeError("conflict", "Recorded participant worktree does not match its Git worktree.");
			}
			return existing;
		}
		const path = join(this.root, "workspaces", `${projectScope(projectRoot)}__${input.protocol}__${input.participantId}`);
		mkdirSync(join(this.root, "workspaces"), { recursive: true, mode: 0o700 });
		await addWorktree(projectRoot, collaboratorBranch(input), path);
		return { protocol: input.protocol, participantId: input.participantId, path: realpathSync(path), branchRef: branchRef(input) };
	}

	async list(caller: HostedLiveRegistration): Promise<WorktreeListing[]> {
		const projectRoot = this.projectRoot(caller);
		const participants = Object.values(this.store.read().participants).filter((participant) => participant.projectRoot === projectRoot);
		const listings = (await listWorktrees(projectRoot)).map((worktree): WorktreeListing => {
			const participant = participants.find((candidate) => candidate.worktreePath === worktree.path);
			if (!participant) return { ...worktree, recorded: false };
			return { ...worktree, participantState: participant.state, recorded: true };
		});
		for (const participant of participants) {
			if (!participant.worktreePath || listings.some((listing) => listing.path === participant.worktreePath)) continue;
			listings.push({
				protocol: participant.protocol,
				participantId: participant.participantId,
				path: participant.worktreePath,
				branchRef: branchRef(participant),
				participantState: participant.state,
				recorded: true,
			});
		}
		return listings;
	}

	async remove(caller: HostedLiveRegistration, input: RemoveWorktreeInput): Promise<RemovedWorktree> {
		if (input.discardConfirmed !== true) {
			throw new RuntimeError("invalid_request", "Worktree removal requires an explicit confirmed discard.");
		}
		const projectRoot = this.authorize(caller, input);
		const participantKey = this.participantKey(projectRoot, input);
		if (isHeld(this.store.read().participants[participantKey]?.state)) {
			throw new RuntimeError("conflict", "Stop the collaborator before removing its worktree.");
		}
		const worktree = (await listWorktrees(projectRoot)).find((candidate) => isWorktreeOf(candidate, input));
		if (!worktree) throw new RuntimeError("not_found", "Participant has no Runtime worktree in this project.");
		this.assertWorktreeIsOwn(worktree.path, participantKey);
		if (this.store.read().participants[participantKey]) this.store.apply({ type: "participant.worktree.clear", participantKey });
		await git(projectRoot, ["worktree", "remove", "--force", worktree.path]);
		await git(projectRoot, ["branch", "-D", collaboratorBranch(input)]);
		return { removed: true };
	}

	/** A Git worktree recorded on another participant belongs to that identity, whatever its branch says. */
	private assertWorktreeIsOwn(path: string, participantKey: string): void {
		const owner = Object.values(this.store.read().participants)
			.find((participant) => participant.worktreePath === path && participant.participantKey !== participantKey);
		if (owner) throw new RuntimeError("conflict", `Worktree ${path} belongs to ${owner.protocol}/${owner.participantId}.`);
	}

	private authorize(caller: HostedLiveRegistration, input: EnsureWorktreeInput): string {
		const projectRoot = this.projectRoot(caller);
		if (!PARTICIPANT_NAME.test(input.protocol) || !PARTICIPANT_NAME.test(input.participantId)) {
			throw new RuntimeError("invalid_request", "Protocol and participant ID have invalid syntax.");
		}
		const participant = this.store.read().participants[input.callerParticipantKey];
		if (!callerHoldsAuthority(participant, input, caller, projectRoot)) {
			throw new RuntimeError("conflict", "Worktree caller authority is absent or no longer held.");
		}
		if (this.participantKey(projectRoot, input) === input.callerParticipantKey) {
			throw new RuntimeError("conflict", "A caller cannot provision its own worktree.");
		}
		return projectRoot;
	}

	private projectRoot(caller: HostedLiveRegistration): string {
		const target = this.store.read().targets[caller.targetKey];
		if (!isPiTarget(target)) {
			throw new RuntimeError("conflict", "Only an authenticated Pi target may manage collaborator worktrees.");
		}
		return target.projectRoot;
	}

	private participantKey(projectRoot: string, input: EnsureWorktreeInput): string {
		return deriveParticipantKey(projectRoot, input.protocol, input.participantId);
	}
}

function callerHoldsAuthority(
	participant: HostedParticipant | undefined,
	input: EnsureWorktreeInput,
	caller: HostedLiveRegistration,
	projectRoot: string,
): boolean {
	if (!participant || !isHeld(participant.state)) return false;
	return participant.generation === input.expectedCallerGeneration
		&& participant.holderTargetKey === caller.targetKey
		&& participant.projectRoot === projectRoot;
}

interface ParticipantIdentity {
	protocol: string;
	participantId: string;
}

function isWorktreeOf(worktree: RuntimeWorktree, identity: ParticipantIdentity): boolean {
	return worktree.protocol === identity.protocol
		&& worktree.participantId === identity.participantId;
}

function collaboratorBranch(identity: ParticipantIdentity): string {
	return `runtime/collab/${identity.protocol}/${identity.participantId}`;
}

function branchRef(identity: ParticipantIdentity): string {
	return `${BRANCH_PREFIX}${identity.protocol}/${identity.participantId}`;
}

/** A leftover branch outrules `-b`, so an interrupted removal or a manually pruned directory still reattaches. */
async function addWorktree(projectRoot: string, branch: string, path: string): Promise<void> {
	const reattach = await branchExists(projectRoot, branch);
	if (reattach) await git(projectRoot, ["worktree", "add", path, branch]);
	else await git(projectRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
}

async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
	try {
		await git(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function listWorktrees(projectRoot: string): Promise<RuntimeWorktree[]> {
	const worktrees: RuntimeWorktree[] = [];
	let path: string | undefined;
	for (const line of (await git(projectRoot, ["worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		if (!line.startsWith("branch ") || !path) continue;
		const worktree = parseWorktreeBranch(line.slice("branch ".length), path);
		if (worktree) worktrees.push(worktree);
		path = undefined;
	}
	return worktrees;
}

function parseWorktreeBranch(branch: string, path: string): RuntimeWorktree | undefined {
	if (!branch.startsWith(BRANCH_PREFIX)) return undefined;
	const [protocol, participantId, ...rest] = branch.slice(BRANCH_PREFIX.length).split("/");
	if (!protocol || !participantId || rest.length > 0) return undefined;
	return { protocol, participantId, path, branchRef: branch };
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
		const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
		const options = { cwd, encoding: "utf8" as const, maxBuffer: MAX_GIT_BUFFER, timeout: GIT_TIMEOUT_MS, env };
		execFile("git", args, options, (error, stdout, stderr) => {
			if (error) reject(new RuntimeError("host_unavailable", `git ${args[0]} failed: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});
}
