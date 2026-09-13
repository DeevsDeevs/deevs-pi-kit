import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type {
	HostedAgentBind,
	HostedAgentSessionIdentity,
	HostedAgentTarget,
	HostedCollaboratorProfile,
	HostedHerdrLocator,
	HostedNativeCollaboratorDriver,
} from "../hosted-types.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type HostedLiveRegistration } from "./registration.ts";
import { deriveAgentTargetKey, deriveParticipantKey, HostedStateStore } from "./state.ts";
import { isProjectWorktree } from "./worktree.ts";

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class AgentBindError extends Error {
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
	clientGeneration: string;
	protocol: string;
	participantId: string;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	expectedParticipantGeneration?: string;
}

export interface BoundAgentResult {
	registration: HostedLiveRegistration;
	targetKey: string;
	participantKey: string;
	holderGeneration: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	agentSession: HostedAgentSessionIdentity;
	projectRoot: string;
	cwd: string;
}

/** The validated identifiers a bind request carries, parsed once before any target is built. */
interface BoundAgentNames {
	agentName: string;
	protocol: string;
	participantId: string;
	clientGeneration: string;
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
		if (callerTarget?.kind !== "pi") {
			throw new AgentBindError("conflict", "Only an authenticated Pi target may bind a Herdr agent collaborator.");
		}
		const projectRoot = realpathSync(callerTarget.projectRoot);
		const names = boundAgentNames(input);
		const verified = await this.host.getAgent(names.agentName);
		const cwd = agentCwd(verified);
		const worktreePath = cwd === projectRoot ? undefined : cwd;
		if (worktreePath !== undefined && !await isWritableWorktree(worktreePath, projectRoot, input.profile)) {
			throw new AgentBindError("identity_mismatch", "Herdr agent cwd is neither the project root nor a workspace-write worktree of it.");
		}
		const target = this.agentTarget(projectRoot, names, input, verified, worktreePath);
		this.store.apply({ type: "agent.bind", bind: this.bindRecord(caller, input, names, target) });
		const registration = this.registrations.registerAgent(target, verified);
		return {
			registration,
			targetKey: target.targetKey,
			participantKey: target.participantKey,
			holderGeneration: target.holderGeneration,
			driver: target.driver,
			profile: target.profile,
			agentSession: target.agentSession,
			projectRoot,
			cwd,
		};
	}

	private agentTarget(
		projectRoot: string,
		names: BoundAgentNames,
		input: BindAgentInput,
		verified: HostedLiveAgent,
		worktreePath: string | undefined,
	): HostedAgentTarget {
		const herdr = startedAgentLocator(verified, names.agentName, input.driver);
		const targetKey = deriveAgentTargetKey(projectRoot, names.agentName);
		const existing = this.store.read().targets[targetKey];
		if (existing !== undefined && existing.kind !== "agent") {
			throw new AgentBindError("conflict", "Herdr agent target key already belongs to another target kind.");
		}
		const target: HostedAgentTarget = {
			kind: "agent",
			targetKey,
			projectRoot,
			agentName: names.agentName,
			driver: input.driver,
			agentSession: verified.agentSession,
			participantKey: deriveParticipantKey(projectRoot, names.protocol, names.participantId),
			holderGeneration: existing?.holderGeneration ?? this.options.createGeneration?.() ?? `lease_${randomUUID()}`,
			profile: input.profile,
			clientGeneration: names.clientGeneration,
			herdr,
			createdAt: existing?.createdAt ?? this.now(),
		};
		if (worktreePath) target.worktreePath = worktreePath;
		return target;
	}

	private bindRecord(
		caller: HostedLiveRegistration,
		input: BindAgentInput,
		names: BoundAgentNames,
		target: HostedAgentTarget,
	): HostedAgentBind {
		const bind: HostedAgentBind = {
			target,
			protocol: names.protocol,
			participantId: names.participantId,
			callerTargetKey: caller.targetKey,
			callerParticipantKey: bounded(input.callerParticipantKey, "caller participant key", 200),
			callerGeneration: bounded(input.expectedCallerGeneration, "caller generation", 200),
			at: this.now(),
		};
		const expected = input.expectedParticipantGeneration;
		if (expected !== undefined) bind.expectedParticipantGeneration = bounded(expected, "expected participant generation", 200);
		return bind;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function boundAgentNames(input: BindAgentInput): BoundAgentNames {
	return {
		agentName: boundedName(input.agentName, AGENT_NAME, "Herdr agent name"),
		protocol: boundedName(input.protocol, NAME, "protocol"),
		participantId: boundedName(input.participantId, NAME, "participant ID"),
		clientGeneration: bounded(input.clientGeneration, "client generation", 200),
	};
}

function startedAgentLocator(agent: HostedLiveAgent, agentName: string, driver: HostedNativeCollaboratorDriver): HostedHerdrLocator {
	if (agent.name !== agentName) throw new AgentBindError("identity_mismatch", "Herdr resolved another agent name.");
	const expected = driver === "claude-code" ? "claude" : "codex";
	if (agent.agentSession.agent !== expected || agent.agentSession.source !== `herdr:${expected}`) {
		throw new AgentBindError("identity_mismatch", "Herdr does not report the requested interactive agent kind.");
	}
	if (!agent.tabId || !agent.workspaceId) {
		throw new AgentBindError("identity_mismatch", "Herdr agent has no exact tab and workspace identity.");
	}
	return { paneId: agent.paneId, terminalId: agent.terminalId, tabId: agent.tabId, workspaceId: agent.workspaceId };
}

async function isWritableWorktree(worktreePath: string, projectRoot: string, profile: HostedCollaboratorProfile): Promise<boolean> {
	if (profile !== "workspace-write") return false;
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
