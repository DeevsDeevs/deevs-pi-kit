import { RuntimeError } from "../../errors.ts";
import { Value } from "typebox/value";
import { type HostedMailboxMessageEvent, type HostedMessagingGrant, type HostedRuntimeState, isHeld } from "../../schemas/state.ts";
import type { HostedMessagingSend, HostedStateOperation } from "./operations.ts";
import { HOSTED_ACK_RETENTION_MS, HOSTED_MAX_STATE_RECORDS } from "../../schemas/common.ts";
import { HostedMessagingGrantSchema } from "../../schemas/state.ts";
import { messagingConfigurationHash, messagingSendId } from "./keys.ts";
import { sendMailboxMessage } from "./mailbox.ts";

type IssueOperation = Extract<HostedStateOperation, { type: "messaging.issue" }>;
type ExpireOperation = Extract<HostedStateOperation, { type: "messaging.expire" }>;
type ReadOperation = Extract<HostedStateOperation, { type: "messaging.read" }>;

export function issueMessagingGrant(state: HostedRuntimeState, operation: IssueOperation): HostedRuntimeState {
	const grant = operation.grant;
	if (!Value.Check(HostedMessagingGrantSchema, grant) || grant.expiresAt !== grant.createdAt + HOSTED_ACK_RETENTION_MS) {
		throw new RuntimeError("conflict", "Messaging namespace shape or lifetime is invalid.");
	}
	if (!newlyIssuedGrant(state, grant)) throw new RuntimeError("conflict", "Messaging namespace must be newly issued.");
	assertMessagingCapacity(state);
	assertMessagingHolder(state, grant, grant.createdAt);
	// One descriptor file exists per target, so a fresh grant supersedes that target's previous namespace.
	const superseded = supersedeTargetGrants(state, grant.targetKey);
	return { ...superseded, messaging: { ...superseded.messaging, [grant.namespaceId]: grant } };
}

function supersedeTargetGrants(state: HostedRuntimeState, targetKey: string): HostedRuntimeState {
	const stale = Object.values(state.messaging).filter(grant => grant.targetKey === targetKey && grant.status === "active");
	return stale.reduce((next, grant) => expireMessagingGrant(next, { type: "messaging.expire", namespaceId: grant.namespaceId }), state);
}

export function expireMessagingGrant(state: HostedRuntimeState, operation: ExpireOperation): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant || grant.status === "expired") return state;
	// ponytail: expired namespace IDs remain under the 10,000-record cap; prune tombstones if launch volume requires it.
	const expired: HostedMessagingGrant = { ...grant, status: "expired", operations: {} };
	return { ...state, messaging: { ...state.messaging, [grant.namespaceId]: expired } };
}

export function markMessagingEventRead(state: HostedRuntimeState, operation: ReadOperation): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant) throw new RuntimeError("conflict", "Messaging namespace is absent.");
	assertMessagingHolder(state, grant, operation.at);
	const event = messagingInboxEvent(state, grant, operation.eventId);
	if (event.readAt !== undefined) return state;
	return { ...state, events: { ...state.events, [event.eventId]: { ...event, readAt: operation.at } } };
}

export function publishMessagingEvent(state: HostedRuntimeState, operation: HostedMessagingSend): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant) throw new RuntimeError("conflict", "Messaging namespace is absent.");
	assertMessagingHolder(state, grant, operation.at);
	const publishedId = Object.hasOwn(grant.operations, operation.operationId) ? grant.operations[operation.operationId] : undefined;
	if (publishedId !== undefined) return republishedMessagingState(state, publishedId, operation);
	assertMessagingCapacity(state);
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
	if (!event || event.sendId !== sendId) {
		throw new RuntimeError("conflict", "Messaging publication collided with an existing event.");
	}
	const publishedEvent = operation.inReplyToEventId === undefined ? event : { ...event, inReplyToEventId: operation.inReplyToEventId };
	const current = next.messaging[operation.namespaceId];
	if (!current) throw new RuntimeError("conflict", "Messaging namespace disappeared during publication.");
	const operations = { ...current.operations, [operation.operationId]: event.eventId };
	return {
		...next,
		events: { ...next.events, [event.eventId]: publishedEvent },
		messaging: { ...next.messaging, [grant.namespaceId]: { ...current, operations } },
	};
}

export function messagingInboxEvent(state: HostedRuntimeState, grant: HostedMessagingGrant, eventId: string): HostedMailboxMessageEvent {
	const event = state.events[eventId];
	if (!event) throw new RuntimeError("conflict", "Event is absent from this namespace.");
	if (event.recipientParticipantKey !== grant.participantKey) {
		throw new RuntimeError("conflict", "Event is not addressed to this namespace's participant.");
	}
	return event;
}

function markReplyRead(state: HostedRuntimeState, grant: HostedMessagingGrant, operation: HostedMessagingSend): HostedRuntimeState {
	if (operation.inReplyToEventId === undefined) return state;
	const inbound = messagingInboxEvent(state, grant, operation.inReplyToEventId);
	if (inbound.source.id !== operation.recipientParticipantKey) {
		throw new RuntimeError("conflict", "Reply recipient is not the original sender.");
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
	const repeated = published !== undefined && messagingSendMatches(published, operation);
	if (!repeated) throw new RuntimeError("conflict", "Messaging operation ID was reused with different input.");
	return state;
}

function messagingSendMatches(published: HostedMailboxMessageEvent, operation: HostedMessagingSend): boolean {
	return published.recipientParticipantKey === operation.recipientParticipantKey
		&& published.body === operation.body
		&& published.inReplyToEventId === operation.inReplyToEventId;
}

/** Namespaces and their operation records share one cap; only these two reducers ever add either. */
function assertMessagingCapacity(state: HostedRuntimeState): void {
	let records = Object.keys(state.messaging).length;
	for (const grant of Object.values(state.messaging)) records += Object.keys(grant.operations).length;
	if (records >= HOSTED_MAX_STATE_RECORDS) {
		throw new RuntimeError("conflict", "messaging authority and operation records exceed capacity");
	}
}

function newlyIssuedGrant(state: HostedRuntimeState, grant: HostedMessagingGrant): boolean {
	if (state.messaging[grant.namespaceId]) return false;
	return grant.status === "active" && Object.keys(grant.operations).length === 0;
}

function assertMessagingHolder(state: HostedRuntimeState, grant: HostedMessagingGrant, at: number): void {
	if (!messagingGrantIsLive(state, grant, at)) {
		throw new RuntimeError("conflict", "Messaging authority is expired or no longer bound to this holder.");
	}
}

/** The one liveness rule: an active grant, inside its window, still held by its participant on its target. */
export function messagingGrantIsLive(state: HostedRuntimeState, grant: HostedMessagingGrant, at: number): boolean {
	const holder = state.participants[grant.participantKey];
	const target = state.targets[grant.targetKey];
	if (grant.status !== "active") return false;
	if (!withinWindow(at, grant.createdAt, grant.expiresAt)) return false;
	if (!isHeld(holder?.state) || holder.generation !== grant.holderGeneration || holder.holderTargetKey !== grant.targetKey) return false;
	return target !== undefined && messagingConfigurationHash(target) === grant.configurationHash;
}

/** Half-open [start, end): a grant is live from its creation until, but not at, its expiry. */
function withinWindow(at: number, start: number, end: number): boolean {
	return Number.isFinite(at)
		&& at >= start
		&& at < end;
}
