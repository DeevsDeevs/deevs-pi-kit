import { Type, type Static } from "typebox";
import {
	AgentNameText,
	Count,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
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

export const HostedFileObservationSchema = Type.Object({
	relativePath: PathText,
	size: Count,
	mtimeMs: Timestamp,
	stableSince: Timestamp,
	present: Type.Boolean(),
	emitted: Type.Boolean(),
}, STRICT_OBJECT);

export const HostedMonitorSchema = Type.Object({
	monitorId: IdText,
	targetKey: IdText,
	generation: IdText,
	directory: PathText,
	settleMs: Count,
	status: Type.Union([Type.Literal("watching"), Type.Literal("degraded")]),
	sequence: Count,
	entries: keyedRecord(HostedFileObservationSchema, HOSTED_MONITOR_MAX_ENTRIES),
	createdAt: Timestamp,
	updatedAt: Timestamp,
}, STRICT_OBJECT);

export const HostedParticipantTransitionSchema = Type.Object({
	cause: Type.Union([
		Type.Literal("acquire"),
		Type.Literal("reacquire"),
		Type.Literal("stand_down"),
		Type.Literal("release"),
		Type.Literal("takeover"),
		Type.Literal("revive"),
	]),
	generation: IdText,
	holderTargetKey: Type.Optional(IdText),
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
	transitions: Type.Array(HostedParticipantTransitionSchema, { minItems: 1, maxItems: HOSTED_PARTICIPANT_TRANSITION_LIMIT }),
	createdAt: Timestamp,
	updatedAt: Timestamp,
}, STRICT_OBJECT);

export const HostedFilesystemCreatedEventSchema = Type.Object({
	version: Type.Literal(1),
	eventId: IdText,
	dedupeKey: PathText,
	source: Type.Object({
		kind: Type.Literal("monitor"),
		id: IdText,
		generation: IdText,
		sequence: Count,
	}, STRICT_OBJECT),
	targetKey: IdText,
	type: Type.Literal("filesystem.created"),
	createdAt: Timestamp,
	summary: SummaryText,
	payload: Type.Object({
		relativePath: PathText,
		path: PathText,
		fileType: Type.Literal("regular"),
		size: Count,
		mtimeMs: Timestamp,
	}, STRICT_OBJECT),
	deliveredAt: Type.Optional(Timestamp),
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

export const HostedEventSchema = Type.Union([HostedFilesystemCreatedEventSchema, HostedMailboxMessageEventSchema]);

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

export const HOSTED_STATE_VERSION = 19;

export const HostedRuntimeStateSchema = Type.Object({
	version: Type.Literal(HOSTED_STATE_VERSION),
	messaging: keyedRecord(HostedMessagingGrantSchema),
	targets: keyedRecord(HostedTargetSchema),
	monitors: keyedRecord(HostedMonitorSchema),
	participants: keyedRecord(HostedParticipantSchema),
	events: keyedRecord(HostedEventSchema),
	dedupe: keyedRecord(IdText),
	/** One delivery claim per target: its key is the target key and its value the lease expiry. */
	claims: keyedRecord(Timestamp),
}, STRICT_OBJECT);

export type HostedRuntimeInstance = Static<typeof HostedRuntimeInstanceSchema>;
export type HostedCollaboratorProfile = Static<typeof HostedCollaboratorProfileSchema>;
export type HostedNativeCollaboratorDriver = Static<typeof HostedNativeCollaboratorDriverSchema>;
export type HostedCollaboratorDriver = Static<typeof HostedCollaboratorDriverSchema>;
export type HostedHerdrLocator = Static<typeof HostedHerdrLocatorSchema>;
export type HostedPiTarget = Static<typeof HostedPiTargetSchema>;
export type HostedAgentTarget = Static<typeof HostedAgentTargetSchema>;
export type HostedTarget = Static<typeof HostedTargetSchema>;
export type HostedFileObservation = Static<typeof HostedFileObservationSchema>;
export type HostedMonitor = Static<typeof HostedMonitorSchema>;
export type HostedParticipantTransition = Static<typeof HostedParticipantTransitionSchema>;
export type HostedParticipantState = Static<typeof HostedParticipantStateSchema>;
export type HostedParticipant = Static<typeof HostedParticipantSchema>;
export type HostedFilesystemCreatedEvent = Static<typeof HostedFilesystemCreatedEventSchema>;
export type HostedMailboxMessageEvent = Static<typeof HostedMailboxMessageEventSchema>;
export type HostedEvent = Static<typeof HostedEventSchema>;
export type HostedMessagingGrant = Static<typeof HostedMessagingGrantSchema>;
export type HostedRuntimeState = Static<typeof HostedRuntimeStateSchema>;

export function emptyHostedRuntimeState(): HostedRuntimeState {
	return {
		version: HOSTED_STATE_VERSION,
		messaging: {},
		targets: {},
		monitors: {},
		participants: {},
		events: {},
		dedupe: {},
		claims: {},
	};
}
