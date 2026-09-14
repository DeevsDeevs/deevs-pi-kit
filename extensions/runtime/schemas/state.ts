import { Type, type Static } from "typebox";
import {
	AgentNameText,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HashText,
	IdText,
	ParticipantNameText,
	PathText,
	Sequence,
	STRICT_OBJECT,
	SummaryText,
	Timestamp,
	boundedText,
	keyedRecord,
} from "./common.ts";

export const HostedRuntimeInstanceSchema = Type.Object({
	version: Type.Literal(1),
	runtimeId: IdText,
}, STRICT_OBJECT);

export const HostedCollaboratorProfileSchema = Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write")]);
export const HostedNativeCollaboratorDriverSchema = Type.Union([Type.Literal("claude-code"), Type.Literal("codex")]);
export const HostedCollaboratorDriverSchema = Type.Union([
	Type.Literal("pi"),
	Type.Literal("claude-code"),
	Type.Literal("codex"),
]);

export const HostedHerdrLocatorSchema = Type.Object({
	tabId: IdText,
	workspaceId: IdText,
}, STRICT_OBJECT);

export const HostedPiTargetSchema = Type.Object({
	kind: Type.Literal("pi"),
	targetKey: IdText,
	projectRoot: PathText,
	piSessionId: IdText,
	piSessionFile: PathText,
	worktreePath: Type.Optional(PathText),
	createdAt: Timestamp,
}, STRICT_OBJECT);

export const HostedAgentTargetSchema = Type.Object({
	kind: Type.Literal("agent"),
	targetKey: IdText,
	projectRoot: PathText,
	agentName: AgentNameText,
	driver: HostedNativeCollaboratorDriverSchema,
	participantKey: IdText,
	holderGeneration: IdText,
	profile: HostedCollaboratorProfileSchema,
	herdr: HostedHerdrLocatorSchema,
	worktreePath: Type.Optional(PathText),
	createdAt: Timestamp,
}, STRICT_OBJECT);

export const HostedTargetSchema = Type.Union([HostedPiTargetSchema, HostedAgentTargetSchema]);

export const HostedParticipantTransitionSchema = Type.Object({
	cause: Type.Union([
		Type.Literal("acquire"),
		Type.Literal("reacquire"),
		Type.Literal("stand_down"),
		Type.Literal("release"),
		Type.Literal("takeover"),
		Type.Literal("revive"),
	]),
	previousGeneration: Type.Optional(IdText),
	previousHolderTargetKey: Type.Optional(IdText),
	at: Timestamp,
}, STRICT_OBJECT);

export const HostedParticipantStateSchema = Type.Union([
	Type.Literal("held"),
	Type.Literal("vacant"),
	Type.Literal("ended"),
]);

export const HostedParticipantSchema = Type.Object({
	participantKey: IdText,
	projectRoot: PathText,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	state: HostedParticipantStateSchema,
	generation: IdText,
	holderTargetKey: Type.Optional(IdText),
	worktreePath: Type.Optional(PathText),
	outSeq: keyedRecord(Sequence),
	transition: HostedParticipantTransitionSchema,
	createdAt: Timestamp,
	updatedAt: Timestamp,
}, STRICT_OBJECT);

export const HostedMailboxMessageEventSchema = Type.Object({
	version: Type.Literal(1),
	eventId: IdText,
	dedupeKey: PathText,
	type: Type.Literal("mailbox.message"),
	source: Type.Object({
		kind: Type.Literal("participant"),
		id: IdText,
		generation: IdText,
		sequence: Sequence,
	}, STRICT_OBJECT),
	recipientParticipantKey: IdText,
	sendId: IdText,
	body: boundedText(HOSTED_MAILBOX_MAX_BODY_BYTES),
	inReplyToEventId: Type.Optional(IdText),
	readAt: Type.Optional(Timestamp),
	createdAt: Timestamp,
	summary: SummaryText,
}, STRICT_OBJECT);

export const HostedMessagingGrantSchema = Type.Object({
	namespaceId: Type.String({ pattern: "^msg_[0-9a-f-]{36}$" }),
	secretDigest: HashText,
	participantKey: IdText,
	holderGeneration: IdText,
	targetKey: IdText,
	configurationHash: HashText,
	createdAt: Timestamp,
	expiresAt: Timestamp,
	status: Type.Union([Type.Literal("active"), Type.Literal("expired")]),
	/** Operation ID to published event ID; a repeated operation ID returns its original event. */
	operations: keyedRecord(IdText),
}, STRICT_OBJECT);

export const HOSTED_STATE_VERSION = 23;

export const HostedRuntimeStateSchema = Type.Object({
	version: Type.Literal(HOSTED_STATE_VERSION),
	messaging: keyedRecord(HostedMessagingGrantSchema),
	targets: keyedRecord(HostedTargetSchema),
	participants: keyedRecord(HostedParticipantSchema),
	events: keyedRecord(HostedMailboxMessageEventSchema),
	dedupe: keyedRecord(IdText),
}, STRICT_OBJECT);

export type HostedRuntimeInstance = Static<typeof HostedRuntimeInstanceSchema>;
export type HostedCollaboratorProfile = Static<typeof HostedCollaboratorProfileSchema>;
export type HostedNativeCollaboratorDriver = Static<typeof HostedNativeCollaboratorDriverSchema>;
export type HostedCollaboratorDriver = Static<typeof HostedCollaboratorDriverSchema>;
export type HostedHerdrLocator = Static<typeof HostedHerdrLocatorSchema>;
export type HostedPiTarget = Static<typeof HostedPiTargetSchema>;
export type HostedAgentTarget = Static<typeof HostedAgentTargetSchema>;
export type HostedTarget = Static<typeof HostedTargetSchema>;
export type HostedParticipantTransition = Static<typeof HostedParticipantTransitionSchema>;
export type HostedParticipantState = Static<typeof HostedParticipantStateSchema>;
export type HostedParticipant = Static<typeof HostedParticipantSchema>;
export type HostedMailboxMessageEvent = Static<typeof HostedMailboxMessageEventSchema>;
export type HostedMessagingGrant = Static<typeof HostedMessagingGrantSchema>;
export type HostedRuntimeState = Static<typeof HostedRuntimeStateSchema>;

export function isHeld(state: HostedParticipantState | undefined): boolean {
	return state === "held";
}

export function isVacant(state: HostedParticipantState | undefined): boolean {
	return state === "vacant";
}

export function isEnded(state: HostedParticipantState | undefined): boolean {
	return state === "ended";
}

export function isPiTarget(target: HostedTarget | undefined): target is HostedPiTarget {
	return target?.kind === "pi";
}

export function isAgentTarget(target: HostedTarget | undefined): target is HostedAgentTarget {
	return target?.kind === "agent";
}

export function isWriter(profile: HostedCollaboratorProfile | undefined): boolean {
	return profile === "workspace-write";
}

export function emptyHostedRuntimeState(): HostedRuntimeState {
	return {
		version: HOSTED_STATE_VERSION,
		messaging: {},
		targets: {},
		participants: {},
		events: {},
		dedupe: {},
	};
}
