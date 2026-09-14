import { Type, type Static } from "typebox";
import { HashText, IdText, ParticipantNameText, PathText, STRICT_OBJECT, boundedText } from "./common.ts";
import {
	HostedCollaboratorProfileSchema,
	HostedNativeCollaboratorDriverSchema,
	HostedParticipantStateSchema,
} from "./state.ts";

/** Restored identity never carries revive authorization: that comes from the environment, once. */
export const ParticipantIdentitySchema = Type.Object({
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	participantKey: Type.Optional(IdText),
	generation: Type.Optional(IdText),
	disposition: HostedParticipantStateSchema,
	reviveAuthorized: Type.Optional(Type.Literal(true)),
}, STRICT_OBJECT);

/** Bounded durable dedupe for at-least-once Runtime delivery: the oldest ID is pruned first. */
export const HOSTED_ADMITTED_EVENT_LIMIT = 1_000;

export const AdmittedEventIdsSchema = Type.Array(IdText, { maxItems: HOSTED_ADMITTED_EVENT_LIMIT });

export const CollaboratorPersonaSchema = Type.Object({
	name: boundedText(64),
	prompt: boundedText(64 * 1024),
	promptHash: HashText,
}, STRICT_OBJECT);

export const CollaboratorLaunchSchema = Type.Object({
	driver: Type.Literal("pi"),
	model: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._/*:-]{0,199}$" })),
	profile: Type.Optional(HostedCollaboratorProfileSchema),
	persona: Type.Optional(CollaboratorPersonaSchema),
}, STRICT_OBJECT);

export const CollaboratorWorktreeSchema = Type.Object({
	projectRoot: PathText,
	worktreePath: PathText,
}, STRICT_OBJECT);

export const ManagedAgentSessionSchema = Type.Object({
	source: IdText,
	agent: boundedText(64),
	kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
	value: PathText,
}, STRICT_OBJECT);

export const ManagedAgentOwnerSchema = Type.Object({
	sessionId: IdText,
	sessionFile: PathText,
	cwd: PathText,
}, STRICT_OBJECT);

export const ManagedAgentControlSchema = Type.Object({
	owner: ManagedAgentOwnerSchema,
	projectRoot: PathText,
	cwd: PathText,
	agentName: boundedText(64),
	targetKey: IdText,
	driver: HostedNativeCollaboratorDriverSchema,
	profile: HostedCollaboratorProfileSchema,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	holderGeneration: IdText,
	paneId: IdText,
	terminalId: IdText,
	agentSession: ManagedAgentSessionSchema,
	messagingConfigured: Type.Optional(Type.Literal(true)),
	state: Type.Union([Type.Literal("active"), Type.Literal("needs_attention"), Type.Literal("stopped")]),
}, STRICT_OBJECT);

export type ParticipantIdentity = Static<typeof ParticipantIdentitySchema>;
export type CollaboratorPersona = Static<typeof CollaboratorPersonaSchema>;
export type CollaboratorLaunch = Static<typeof CollaboratorLaunchSchema>;
export type CollaboratorWorktree = Static<typeof CollaboratorWorktreeSchema>;
export type ManagedAgentSession = Static<typeof ManagedAgentSessionSchema>;
export type ManagedAgentOwner = Static<typeof ManagedAgentOwnerSchema>;
export type ManagedAgentControl = Static<typeof ManagedAgentControlSchema>;
