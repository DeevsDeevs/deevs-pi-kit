import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { Value } from "typebox/value";
import type { CustomEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord, type RestoredSessionData, type SerializedObject } from "./responses.ts";
import {
	CollaboratorLaunchSchema,
	CollaboratorWorktreeSchema,
	ManagedAgentControlSchema,
	ParticipantIdentitySchema,
	type CollaboratorLaunch,
	type CollaboratorWorktree,
	type ManagedAgentControl,
	type ManagedAgentOwner,
	type ParticipantIdentity,
} from "./schemas/session.ts";

export type {
	CollaboratorLaunch,
	CollaboratorPersona,
	ManagedAgentControl,
	ManagedAgentSession,
	ParticipantIdentity,
} from "./schemas/session.ts";

/** One current-only hidden entry kind; older kinds are ignored rather than migrated. */
export const HOSTED_SESSION_ENTRY = "deevs.hosted-runtime.v2";
export const COLLABORATOR_ENV = "PI_RUNTIME_COLLABORATE";
export const COLLABORATOR_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const COLLABORATOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/*:-]{0,199}$/;

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
	if (!Value.Check(ParticipantIdentitySchema, value)) return undefined;
	// Revive authorization is one-shot: it is granted by the environment, never replayed from session history.
	const identity: ParticipantIdentity = {
		protocol: value.protocol,
		participantId: value.participantId,
		disposition: value.disposition,
	};
	if (value.participantKey) identity.participantKey = value.participantKey;
	if (value.generation) identity.generation = value.generation;
	return identity;
}

function parseLaunch(value: RestoredSessionData): CollaboratorLaunch | undefined {
	if (!Value.Check(CollaboratorLaunchSchema, value)) return undefined;
	const persona = value.persona;
	if (!persona) return value;
	if (value.profile === undefined) return undefined;
	return createHash("sha256").update(persona.prompt).digest("hex") === persona.promptHash ? value : undefined;
}

function parseWorktree(value: RestoredSessionData, ctx: ExtensionContext): CollaboratorWorktree | undefined {
	if (!Value.Check(CollaboratorWorktreeSchema, value)) return undefined;
	try {
		const worktreePath = realpathSync(value.worktreePath);
		const projectRoot = realpathSync(value.projectRoot);
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

function parseAgentControl(value: RestoredSessionData, ctx: ExtensionContext): ManagedAgentControl | undefined {
	if (!Value.Check(ManagedAgentControlSchema, value)) return undefined;
	return ownedByThisSession(value.owner, ctx) ? value : undefined;
}

function ownedByThisSession(owner: ManagedAgentOwner, ctx: ExtensionContext): boolean {
	return owner.sessionId === ctx.sessionManager.getSessionId()
		&& owner.sessionFile === ctx.sessionManager.getSessionFile()
		&& owner.cwd === ctx.cwd;
}
