import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { RuntimeError } from "../errors.ts";
import { AGENT_NAME, PARTICIPANT_NAME } from "../schemas/common.ts";
import {
	type HostedAgentTarget,
	type HostedCollaboratorProfile,
	type HostedNativeCollaboratorDriver,
	isAgentTarget,
	isPiTarget,
	isWriter,
} from "../schemas/state.ts";
import type { HostedAgentBind } from "./state/operations.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "./identity.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveAgentTargetKey, deriveParticipantKey, HostedStateStore } from "./state.ts";
import { resolveCollaboratorRepo } from "./worktree.ts";
import { isProjectWorktree } from "../../shared/worktree.ts";

export interface BindAgentInput {
	agentName: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	protocol: string;
	participantId: string;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	expectedParticipantGeneration?: string;
	repo?: string;
}

export interface BoundAgentResult {
	registration: HostedLiveRegistration;
	targetKey: string;
	participantKey: string;
	holderGeneration: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	projectRoot: string;
	cwd: string;
}

export interface AgentBinderOptions {
	now?: () => number;
	createGeneration?: () => string;
}

/** Verifies one exact live Herdr agent by name and binds it to a target and participant lease. */
export class RuntimeAgentBinder {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly host: HostedHostVerifier;
	private readonly options: AgentBinderOptions;

	constructor(
		store: HostedStateStore,
		registrations: RuntimeRegistrationManager,
		host: HostedHostVerifier,
		options: AgentBinderOptions = {},
	) {
		this.store = store;
		this.registrations = registrations;
		this.host = host;
		this.options = options;
	}

	async bind(caller: HostedLiveRegistration, input: BindAgentInput): Promise<BoundAgentResult> {
		const callerTarget = this.store.read().targets[caller.targetKey];
		if (!isPiTarget(callerTarget)) {
			throw new RuntimeError("conflict", "Only an authenticated Pi target may bind a Herdr agent collaborator.");
		}
		named(input.agentName, AGENT_NAME, "Herdr agent name");
		named(input.protocol, PARTICIPANT_NAME, "protocol");
		named(input.participantId, PARTICIPANT_NAME, "participant ID");
		const projectRoot = realpathSync(callerTarget.projectRoot);
		const verified = await this.host.getAgent(input.agentName);
		if (verified.name !== input.agentName) throw new RuntimeError("identity_mismatch", "Herdr resolved another agent name.");
		const participantKey = deriveParticipantKey(projectRoot, input.protocol, input.participantId);
		const repo = input.repo ?? this.store.read().participants[participantKey]?.repo;
		const repoRoot = repo === undefined ? undefined : await resolveCollaboratorRepo(projectRoot, repo, input.participantId);
		const cwd = agentCwd(verified);
		if (repoRoot !== undefined && cwd === projectRoot) throw new RuntimeError("identity_mismatch", "Herdr agent cwd is the project root, not its repo.");
		const worktreePath = cwd === projectRoot || cwd === repoRoot ? undefined : cwd;
		if (worktreePath !== undefined && !(isWriter(input.profile) && await isProjectWorktree(worktreePath, repoRoot ?? projectRoot))) {
			throw new RuntimeError("identity_mismatch", "Herdr agent cwd is neither the project root, its repo, nor a workspace-write worktree of that repo.");
		}
		const target = this.agentTarget(input, verified, projectRoot, participantKey, worktreePath, repo, repoRoot);
		const bind: HostedAgentBind = {
			target,
			protocol: input.protocol,
			participantId: input.participantId,
			callerTargetKey: caller.targetKey,
			callerParticipantKey: bounded(input.callerParticipantKey, "caller participant key"),
			callerGeneration: bounded(input.expectedCallerGeneration, "caller generation"),
			at: this.now(),
		};
		if (input.expectedParticipantGeneration !== undefined) {
			bind.expectedParticipantGeneration = bounded(input.expectedParticipantGeneration, "expected participant generation");
		}
		this.store.apply({ type: "agent.bind", bind });
		return {
			registration: this.registrations.registerAgent(target),
			targetKey: target.targetKey,
			participantKey: target.participantKey,
			holderGeneration: target.holderGeneration,
			driver: target.driver,
			profile: target.profile,
			projectRoot: target.projectRoot,
			cwd: target.worktreePath ?? target.repoRoot ?? target.projectRoot,
		};
	}

	private agentTarget(
		input: BindAgentInput,
		verified: HostedLiveAgent,
		projectRoot: string,
		participantKey: string,
		worktreePath: string | undefined,
		repo: string | undefined,
		repoRoot: string | undefined,
	): HostedAgentTarget {
		const targetKey = deriveAgentTargetKey(projectRoot, input.agentName);
		const existing = this.store.read().targets[targetKey];
		if (existing !== undefined && !isAgentTarget(existing)) {
			throw new RuntimeError("conflict", "Herdr agent target key already belongs to another target kind.");
		}
		// The tab Runtime later closes to stop this collaborator.
		if (!verified.tabId || !verified.workspaceId) throw new RuntimeError("identity_mismatch", "Herdr agent has no exact tab and workspace identity.");
		const target: HostedAgentTarget = {
			kind: "agent",
			targetKey,
			projectRoot,
			agentName: input.agentName,
			driver: input.driver,
			participantKey,
			holderGeneration: existing?.holderGeneration ?? this.options.createGeneration?.() ?? `lease_${randomUUID()}`,
			profile: input.profile,
			herdr: { tabId: verified.tabId, workspaceId: verified.workspaceId },
			createdAt: existing?.createdAt ?? this.now(),
		};
		if (repoRoot && repo) {
			target.repo = repo;
			target.repoRoot = repoRoot;
		}
		if (worktreePath) target.worktreePath = worktreePath;
		return target;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function agentCwd(agent: HostedLiveAgent): string {
	try { return realpathSync(agent.cwd); } catch { throw new RuntimeError("identity_mismatch", "Herdr agent cwd is unavailable."); }
}

function named(value: string, pattern: RegExp, name: string): void {
	if (!pattern.test(value)) throw new RuntimeError("invalid_request", `${name} has invalid syntax.`);
}

function bounded(value: string, name: string): string {
	if (!value.trim() || Buffer.byteLength(value) > 200) throw new RuntimeError("invalid_request", `${name} must be a non-empty string of at most 200 bytes.`);
	return value;
}
