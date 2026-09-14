import { Type, type Static } from "typebox";
import {
	Count,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_PROTOCOL_VERSION,
	IdText,
	ParticipantNameText,
	PathText,
	STRICT_OBJECT,
	SummaryText,
	boundedText,
} from "./common.ts";
import {
	HostedCollaboratorDriverSchema,
	HostedCollaboratorProfileSchema,
	HostedNativeCollaboratorDriverSchema,
	HostedParticipantStateSchema,
} from "./state.ts";

/** The JSON a request line can carry; method schemas narrow it to a typed params object. */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

const AUTH = { registrationId: IdText, registrationKey: IdText };
const NAMESPACE = { namespaceId: IdText, secret: IdText };
const WORKTREE = {
	callerParticipantKey: IdText,
	expectedCallerGeneration: IdText,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
};

const DeliveredEventIds = Type.Array(IdText, { minItems: 1, maxItems: HOSTED_MAX_DELIVERY_BATCH, uniqueItems: true });
/** Base64 keeps a 16 KiB body under the unchanged 64 KiB RPC request cap. */
const BodyBase64 = boundedText(24 * 1024);

export const HostedRequestIdSchema = Type.Object({ id: IdText });
export const HostedRequestVersionSchema = Type.Object({ v: Type.Integer(), id: IdText });
export const HostedRequestSchema = Type.Object({
	v: Type.Literal(HOSTED_PROTOCOL_VERSION),
	id: IdText,
	method: boundedText(100),
	params: Type.Optional(Type.Unsafe<JsonValue>(Type.Any())),
}, STRICT_OBJECT);

export const HelloParams = Type.Object({ minVersion: Count, maxVersion: Count }, STRICT_OBJECT);

export const RegistrationAuthParams = Type.Object({ ...AUTH }, STRICT_OBJECT);
export const ParticipantAuthParams = Type.Object({ ...AUTH, participantKey: IdText }, STRICT_OBJECT);

export const PiRegisterParams = Type.Object({
	projectRoot: PathText,
	worktreePath: Type.Optional(PathText),
	piSessionId: IdText,
	piSessionFile: PathText,
}, STRICT_OBJECT);

/** Pi asks for its undelivered events only while it can admit them, so a busy session never holds a claim. */
export const PiHeartbeatParams = Type.Object({ ...AUTH, admit: Type.Optional(Type.Boolean()) }, STRICT_OBJECT);

export const BridgeBindParams = Type.Object({
	...AUTH,
	agentName: boundedText(64),
	driver: HostedNativeCollaboratorDriverSchema,
	profile: HostedCollaboratorProfileSchema,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	callerParticipantKey: IdText,
	expectedCallerGeneration: IdText,
	expectedParticipantGeneration: Type.Optional(IdText),
}, STRICT_OBJECT);

export const WorktreeEnsureParams = Type.Object({ ...AUTH, ...WORKTREE }, STRICT_OBJECT);
export const WorktreeRemoveParams = Type.Object({ ...AUTH, ...WORKTREE, discardConfirmed: Type.Boolean() }, STRICT_OBJECT);

export const MonitorCreateParams = Type.Object({ ...AUTH, directory: PathText, settleMs: Count }, STRICT_OBJECT);
export const MonitorDeleteParams = Type.Object({ ...AUTH, monitorId: IdText }, STRICT_OBJECT);

export const InboxAckParams = Type.Object({ ...AUTH, eventIds: DeliveredEventIds }, STRICT_OBJECT);

export const ParticipantAcquireParams = Type.Object({
	...AUTH,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	revive: Type.Optional(Type.Boolean()),
}, STRICT_OBJECT);
export const ParticipantStandDownParams = Type.Object({
	...AUTH,
	participantKey: IdText,
	expectedGeneration: Type.Optional(IdText),
}, STRICT_OBJECT);
export const ParticipantConfirmedParams = Type.Object({
	...AUTH,
	participantKey: IdText,
	expectedGeneration: IdText,
	confirmed: Type.Literal(true),
}, STRICT_OBJECT);

export const MailboxSendParams = Type.Object({
	...AUTH,
	senderParticipantKey: IdText,
	expectedSenderGeneration: IdText,
	recipientParticipantKey: IdText,
	sendId: IdText,
	body: boundedText(HOSTED_MAILBOX_MAX_BODY_BYTES),
}, STRICT_OBJECT);

export const MessagingIssueParams = Type.Object({
	...AUTH,
	participantKey: IdText,
	expectedGeneration: IdText,
	confirmed: Type.Literal(true),
}, STRICT_OBJECT);
export const MessagingPeersParams = Type.Object({ ...NAMESPACE, cursor: Type.Optional(boundedText(512)) }, STRICT_OBJECT);
export const MessagingStatusParams = Type.Object({ ...NAMESPACE, operationId: IdText }, STRICT_OBJECT);
export const MessagingEventParams = Type.Object({ ...NAMESPACE, eventId: IdText }, STRICT_OBJECT);
export const MessagingSendParams = Type.Object({
	...NAMESPACE,
	operationId: IdText,
	participantId: ParticipantNameText,
	bodyBase64: BodyBase64,
}, STRICT_OBJECT);
export const MessagingReplyParams = Type.Object({
	...NAMESPACE,
	operationId: IdText,
	eventId: IdText,
	bodyBase64: BodyBase64,
}, STRICT_OBJECT);

/** Results stay open objects: a client decodes the fields it needs and ignores the rest. */
export const LiveRegistrationResult = Type.Object({
	targetKey: IdText,
	registrationId: IdText,
	registrationKey: IdText,
	leaseUntil: Count,
});

export const MailHintResult = Type.Object({ namespaceId: IdText, eventId: IdText });

export const InboxEventResult = Type.Object({
	eventId: IdText,
	type: Type.Literal("filesystem.created"),
	summary: SummaryText,
	path: PathText,
});

export const HeartbeatResult = Type.Object({
	targetKey: IdText,
	registrationId: IdText,
	registrationKey: IdText,
	leaseUntil: Count,
	events: Type.Optional(Type.Array(InboxEventResult, { maxItems: HOSTED_MAX_DELIVERY_BATCH })),
	mail: Type.Optional(MailHintResult),
});

export const ParticipantStatusResult = Type.Object({
	participantKey: IdText,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
	state: HostedParticipantStateSchema,
	generation: IdText,
	holderTargetKey: Type.Optional(IdText),
	holderLive: Type.Boolean(),
	driver: Type.Optional(HostedCollaboratorDriverSchema),
	profile: Type.Optional(HostedCollaboratorProfileSchema),
	unreadMail: Type.Optional(Count),
	lastTransition: Type.Object({ cause: IdText }),
});

export const ParticipantAcquireResult = Type.Object({
	participant: ParticipantStatusResult,
	revived: Type.Boolean(),
	transitioned: Type.Boolean(),
});

/** Every messaging method carries the same namespace credentials, whatever else it takes. */
export interface MessagingNamespaceAuth {
	namespaceId: string;
	secret: string;
}

export type LiveClientRegistration = Static<typeof LiveRegistrationResult>;
export type MailHint = Static<typeof MailHintResult>;
export type InboxEvent = Static<typeof InboxEventResult>;
export type ClientParticipantStatus = Static<typeof ParticipantStatusResult>;
