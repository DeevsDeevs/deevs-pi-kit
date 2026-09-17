import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { CustomEntry, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord, type RestoredSessionData } from "./responses.ts";
import { PARTICIPANT_NAME } from "./schemas/common.ts";
import type { JsonObject } from "./schemas/json.ts";
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

/** `<protocol>:<participantId>[:revive]`, each name in the package-wide participant syntax. */
const name = PARTICIPANT_NAME.source.slice(1, -1);
const BOOTSTRAP_IDENTITY = new RegExp(`^(${name}):(${name})(:revive)?$`);

/** One current-only hidden entry kind; older kinds are ignored rather than migrated. */
export const HOSTED_SESSION_ENTRY = "deevs.hosted-runtime.v3";
export const COLLABORATOR_ENV = "PI_RUNTIME_COLLABORATE";

/** Everything one Pi session persists about its Runtime collaboration, in one entry. */
export interface HostedSessionRecord {
	version: 3;
	participant?: ParticipantIdentity;
	launch?: CollaboratorLaunch;
	worktree?: CollaboratorWorktree;
	agents?: ManagedAgentControl[];
	/** Set by `/runtime auto on`: lifecycle changes in this project run without a confirmation dialog. */
	auto?: true;
}

/** The validated state one Pi session resumes from; anything unreadable is reported, never trusted. */
interface RestoredRuntimeState {
	identity?: ParticipantIdentity;
	launch?: CollaboratorLaunch;
	worktree?: CollaboratorWorktree;
	agents: ManagedAgentControl[];
	auto: boolean;
}

const RECOVERY_LAUNCH: CollaboratorLaunch = { driver: "pi", profile: "read-only" };
const INVALID_RECORD = "Persisted Runtime collaboration state is invalid; stale authority and environment bootstrap were ignored.";
const INVALID_IDENTITY = "Persisted collaborator identity is invalid; stale authority and environment bootstrap were ignored.";
const INVALID_LAUNCH = "Collaborator launch metadata is invalid; enforced read-only recovery mode using Pi.";
const INVALID_AGENTS = "Persisted managed collaborator control is invalid; affected reconnection authority requires attention.";

export function restoreSessionRecord(ctx: ExtensionContext): RestoredRuntimeState {
	const entry = lastSessionRecord(ctx);
	if (!entry) return { identity: bootstrapIdentity(process.env[COLLABORATOR_ENV]), agents: [], auto: false };
	const record = asRecord(entry.data);
	if (record?.version !== 3) {
		ctx.ui.notify(INVALID_RECORD, "warning");
		return { launch: RECOVERY_LAUNCH, agents: [], auto: false };
	}
	return {
		identity: restoreIdentity(record, ctx),
		launch: restoreLaunch(record, ctx),
		worktree: parseWorktree(record.worktree, ctx),
		agents: restoreAgents(record, ctx),
		auto: record.auto === true,
	};
}

function restoreIdentity(record: JsonObject, ctx: ExtensionContext): ParticipantIdentity | undefined {
	if (record.participant === undefined) return bootstrapIdentity(process.env[COLLABORATOR_ENV]);
	const identity = parseIdentity(record.participant);
	if (!identity) ctx.ui.notify(INVALID_IDENTITY, "warning");
	return identity;
}

function restoreLaunch(record: JsonObject, ctx: ExtensionContext): CollaboratorLaunch | undefined {
	if (record.launch === undefined) return undefined;
	const launch = parseLaunch(record.launch);
	if (launch) return launch;
	ctx.ui.notify(INVALID_LAUNCH, "warning");
	return RECOVERY_LAUNCH;
}

function restoreAgents(record: JsonObject, ctx: ExtensionContext): ManagedAgentControl[] {
	if (record.agents === undefined) return [];
	const controls = parseAgents(record.agents, ctx);
	if (!controls.malformed) return controls.accepted;
	ctx.ui.notify(INVALID_AGENTS, "warning");
	// One unreadable control makes every restored reconnection authority suspect.
	return controls.accepted.map((control) => ({ ...control, state: "needs_attention" }));
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
	const match = BOOTSTRAP_IDENTITY.exec(value);
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
