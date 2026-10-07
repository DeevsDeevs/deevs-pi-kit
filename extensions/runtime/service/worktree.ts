import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, git, gitTopLevel, repositoriesUnder } from "../../shared/worktree.ts";
import { RuntimeError } from "../errors.ts";
import { type HostedParticipant, isHeld, isPiTarget } from "../schemas/state.ts";
import type { HostedCaller } from "./live.ts";
import { deriveParticipantKey, HostedStateStore, projectScope } from "./state.ts";

const BRANCH_PREFIX = "refs/heads/runtime/collab/";

interface RuntimeWorktree {
	protocol: string;
	participantId: string;
	path: string;
	branchRef: string;
	repoRoot: string;
}

interface WorktreeAuthority {
	callerParticipantKey: string;
	expectedCallerGeneration: string;
}

interface EnsureWorktreeInput extends WorktreeAuthority {
	protocol: string;
	participantId: string;
	repo?: string;
}

interface RemoveWorktreeInput extends EnsureWorktreeInput {
	discardConfirmed: true;
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

	async ensure(caller: HostedCaller, input: EnsureWorktreeInput): Promise<RuntimeWorktree> {
		const projectRoot = this.authorize(caller, input);
		const participantKey = this.participantKey(projectRoot, input);
		const participant = this.store.read().participants[participantKey];
		if (isHeld(participant?.state)) {
			throw new RuntimeError("conflict", "Participant already has a live holder; stop it before reusing its worktree.");
		}
		const repoRoot = await this.repoRoot(projectRoot, input, participant);
		if (participant?.worktreePath && participant.repoRoot && participant.repoRoot !== repoRoot) {
			throw new RuntimeError("conflict", `Worktree of ${input.protocol}/${input.participantId} is in ${participant.repoRoot}; clean it up before choosing another repo.`);
		}
		const existing = (await listWorktrees(repoRoot)).find((worktree) => isWorktreeOf(worktree, input));
		if (existing) {
			this.assertWorktreeIsOwn(existing.path, participantKey);
			if (participant?.worktreePath && participant.worktreePath !== existing.path) {
				throw new RuntimeError("conflict", "Recorded participant worktree does not match its Git worktree.");
			}
			return existing;
		}
		const path = join(this.root, "workspaces", `${projectScope(projectRoot)}__${input.protocol}__${input.participantId}`);
		mkdirSync(join(this.root, "workspaces"), { recursive: true, mode: 0o700 });
		await addWorktree(repoRoot, collaboratorBranch(input), path);
		return { protocol: input.protocol, participantId: input.participantId, path: realpathSync(path), branchRef: branchRef(input), repoRoot };
	}

	async list(caller: HostedCaller): Promise<WorktreeListing[]> {
		const projectRoot = this.projectRoot(caller);
		const participants = Object.values(this.store.read().participants).filter((participant) => participant.projectRoot === projectRoot);
		const repos = new Set(participants.flatMap((participant) => participant.repoRoot ? [participant.repoRoot] : []));
		if (await gitTopLevel(projectRoot) === projectRoot) repos.add(projectRoot);
		for (const name of await repositoriesUnder(projectRoot)) repos.add(realpathSync(join(projectRoot, name)));
		const listings: WorktreeListing[] = [];
		for (const repo of repos) {
			for (const worktree of await listWorktrees(repo)) {
				const participant = participants.find((candidate) => candidate.worktreePath === worktree.path);
				if (!participant) listings.push({ ...worktree, recorded: false });
				else listings.push({ ...worktree, participantState: participant.state, recorded: true });
			}
		}
		for (const participant of participants) {
			if (!participant.worktreePath || listings.some((listing) => listing.path === participant.worktreePath)) continue;
			listings.push({
				protocol: participant.protocol,
				participantId: participant.participantId,
				path: participant.worktreePath,
				branchRef: branchRef(participant),
				repoRoot: participant.repoRoot ?? projectRoot,
				participantState: participant.state,
				recorded: true,
			});
		}
		return listings;
	}

	async remove(caller: HostedCaller, input: RemoveWorktreeInput): Promise<RemovedWorktree> {
		const projectRoot = this.authorize(caller, input);
		const participantKey = this.participantKey(projectRoot, input);
		const participant = this.store.read().participants[participantKey];
		if (isHeld(participant?.state)) {
			throw new RuntimeError("conflict", "Stop the collaborator before removing its worktree.");
		}
		const repoRoot = await this.repoRoot(projectRoot, input, participant);
		const worktree = (await listWorktrees(repoRoot)).find((candidate) => isWorktreeOf(candidate, input));
		if (!worktree) throw new RuntimeError("not_found", "Participant has no Runtime worktree in this project.");
		this.assertWorktreeIsOwn(worktree.path, participantKey);
		if (participant) this.store.apply({ type: "participant.worktree.clear", participantKey });
		await git(repoRoot, ["worktree", "remove", "--force", worktree.path]);
		await git(repoRoot, ["branch", "-D", collaboratorBranch(input)]);
		return { removed: true };
	}

	/** An explicit repo wins; otherwise the participant's recorded repo, so a restart needs none; otherwise the project root itself. */
	private repoRoot(projectRoot: string, input: EnsureWorktreeInput, participant: HostedParticipant | undefined): Promise<string> {
		if (input.repo === undefined && participant?.repoRoot) return Promise.resolve(participant.repoRoot);
		return resolveCollaboratorRepo(projectRoot, input.repo, input.participantId);
	}

	/** A Git worktree recorded on another participant belongs to that identity, whatever its branch says. */
	private assertWorktreeIsOwn(path: string, participantKey: string): void {
		const owner = Object.values(this.store.read().participants)
			.find((participant) => participant.worktreePath === path && participant.participantKey !== participantKey);
		if (owner) throw new RuntimeError("conflict", `Worktree ${path} belongs to ${owner.protocol}/${owner.participantId}.`);
	}

	private authorize(caller: HostedCaller, input: EnsureWorktreeInput): string {
		const projectRoot = this.projectRoot(caller);
		const participant = this.store.read().participants[input.callerParticipantKey];
		if (!callerHoldsAuthority(participant, input, caller, projectRoot)) {
			throw new RuntimeError("conflict", "Worktree caller authority is absent or no longer held.");
		}
		if (this.participantKey(projectRoot, input) === input.callerParticipantKey) {
			throw new RuntimeError("conflict", "A caller cannot provision its own worktree.");
		}
		return projectRoot;
	}

	private projectRoot(caller: HostedCaller): string {
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
	caller: HostedCaller,
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

async function listWorktrees(repoRoot: string): Promise<RuntimeWorktree[]> {
	const worktrees: RuntimeWorktree[] = [];
	let path: string | undefined;
	for (const line of (await git(repoRoot, ["worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		if (!line.startsWith("branch ") || !path) continue;
		const worktree = parseWorktreeBranch(line.slice("branch ".length), path, repoRoot);
		if (worktree) worktrees.push(worktree);
		path = undefined;
	}
	return worktrees;
}

function parseWorktreeBranch(branch: string, path: string, repoRoot: string): RuntimeWorktree | undefined {
	if (!branch.startsWith(BRANCH_PREFIX)) return undefined;
	const [protocol, participantId, ...rest] = branch.slice(BRANCH_PREFIX.length).split("/");
	if (!protocol || !participantId || rest.length > 0) return undefined;
	return { protocol, participantId, path, branchRef: branch, repoRoot };
}

/**
 * The repository a collaborator works in: `<projectRoot>/<repo>` when given, else the project root, either
 * way the top level of a Git repository. The link may live under the root while its target lies elsewhere.
 */
export async function resolveCollaboratorRepo(projectRoot: string, repo: string | undefined, participantId: string): Promise<string> {
	if (repo === undefined) {
		if (await gitTopLevel(projectRoot) === projectRoot) return projectRoot;
		const candidates = await repositoriesUnder(projectRoot);
		const listed = candidates.length ? ` Repositories here: ${candidates.join(", ")}.` : "";
		throw new RuntimeError("invalid_request", `${projectRoot} is not a Git repository; pass repo for ${participantId}.${listed}`);
	}
	const segments = repo.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) {
		throw new RuntimeError("invalid_request", `repo for ${participantId} must be a relative path inside the project root.`);
	}
	let repoRoot: string;
	try { repoRoot = realpathSync(join(projectRoot, repo)); } catch { throw new RuntimeError("invalid_request", `repo ${repo} for ${participantId} does not exist.`); }
	if (await gitTopLevel(repoRoot) !== repoRoot) throw new RuntimeError("invalid_request", `repo ${repo} for ${participantId} is not the top level of a Git repository.`);
	return repoRoot;
}
