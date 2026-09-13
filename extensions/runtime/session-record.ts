import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "./hosted-types.ts";
import { asRecord, isStringValue, type RestoredSessionData, type SerializedObject } from "./responses.ts";

/** One current-only hidden entry kind; older kinds are ignored rather than migrated. */
export const HOSTED_SESSION_ENTRY = "deevs.hosted-runtime.v2";
export const COLLABORATOR_ENV = "PI_RUNTIME_COLLABORATE";
export const COLLABORATOR_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const COLLABORATOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/*:-]{0,199}$/;

export interface ParticipantIdentity {
	protocol: string;
	participantId: string;
	participantKey?: string;
	generation?: string;
	disposition: "held" | "vacant" | "ended";
	reviveAuthorized?: true;
}

export interface CollaboratorPersona {
	name: string;
	prompt: string;
	promptHash: string;
}

export interface CollaboratorLaunch {
	driver: "pi";
	model?: string;
	profile?: HostedCollaboratorProfile;
	persona?: CollaboratorPersona;
}

interface CollaboratorWorktree {
	projectRoot: string;
	worktreePath: string;
}

interface ManagedAgentOwner {
	sessionId: string;
	sessionFile: string;
	cwd: string;
}

export interface ManagedAgentSession {
	source: string;
	agent: string;
	kind: "id" | "path";
	value: string;
}

export interface ManagedAgentControl {
	owner: ManagedAgentOwner;
	projectRoot: string;
	cwd: string;
	agentName: string;
	targetKey: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	protocol: string;
	participantId: string;
	clientGeneration: string;
	holderGeneration: string;
	paneId: string;
	terminalId: string;
	agentSession: ManagedAgentSession;
	messagingConfigured?: true;
	state: "active" | "needs_attention" | "stopped";
}

/** Everything one Pi session persists about its Runtime collaboration, in one entry. */
export interface HostedSessionRecord {
	version: 2;
	participant?: ParticipantIdentity;
	launch?: CollaboratorLaunch;
	worktree?: CollaboratorWorktree;
	agents?: ManagedAgentControl[];
}

const RECOVERY_LAUNCH: CollaboratorLaunch = { driver: "pi", profile: "read-only" };
const INVALID_RECORD = "Persisted Runtime collaboration state is invalid; stale authority and environment bootstrap were ignored.";
const INVALID_IDENTITY = "Persisted collaborator identity is invalid; stale authority and environment bootstrap were ignored.";
const INVALID_LAUNCH = "Collaborator launch metadata is invalid; enforced read-only recovery mode using Pi.";
const INVALID_AGENTS = "Persisted managed collaborator control is invalid; affected reconnection authority requires attention.";

/** Reads and writes the single hidden session entry that carries this Pi session's Runtime state. */
export class HostedSessionStore {
	private readonly pi: ExtensionAPI;
	private identityState?: ParticipantIdentity;
	private launchState?: CollaboratorLaunch;
	private worktreeState?: CollaboratorWorktree;
	private readonly agentControls = new Map<string, ManagedAgentControl>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get identity(): ParticipantIdentity | undefined {
		return this.identityState;
	}

	get launch(): CollaboratorLaunch | undefined {
		return this.launchState;
	}

	get worktree(): CollaboratorWorktree | undefined {
		return this.worktreeState;
	}

	get agents(): ReadonlyMap<string, ManagedAgentControl> {
		return this.agentControls;
	}

	agent(targetKey: string): ManagedAgentControl | undefined {
		return this.agentControls.get(targetKey);
	}

	restore(ctx: ExtensionContext): void {
		this.identityState = undefined;
		this.launchState = undefined;
		this.worktreeState = undefined;
		this.agentControls.clear();
		const entry = lastSessionRecord(ctx);
		if (!entry) {
			this.identityState = bootstrapIdentity(process.env[COLLABORATOR_ENV]);
			return;
		}
		const record = asRecord(entry.data);
		if (record?.version !== 2) {
			this.launchState = RECOVERY_LAUNCH;
			ctx.ui.notify(INVALID_RECORD, "warning");
			return;
		}
		this.restoreIdentity(record, ctx);
		this.restoreLaunch(record, ctx);
		this.worktreeState = parseWorktree(record.worktree, ctx);
		this.restoreAgents(record, ctx);
	}

	persistIdentity(identity: ParticipantIdentity): void {
		this.identityState = identity;
		this.persist();
	}

	persistAgent(control: ManagedAgentControl): void {
		this.agentControls.set(control.targetKey, control);
		this.persist();
	}

	private restoreIdentity(record: SerializedObject, ctx: ExtensionContext): void {
		if (record.participant === undefined) {
			this.identityState = bootstrapIdentity(process.env[COLLABORATOR_ENV]);
			return;
		}
		this.identityState = parseIdentity(record.participant);
		if (!this.identityState) ctx.ui.notify(INVALID_IDENTITY, "warning");
	}

	private restoreLaunch(record: SerializedObject, ctx: ExtensionContext): void {
		if (record.launch === undefined) return;
		this.launchState = parseLaunch(record.launch);
		if (this.launchState) return;
		this.launchState = RECOVERY_LAUNCH;
		ctx.ui.notify(INVALID_LAUNCH, "warning");
	}

	private restoreAgents(record: SerializedObject, ctx: ExtensionContext): void {
		if (record.agents === undefined) return;
		const controls = parseAgents(record.agents, ctx);
		for (const control of controls.accepted) this.agentControls.set(control.targetKey, control);
		if (!controls.malformed) return;
		// One unreadable control makes every restored reconnection authority suspect.
		for (const [targetKey, control] of this.agentControls) this.agentControls.set(targetKey, { ...control, state: "needs_attention" });
		ctx.ui.notify(INVALID_AGENTS, "warning");
	}

	private persist(): void {
		const record: HostedSessionRecord = { version: 2 };
		if (this.identityState) record.participant = this.identityState;
		if (this.launchState) record.launch = this.launchState;
		if (this.worktreeState) record.worktree = this.worktreeState;
		if (this.agentControls.size > 0) record.agents = [...this.agentControls.values()];
		this.pi.appendEntry(HOSTED_SESSION_ENTRY, record);
	}
}

function lastSessionRecord(ctx: ExtensionContext): CustomEntry | undefined {
	const entries: readonly SessionEntry[] = ctx.sessionManager.getBranch();
	let latest: CustomEntry | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === HOSTED_SESSION_ENTRY) latest = entry;
	}
	return latest;
}

function bootstrapIdentity(value: string | undefined): ParticipantIdentity | undefined {
	if (!value) return undefined;
	const match = /^([a-z][a-z0-9_-]{0,63}):([a-z][a-z0-9_-]{0,63})(:revive)?$/.exec(value);
	if (!match) return undefined;
	const [, protocol, participantId, revive] = match;
	if (!protocol || !participantId) return undefined;
	const identity: ParticipantIdentity = { protocol, participantId, disposition: "held" };
	if (revive) identity.reviveAuthorized = true;
	return identity;
}

function parseIdentity(value: RestoredSessionData): ParticipantIdentity | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (record.disposition !== "held" && record.disposition !== "vacant" && record.disposition !== "ended") return undefined;
	if (!isStringValue(record.protocol) || !isStringValue(record.participantId)) return undefined;
	const identity: ParticipantIdentity = {
		protocol: record.protocol,
		participantId: record.participantId,
		disposition: record.disposition,
	};
	if (isStringValue(record.participantKey)) identity.participantKey = record.participantKey;
	if (isStringValue(record.generation)) identity.generation = record.generation;
	return identity;
}

const LAUNCH_KEYS = new Set(["driver", "model", "profile", "persona"]);

function parseLaunch(value: RestoredSessionData): CollaboratorLaunch | undefined {
	const record = asRecord(value);
	if (!record || Object.keys(record).some((key) => !LAUNCH_KEYS.has(key))) return undefined;
	if (record.driver !== "pi") return undefined;
	if (record.model !== undefined && (!isStringValue(record.model) || !COLLABORATOR_MODEL.test(record.model))) return undefined;
	if (record.profile !== undefined && record.profile !== "read-only" && record.profile !== "workspace-write") return undefined;
	const launch: CollaboratorLaunch = { driver: "pi" };
	if (isStringValue(record.model)) launch.model = record.model;
	if (record.profile === "read-only" || record.profile === "workspace-write") launch.profile = record.profile;
	if (record.persona === undefined) return launch;
	const persona = parsePersona(record.persona);
	if (!persona || launch.profile === undefined) return undefined;
	launch.persona = persona;
	return launch;
}

function parsePersona(value: RestoredSessionData): CollaboratorPersona | undefined {
	const record = asRecord(value);
	if (!record || !isStringValue(record.name) || !isStringValue(record.prompt) || !isStringValue(record.promptHash)) return undefined;
	if (createHash("sha256").update(record.prompt).digest("hex") !== record.promptHash) return undefined;
	return { name: record.name, prompt: record.prompt, promptHash: record.promptHash };
}

function parseWorktree(value: RestoredSessionData, ctx: ExtensionContext): CollaboratorWorktree | undefined {
	const record = asRecord(value);
	if (!record || !isStringValue(record.projectRoot) || !isStringValue(record.worktreePath)) return undefined;
	try {
		const worktreePath = realpathSync(record.worktreePath);
		const projectRoot = realpathSync(record.projectRoot);
		if (worktreePath !== realpathSync(ctx.cwd) || worktreePath === projectRoot) return undefined;
		return { projectRoot, worktreePath };
	} catch {
		return undefined;
	}
}

interface RestoredAgentControls {
	accepted: ManagedAgentControl[];
	malformed: boolean;
}

function parseAgents(value: RestoredSessionData, ctx: ExtensionContext): RestoredAgentControls {
	if (!Array.isArray(value)) return { accepted: [], malformed: true };
	const accepted: ManagedAgentControl[] = [];
	let malformed = false;
	for (const item of value) {
		const control = parseAgentControl(item, ctx);
		if (control) accepted.push(control);
		else malformed = true;
	}
	return { accepted, malformed };
}

const CONTROL_KEYS = new Set([
	"owner", "projectRoot", "cwd", "agentName", "targetKey", "driver", "profile", "protocol", "participantId",
	"clientGeneration", "holderGeneration", "paneId", "terminalId", "agentSession", "messagingConfigured", "state",
]);
const OWNER_KEYS = new Set(["sessionId", "sessionFile", "cwd"]);
const SESSION_KEYS = new Set(["source", "agent", "kind", "value"]);

function parseAgentControl(value: RestoredSessionData, ctx: ExtensionContext): ManagedAgentControl | undefined {
	const record = asRecord(value);
	if (!record || Object.keys(record).some((key) => !CONTROL_KEYS.has(key))) return undefined;
	const owner = parseOwner(record.owner, ctx);
	const agentSession = parseAgentSession(record.agentSession);
	if (!owner || !agentSession) return undefined;
	if (!isStringValue(record.projectRoot) || !isStringValue(record.cwd)) return undefined;
	if (!isStringValue(record.agentName) || !isStringValue(record.targetKey)) return undefined;
	if (!isStringValue(record.clientGeneration) || !isStringValue(record.holderGeneration)) return undefined;
	if (!isStringValue(record.paneId) || !isStringValue(record.terminalId)) return undefined;
	if (record.driver !== "claude-code" && record.driver !== "codex") return undefined;
	if (record.profile !== "read-only" && record.profile !== "workspace-write") return undefined;
	if (!isStringValue(record.protocol) || !COLLABORATOR_NAME.test(record.protocol)) return undefined;
	if (!isStringValue(record.participantId) || !COLLABORATOR_NAME.test(record.participantId)) return undefined;
	if (record.state !== "active" && record.state !== "needs_attention" && record.state !== "stopped") return undefined;
	if (record.messagingConfigured !== undefined && record.messagingConfigured !== true) return undefined;
	const control: ManagedAgentControl = {
		owner,
		projectRoot: record.projectRoot,
		cwd: record.cwd,
		agentName: record.agentName,
		targetKey: record.targetKey,
		driver: record.driver,
		profile: record.profile,
		protocol: record.protocol,
		participantId: record.participantId,
		clientGeneration: record.clientGeneration,
		holderGeneration: record.holderGeneration,
		paneId: record.paneId,
		terminalId: record.terminalId,
		agentSession,
		state: record.state,
	};
	if (record.messagingConfigured) control.messagingConfigured = true;
	return control;
}

function parseOwner(value: RestoredSessionData, ctx: ExtensionContext): ManagedAgentOwner | undefined {
	const owner = asRecord(value);
	if (!owner || Object.keys(owner).some((key) => !OWNER_KEYS.has(key))) return undefined;
	if (!isStringValue(owner.sessionId) || !isStringValue(owner.sessionFile) || !isStringValue(owner.cwd)) return undefined;
	if (owner.sessionId !== ctx.sessionManager.getSessionId() || owner.sessionFile !== ctx.sessionManager.getSessionFile()) return undefined;
	if (owner.cwd !== ctx.cwd) return undefined;
	return { sessionId: owner.sessionId, sessionFile: owner.sessionFile, cwd: owner.cwd };
}

function parseAgentSession(value: RestoredSessionData): ManagedAgentSession | undefined {
	const session = asRecord(value);
	if (!session || Object.keys(session).some((key) => !SESSION_KEYS.has(key))) return undefined;
	if (!isStringValue(session.source) || !isStringValue(session.agent) || !isStringValue(session.value)) return undefined;
	if (session.kind !== "id" && session.kind !== "path") return undefined;
	return { source: session.source, agent: session.agent, kind: session.kind, value: session.value };
}

export function sameAgentSession(left: ManagedAgentSession, right: ManagedAgentSession): boolean {
	return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}
