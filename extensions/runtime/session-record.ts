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
	StartedCollaboratorSchema,
	type CollaboratorLaunch,
	type CollaboratorWorktree,
	type ManagedAgentControl,
	type ParticipantIdentity,
	type StartedCollaborator,
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
	started?: StartedCollaborator[];
}

/** Reads and writes the single hidden session entry that carries this Pi session's Runtime state; anything unreadable is dropped, never trusted. */
export class HostedSessionStore {
	private readonly pi: ExtensionAPI;
	identity?: ParticipantIdentity;
	launch?: CollaboratorLaunch;
	worktree?: CollaboratorWorktree;
	readonly agents = new Map<string, ManagedAgentControl>();
	/** The collaborators this lead started, by name: what a stood-down one resumes with, and the tab a stand-down closes. */
	readonly started = new Map<string, StartedCollaborator>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	agent(targetKey: string): ManagedAgentControl | undefined {
		return this.agents.get(targetKey);
	}

	restore(ctx: ExtensionContext): void {
		let data: RestoredSessionData;
		for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === HOSTED_SESSION_ENTRY) data = entry.data;
		const record = asRecord(data);
		this.identity = Value.Check(ParticipantIdentitySchema, record?.participant) ? record.participant : envIdentity(process.env[COLLABORATOR_ENV]);
		this.launch = record?.launch === undefined ? undefined : parseLaunch(record.launch) ?? RECOVERY_LAUNCH;
		this.worktree = parseWorktree(record?.worktree, ctx);
		this.agents.clear();
		const agents = Array.isArray(record?.agents) ? record.agents : [];
		for (const control of agents) if (Value.Check(ManagedAgentControlSchema, control) && ownedBy(control, ctx)) this.agents.set(control.targetKey, control);
		this.started.clear();
		const started = Array.isArray(record?.started) ? record.started : [];
		for (const spec of started) if (Value.Check(StartedCollaboratorSchema, spec)) this.started.set(spec.participantId, spec);
	}

	persistIdentity(identity: ParticipantIdentity): void {
		this.identity = identity;
		this.persist();
	}

	persistStarted(spec: StartedCollaborator): void {
		this.started.set(spec.participantId, spec);
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
		this.agents.set(control.targetKey, control);
		this.persist();
	}

	forgetAgent(targetKey: string): void {
		if (!this.agents.delete(targetKey)) return;
		this.persist();
	}

	private persist(): void {
		const record: HostedSessionRecord = { version: 3, participant: this.identity, launch: this.launch, worktree: this.worktree };
		if (this.agents.size > 0) record.agents = [...this.agents.values()];
		if (this.started.size > 0) record.started = [...this.started.values()];
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
