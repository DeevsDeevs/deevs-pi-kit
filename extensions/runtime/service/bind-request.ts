import { realpathSync } from "node:fs";
import {
	type HostedAgentBind,
	type HostedAgentTarget,
	type HostedCollaboratorProfile,
	type HostedHerdrLocator,
	type HostedNativeCollaboratorDriver,
	isAgentTarget,
	isWriter,
} from "../hosted-types.ts";
import type { HostedLiveAgent } from "./identity.ts";
import type { HostedLiveRegistration } from "./registration.ts";
import { deriveAgentTargetKey, deriveParticipantKey, HostedStateStore } from "./state.ts";
import { isProjectWorktree } from "./worktree.ts";

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class AgentBindError extends Error {
	readonly code: "invalid_request" | "conflict" | "identity_mismatch";

	constructor(code: AgentBindError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

export interface BindAgentInput {
	agentName: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	protocol: string;
	participantId: string;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	expectedParticipantGeneration?: string;
}

/** The validated identifiers a bind request carries, parsed once before any target is built. */
interface BoundAgentNames {
	agentName: string;
	protocol: string;
	participantId: string;
}

/** Everything the binder has already proven when the durable bind record is drafted. */
interface AgentBindDraft {
	store: HostedStateStore;
	caller: HostedLiveRegistration;
	input: BindAgentInput;
	names: BoundAgentNames;
	verified: HostedLiveAgent;
	projectRoot: string;
	at: number;
	createGeneration: () => string;
}

export function boundAgentNames(input: BindAgentInput): BoundAgentNames {
	return {
		agentName: boundedName(input.agentName, AGENT_NAME, "Herdr agent name"),
		protocol: boundedName(input.protocol, NAME, "protocol"),
		participantId: boundedName(input.participantId, NAME, "participant ID"),
	};
}

/** Resolves the agent's authorized cwd, then drafts the target and bind record it may be admitted under. */
export async function draftAgentBind(draft: AgentBindDraft): Promise<HostedAgentBind> {
	const { input, names, verified, projectRoot } = draft;
	if (verified.name !== names.agentName) throw new AgentBindError("identity_mismatch", "Herdr resolved another agent name.");
	const cwd = agentCwd(verified);
	const worktreePath = cwd === projectRoot ? undefined : cwd;
	if (worktreePath !== undefined && !await isWritableWorktree(worktreePath, projectRoot, input.profile)) {
		throw new AgentBindError("identity_mismatch", "Herdr agent cwd is neither the project root nor a workspace-write worktree of it.");
	}
	return bindRecord(draft, agentTarget(draft, worktreePath));
}

function agentTarget(draft: AgentBindDraft, worktreePath: string | undefined): HostedAgentTarget {
	const { input, names, projectRoot } = draft;
	const targetKey = deriveAgentTargetKey(projectRoot, names.agentName);
	const existing = draft.store.read().targets[targetKey];
	if (existing !== undefined && !isAgentTarget(existing)) {
		throw new AgentBindError("conflict", "Herdr agent target key already belongs to another target kind.");
	}
	const target: HostedAgentTarget = {
		kind: "agent",
		targetKey,
		projectRoot,
		agentName: names.agentName,
		driver: input.driver,
		participantKey: deriveParticipantKey(projectRoot, names.protocol, names.participantId),
		holderGeneration: existing?.holderGeneration ?? draft.createGeneration(),
		profile: input.profile,
		herdr: agentTab(draft.verified),
		createdAt: existing?.createdAt ?? draft.at,
	};
	if (worktreePath) target.worktreePath = worktreePath;
	return target;
}

function bindRecord(draft: AgentBindDraft, target: HostedAgentTarget): HostedAgentBind {
	const { input, names } = draft;
	const bind: HostedAgentBind = {
		target,
		protocol: names.protocol,
		participantId: names.participantId,
		callerTargetKey: draft.caller.targetKey,
		callerParticipantKey: bounded(input.callerParticipantKey, "caller participant key", 200),
		callerGeneration: bounded(input.expectedCallerGeneration, "caller generation", 200),
		at: draft.at,
	};
	const expected = input.expectedParticipantGeneration;
	if (expected !== undefined) bind.expectedParticipantGeneration = bounded(expected, "expected participant generation", 200);
	return bind;
}

/** The tab Runtime later closes to stop this collaborator. */
function agentTab(agent: HostedLiveAgent): HostedHerdrLocator {
	const { tabId, workspaceId } = agent;
	if (!tabId || !workspaceId) throw new AgentBindError("identity_mismatch", "Herdr agent has no exact tab and workspace identity.");
	return { tabId, workspaceId };
}

async function isWritableWorktree(worktreePath: string, projectRoot: string, profile: HostedCollaboratorProfile): Promise<boolean> {
	if (!isWriter(profile)) return false;
	return isProjectWorktree(worktreePath, projectRoot);
}

function agentCwd(agent: HostedLiveAgent): string {
	try { return realpathSync(agent.cwd); } catch { throw new AgentBindError("identity_mismatch", "Herdr agent cwd is unavailable."); }
}

function boundedName(value: string, pattern: RegExp, name: string): string {
	if (!pattern.test(value)) throw new AgentBindError("invalid_request", `${name} has invalid syntax.`);
	return value;
}

function bounded(value: string, name: string, maxBytes: number): string {
	if (!value.trim() || Buffer.byteLength(value) > maxBytes) {
		throw new AgentBindError("invalid_request", `${name} must be a non-empty string of at most ${maxBytes} bytes.`);
	}
	return value;
}
