import { Type, type Static } from "typebox";
import {
	Count,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_PROTOCOL_VERSION,
	IdText,
	ParticipantNameText,
	PathText,
	STRICT_OBJECT,
	boundedText,
} from "./common.ts";
export type { JsonObject, JsonValue } from "./json.ts";
import type { JsonValue } from "./json.ts";
import {
	HostedCollaboratorDriverSchema,
	HostedCollaboratorProfileSchema,
	HostedNativeCollaboratorDriverSchema,
	HostedParticipantStateSchema,
} from "./state.ts";

const AUTH = { registrationId: IdText, registrationKey: IdText };
const NAMESPACE = { namespaceId: IdText, secret: IdText };
const WORKTREE = {
	callerParticipantKey: IdText,
	expectedCallerGeneration: IdText,
	protocol: ParticipantNameText,
	participantId: ParticipantNameText,
};

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

export const HeartbeatResult = Type.Object({
	targetKey: IdText,
	registrationId: IdText,
	registrationKey: IdText,
	leaseUntil: Count,
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

export const WorktreeListResult = Type.Object({
	worktrees: Type.Array(Type.Object({
		protocol: ParticipantNameText,
		participantId: ParticipantNameText,
		path: PathText,
		branchRef: PathText,
		participantState: Type.Optional(HostedParticipantStateSchema),
		recorded: Type.Boolean(),
	})),
});

export const WorktreeRemoveResult = Type.Object({ removed: Type.Literal(true) });

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
export type ClientParticipantStatus = Static<typeof ParticipantStatusResult>;
export type ClientWorktreeList = Static<typeof WorktreeListResult>;
export type ClientWorktreeRemoval = Static<typeof WorktreeRemoveResult>;
