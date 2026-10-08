import { Type, type Static } from "typebox";
import { HashText, IdText, ModelText, ParticipantNameText, PathText, STRICT_OBJECT, boundedText } from "./common.ts";
import { HostedCollaboratorProfileSchema, HostedNativeCollaboratorDriverSchema, HostedParticipantStateSchema } from "./state.ts";

/** The name a session holds: its protocol and participant ID, and the key and generation Runtime last gave it. */
export const ParticipantIdentitySchema = Type.Object({
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	participantKey: Type.Optional(IdText),
	generation: Type.Optional(IdText),
	disposition: HostedParticipantStateSchema,
}, STRICT_OBJECT);

const CollaboratorPersonaSchema = Type.Object({
	name: boundedText(64),
	prompt: boundedText(64 * 1024),
	promptHash: HashText,
}, STRICT_OBJECT);

export const CollaboratorLaunchSchema = Type.Object({
	driver: Type.Literal("pi"),
	model: Type.Optional(ModelText),
	profile: Type.Optional(HostedCollaboratorProfileSchema),
	persona: Type.Optional(CollaboratorPersonaSchema),
}, STRICT_OBJECT);

/** A collaborator this lead started: its start spec, its tab, and the native session a Claude or Codex one resumes. */
export const StartedCollaboratorSchema = Type.Object({
	participantId: ParticipantNameText,
	model: Type.Optional(boundedText(200)),
	persona: Type.Optional(boundedText(64)),
	profile: Type.Optional(HostedCollaboratorProfileSchema),
	repo: Type.Optional(PathText),
	tabId: Type.Optional(IdText),
	nativeSession: Type.Optional(IdText),
}, STRICT_OBJECT);

export const CollaboratorWorktreeSchema = Type.Object({
	projectRoot: PathText,
	repo: Type.Optional(PathText),
	worktreePath: Type.Optional(PathText),
}, STRICT_OBJECT);

export const ManagedAgentSessionSchema = Type.Object({
	source: IdText,
	agent: boundedText(64),
	kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
	value: PathText,
}, STRICT_OBJECT);

const ManagedAgentOwnerSchema = Type.Object({
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
export type StartedCollaborator = Static<typeof StartedCollaboratorSchema>;
export type CollaboratorWorktree = Static<typeof CollaboratorWorktreeSchema>;
export type ManagedAgentSession = Static<typeof ManagedAgentSessionSchema>;
export type ManagedAgentControl = Static<typeof ManagedAgentControlSchema>;
