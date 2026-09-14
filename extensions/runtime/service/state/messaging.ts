import { Value } from "typebox/value";
import type {
	HostedMailboxMessageEvent,
	HostedMessagingGrant,
	HostedMessagingSend,
	HostedRuntimeState,
	HostedStateOperation,
} from "../../hosted-types.ts";
import { HOSTED_ACK_RETENTION_MS } from "../../schemas/common.ts";
import { HostedMessagingGrantSchema } from "../../schemas/state.ts";
import { HostedStateConflictError } from "./errors.ts";
import { assertStateId } from "./guards.ts";
import { messagingConfigurationHash, messagingSendId } from "./keys.ts";
import { sendMailboxMessage } from "./mailbox.ts";

type IssueOperation = Extract<HostedStateOperation, { type: "messaging.issue" }>;
type CloseOperation = Extract<HostedStateOperation, { type: "messaging.close" }>;
type InvalidateClientOperation = Extract<HostedStateOperation, { type: "messaging.invalidate_client" }>;
type ReadOperation = Extract<HostedStateOperation, { type: "messaging.read" }>;

export function issueMessagingGrant(state: HostedRuntimeState, operation: IssueOperation): HostedRuntimeState {
	const grant = operation.grant;
	if (!Value.Check(HostedMessagingGrantSchema, grant) || grant.expiresAt !== grant.createdAt + HOSTED_ACK_RETENTION_MS) {
		throw new HostedStateConflictError("conflict", "Messaging namespace shape or lifetime is invalid.");
	}
	if (!newlyIssuedGrant(state, grant)) throw new HostedStateConflictError("conflict", "Messaging namespace must be newly issued.");
	assertMessagingHolder(state, grant, grant.createdAt);
	return { ...state, messaging: { ...state.messaging, [grant.namespaceId]: grant } };
}

export function closeMessagingGrant(state: HostedRuntimeState, operation: CloseOperation): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant || grant.status === "expired") return state;
	if (grant.status === "revoked" && operation.status === "revoked") return state;
	// ponytail: terminal namespace IDs remain under the 10,000-record cap; prune tombstones if launch volume requires it.
	const closed: HostedMessagingGrant = {
		...grant,
		status: operation.status,
		operations: operation.status === "expired" ? {} : grant.operations,
	};
	return { ...state, messaging: { ...state.messaging, [grant.namespaceId]: closed } };
}

export function invalidateMessagingClient(state: HostedRuntimeState, operation: InvalidateClientOperation): HostedRuntimeState {
	let next = state;
	for (const grant of Object.values(state.messaging)) {
		if (!grantBelongsToClient(grant, operation)) continue;
		next = closeMessagingGrant(next, { type: "messaging.close", namespaceId: grant.namespaceId, status: "revoked" });
	}
	return next;
}

export function markMessagingEventRead(state: HostedRuntimeState, operation: ReadOperation): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant) throw new HostedStateConflictError("conflict", "Messaging namespace is absent.");
	assertMessagingHolder(state, grant, operation.at);
	const event = messagingInboxEvent(state, grant, operation.eventId);
	if (event.readAt !== undefined) return state;
	return { ...state, events: { ...state.events, [event.eventId]: { ...event, readAt: operation.at } } };
}

export function publishMessagingEvent(state: HostedRuntimeState, operation: HostedMessagingSend): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant) throw new HostedStateConflictError("conflict", "Messaging namespace is absent.");
	assertMessagingHolder(state, grant, operation.at);
	assertStateId(operation.operationId, "Messaging operation ID");
	const publishedId = Object.hasOwn(grant.operations, operation.operationId) ? grant.operations[operation.operationId] : undefined;
	if (publishedId !== undefined) return republishedMessagingState(state, publishedId, operation);
	const read = markReplyRead(state, grant, operation);
	const sendId = messagingSendId(grant.namespaceId, operation.operationId);
	const next = sendMailboxMessage(read, {
		type: "mailbox.send",
		senderParticipantKey: grant.participantKey,
		expectedSenderGeneration: grant.holderGeneration,
		senderTargetKey: grant.targetKey,
		recipientParticipantKey: operation.recipientParticipantKey,
		sendId,
		body: operation.body,
		eventId: operation.eventId,
		at: operation.at,
	});
	const event = next.events[operation.eventId];
	if (event?.type !== "mailbox.message" || event.sendId !== sendId) {
		throw new HostedStateConflictError("conflict", "Messaging publication collided with an existing event.");
	}
	const publishedEvent = operation.inReplyToEventId === undefined ? event : { ...event, inReplyToEventId: operation.inReplyToEventId };
	const current = next.messaging[operation.namespaceId];
	if (!current) throw new HostedStateConflictError("conflict", "Messaging namespace disappeared during publication.");
	const operations = { ...current.operations, [operation.operationId]: event.eventId };
	return {
		...next,
		events: { ...next.events, [event.eventId]: publishedEvent },
		messaging: { ...next.messaging, [grant.namespaceId]: { ...current, operations } },
	};
}

export function messagingInboxEvent(state: HostedRuntimeState, grant: HostedMessagingGrant, eventId: string): HostedMailboxMessageEvent {
	const event = state.events[eventId];
	if (event?.type !== "mailbox.message") throw new HostedStateConflictError("conflict", "Event is not ordinary mail.");
	if (event.recipientParticipantKey !== grant.participantKey) {
		throw new HostedStateConflictError("conflict", "Event is not addressed to this namespace's participant.");
	}
	return event;
}

function markReplyRead(state: HostedRuntimeState, grant: HostedMessagingGrant, operation: HostedMessagingSend): HostedRuntimeState {
	if (operation.inReplyToEventId === undefined) return state;
	const inbound = messagingInboxEvent(state, grant, operation.inReplyToEventId);
	if (inbound.source.id !== operation.recipientParticipantKey) {
		throw new HostedStateConflictError("conflict", "Reply recipient is not the original sender.");
	}
	return markMessagingEventRead(state, {
		type: "messaging.read",
		namespaceId: grant.namespaceId,
		eventId: inbound.eventId,
		at: operation.at,
	});
}

function republishedMessagingState(state: HostedRuntimeState, publishedId: string, operation: HostedMessagingSend): HostedRuntimeState {
	const published = state.events[publishedId];
	const repeated = published?.type === "mailbox.message" && messagingSendMatches(published, operation);
	if (!repeated) throw new HostedStateConflictError("conflict", "Messaging operation ID was reused with different input.");
	return state;
}

function messagingSendMatches(published: HostedMailboxMessageEvent, operation: HostedMessagingSend): boolean {
	return published.recipientParticipantKey === operation.recipientParticipantKey
		&& published.body === operation.body
		&& published.inReplyToEventId === operation.inReplyToEventId;
}

function newlyIssuedGrant(state: HostedRuntimeState, grant: HostedMessagingGrant): boolean {
	if (state.messaging[grant.namespaceId]) return false;
	return grant.status === "active" && Object.keys(grant.operations).length === 0;
}

function grantBelongsToClient(grant: HostedMessagingGrant, operation: InvalidateClientOperation): boolean {
	if (grant.targetKey !== operation.targetKey) return false;
	return grant.clientGeneration !== operation.clientGeneration || grant.terminalId !== operation.terminalId;
}

function assertMessagingHolder(state: HostedRuntimeState, grant: HostedMessagingGrant, at: number): void {
	if (!messagingAuthorityIsLive(state, grant, at)) {
		throw new HostedStateConflictError("conflict", "Messaging authority is expired, revoked, or no longer bound to this holder.");
	}
}

function messagingAuthorityIsLive(state: HostedRuntimeState, grant: HostedMessagingGrant, at: number): boolean {
	const holder = state.participants[grant.participantKey];
	const target = state.targets[grant.targetKey];
	if (grant.status !== "active") return false;
	if (!withinWindow(at, grant.createdAt, grant.expiresAt)) return false;
	if (holder?.state !== "held" || holder.generation !== grant.holderGeneration || holder.holderTargetKey !== grant.targetKey) return false;
	return target !== undefined && messagingConfigurationHash(target) === grant.configurationHash;
}

/** Half-open [start, end): a grant is live from its creation until, but not at, its expiry. */
function withinWindow(at: number, start: number, end: number): boolean {
	return Number.isFinite(at)
		&& at >= start
		&& at < end;
}
