import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asRecord, type ClientParticipantStatus, type RestoredSessionData } from "./responses.ts";
import { PARTICIPANT_NAME } from "./schemas/common.ts";
import {
	CollaboratorLaunchSchema,
	CollaboratorWorktreeSchema,
	ManagedAgentControlSchema,
	ParticipantIdentitySchema,
	type CollaboratorLaunch,
	type CollaboratorWorktree,
	type ManagedAgentControl,
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
export const HOSTED_SESSION_ENTRY = "deevs.hosted-runtime.v3";
/** `<protocol>:<participantId>`: the name a Pi collaborator's tab tells it to hold. */
export const COLLABORATOR_ENV = "PI_RUNTIME_COLLABORATE";

const name = PARTICIPANT_NAME.source.slice(1, -1);
const ENV_IDENTITY = new RegExp(`^(${name}):(${name})$`);
/** A collaborator session whose launch record is unreadable runs read-only. */
const RECOVERY_LAUNCH: CollaboratorLaunch = { driver: "pi", profile: "read-only" };

/** Everything one Pi session persists about its Runtime collaboration, in one entry. */
export interface HostedSessionRecord {
	version: 3;
	participant?: ParticipantIdentity;
	launch?: CollaboratorLaunch;
	worktree?: CollaboratorWorktree;
	agents?: ManagedAgentControl[];
}

/** Reads and writes the single hidden session entry that carries this Pi session's Runtime state; anything unreadable is dropped, never trusted. */
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
		let data: RestoredSessionData;
		for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === HOSTED_SESSION_ENTRY) data = entry.data;
		const record = asRecord(data);
		this.identityState = Value.Check(ParticipantIdentitySchema, record?.participant) ? record.participant : envIdentity(process.env[COLLABORATOR_ENV]);
		this.launchState = record?.launch === undefined ? undefined : parseLaunch(record.launch) ?? RECOVERY_LAUNCH;
		this.worktreeState = parseWorktree(record?.worktree, ctx);
		this.agentControls.clear();
		const agents = Array.isArray(record?.agents) ? record.agents : [];
		for (const control of agents) if (Value.Check(ManagedAgentControlSchema, control) && ownedBy(control, ctx)) this.agentControls.set(control.targetKey, control);
	}

	persistIdentity(identity: ParticipantIdentity): void {
		this.identityState = identity;
		this.persist();
	}

	persistHeld(protocol: string, participantId: string, participant: ClientParticipantStatus): void {
		this.persistIdentity({
			protocol,
			participantId,
			participantKey: participant.participantKey,
			generation: participant.generation,
			disposition: "held",
		});
	}

	persistAgent(control: ManagedAgentControl): void {
		this.agentControls.set(control.targetKey, control);
		this.persist();
	}

	forgetAgent(targetKey: string): void {
		if (!this.agentControls.delete(targetKey)) return;
		this.persist();
	}

	private persist(): void {
		const record: HostedSessionRecord = { version: 3 };
		if (this.identityState) record.participant = this.identityState;
		if (this.launchState) record.launch = this.launchState;
		if (this.worktreeState) record.worktree = this.worktreeState;
		if (this.agentControls.size > 0) record.agents = [...this.agentControls.values()];
		this.pi.appendEntry(HOSTED_SESSION_ENTRY, record);
	}
}

function envIdentity(value: string | undefined): ParticipantIdentity | undefined {
	const match = value ? ENV_IDENTITY.exec(value) : undefined;
	return match?.[1] && match[2] ? { protocol: match[1], participantId: match[2], disposition: "held" } : undefined;
}

function parseLaunch(value: RestoredSessionData): CollaboratorLaunch | undefined {
	if (!Value.Check(CollaboratorLaunchSchema, value)) return undefined;
	const persona = value.persona;
	if (!persona) return value;
	if (value.profile === undefined) return undefined;
	return createHash("sha256").update(persona.prompt).digest("hex") === persona.promptHash ? value : undefined;
}

/** The record is trusted only while this session still sits where it says: in its worktree, or in its repo without one. */
function parseWorktree(value: RestoredSessionData, ctx: ExtensionContext): CollaboratorWorktree | undefined {
	if (!Value.Check(CollaboratorWorktreeSchema, value)) return undefined;
	try {
		const projectRoot = realpathSync(value.projectRoot);
		const cwd = realpathSync(ctx.cwd);
		const worktreePath = value.worktreePath === undefined ? undefined : realpathSync(value.worktreePath);
		const expected = worktreePath ?? (value.repo === undefined ? undefined : realpathSync(join(projectRoot, value.repo)));
		if (expected === undefined || cwd !== expected || cwd === projectRoot) return undefined;
		const worktree: CollaboratorWorktree = { projectRoot };
		if (value.repo !== undefined) worktree.repo = value.repo;
		if (worktreePath !== undefined) worktree.worktreePath = worktreePath;
		return worktree;
	} catch {
		return undefined;
	}
}

function ownedBy(control: ManagedAgentControl, ctx: ExtensionContext): boolean {
	return control.owner.sessionId === ctx.sessionManager.getSessionId()
		&& control.owner.sessionFile === ctx.sessionManager.getSessionFile()
		&& control.owner.cwd === ctx.cwd;
}
