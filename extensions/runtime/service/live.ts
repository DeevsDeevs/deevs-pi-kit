import { lstatSync, realpathSync } from "node:fs";
import { RuntimeError } from "../errors.ts";
import type { HerdrAgentStatus } from "../schemas/herdr.ts";
import { type HostedAgentTarget, type HostedTarget, isAgentTarget, holds } from "../schemas/state.ts";
import type { HostedHostVerifier } from "./herdr-cli.ts";
import { HostedStateStore, piTargetKey } from "./state.ts";
import { isProjectWorktree } from "../../shared/worktree.ts";
import { resolveCollaboratorRepo } from "./worktree.ts";

const LEASE_MS = 30_000;

export interface RegisterPiInput {
	projectRoot: string;
	repo?: string;
	worktreePath?: string;
	piSessionId: string;
	piSessionFile: string;
}

/** Who calls: a target, named by its Pi session or its Herdr agent. The owner-only socket is the only credential. */
export interface HostedCaller {
	targetKey: string;
}

export interface LiveTargetOptions {
	now?: () => number;
	leaseMs?: number;
	onReady?: (targetKey: string) => void;
}

/** A Pi target is live while it heartbeats; a native tab while Herdr reports its agent where it was bound, still holding its name. */
export class LiveTargets {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly options: LiveTargetOptions;
	private readonly seen = new Map<string, number>();
	private readonly statuses = new Map<string, HerdrAgentStatus>();

	constructor(store: HostedStateStore, host: HostedHostVerifier, options: LiveTargetOptions = {}) {
		this.store = store;
		this.host = host;
		this.options = options;
	}

	async register(input: RegisterPiInput): Promise<HostedCaller> {
		const projectRoot = directory(input.projectRoot, "project root");
		const repoRoot = input.repo === undefined ? undefined : await resolveCollaboratorRepo(projectRoot, input.repo, input.piSessionId);
		const worktreePath = input.worktreePath === undefined ? undefined : directory(input.worktreePath, "collaborator worktree");
		const base = repoRoot ?? projectRoot;
		if (worktreePath !== undefined && (worktreePath === base || !await isProjectWorktree(worktreePath, base))) {
			throw new RuntimeError("identity_mismatch", "Collaborator cwd is not a separate Git worktree of its repository.");
		}
		const target: HostedTarget = {
			kind: "pi",
			targetKey: piTargetKey(input.piSessionId),
			projectRoot,
			piSessionId: input.piSessionId,
			piSessionFile: realpathSync(input.piSessionFile),
			createdAt: this.now(),
		};
		if (repoRoot && input.repo) {
			target.repo = input.repo;
			target.repoRoot = repoRoot;
		}
		if (worktreePath) target.worktreePath = worktreePath;
		this.store.apply({ type: "target.ensure", target });
		return this.touch(target.targetKey);
	}

	/** Marks a target seen now: a Pi heartbeat, or a native tab Herdr just reported. */
	touch(targetKey: string): HostedCaller {
		this.seen.set(targetKey, this.now());
		if (this.options.onReady) queueMicrotask(() => this.options.onReady?.(targetKey));
		return { targetKey };
	}

	/** Any known target may call; liveness is checked where an action needs it. */
	caller(targetKey: string): HostedCaller {
		if (!this.store.read().targets[targetKey]) throw new RuntimeError("registration_stale", "Target is unknown to Runtime; register first.");
		return { targetKey };
	}

	async heartbeat(targetKey: string): Promise<HostedCaller> {
		await this.verify(targetKey);
		return this.touch(targetKey);
	}

	/** A target that must be live now: a native tab is re-proved through Herdr, a Pi session by its last heartbeat. */
	async verify(targetKey: string): Promise<HostedCaller> {
		const target = this.store.read().targets[targetKey];
		if (!target) throw new RuntimeError("registration_stale", "Target is unknown to Runtime.");
		if (isAgentTarget(target)) {
			await this.verifyAgent(target);
			return this.touch(targetKey);
		}
		if (!this.hasLiveTarget(targetKey)) throw new RuntimeError("registration_stale", "Pi session is not heartbeating.");
		return { targetKey };
	}

	forget(targetKey: string): void {
		this.seen.delete(targetKey);
	}

	hasLiveTarget(targetKey: string): boolean {
		const at = this.seen.get(targetKey);
		return at !== undefined && this.now() - at < (this.options.leaseMs ?? LEASE_MS);
	}

	/** Herdr's status at this target's last verification, so a blocked tab is visible without a new query. */
	agentStatus(targetKey: string): HerdrAgentStatus | undefined {
		return this.hasLiveTarget(targetKey) ? this.statuses.get(targetKey) : undefined;
	}

	private async verifyAgent(target: HostedAgentTarget): Promise<void> {
		const live = await this.host.getAgent(target.agentName);
		let cwd: string | undefined;
		try { cwd = realpathSync(live.cwd); } catch {}
		if (live.name !== target.agentName || cwd !== (target.worktreePath ?? target.repoRoot ?? target.projectRoot)) {
			throw new RuntimeError("identity_mismatch", "Herdr reports this agent under another name or cwd.");
		}
		const participant = this.store.read().participants[target.participantKey];
		if (!holds(participant, target.targetKey, target.holderGeneration)) {
			throw new RuntimeError("registration_stale", "Herdr agent no longer holds its participant.");
		}
		if (live.agentStatus) this.statuses.set(target.targetKey, live.agentStatus);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function directory(path: string, name: string): string {
	try {
		const canonical = realpathSync(path);
		if (lstatSync(canonical).isDirectory()) return canonical;
	} catch {}
	throw new RuntimeError("invalid_request", `${name} must be an existing directory.`);
}
