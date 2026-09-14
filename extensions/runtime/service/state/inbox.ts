import { HOSTED_ACK_RETENTION_MS, type HostedEvent, type HostedRuntimeState, type HostedStateOperation } from "../../hosted-types.ts";
import { expireMessagingGrant } from "./messaging.ts";

type ClaimOperation = Extract<HostedStateOperation, { type: "inbox.claim" }>;
type AckOperation = Extract<HostedStateOperation, { type: "inbox.ack" }>;
type PruneOperation = Extract<HostedStateOperation, { type: "retention.prune" }>;

/** One claim per target, and nothing else: it only stops two heartbeats handing out the same batch. */
export function claimTargetInbox(state: HostedRuntimeState, operation: ClaimOperation): HostedRuntimeState {
	if (!state.targets[operation.targetKey]) return state;
	return { ...state, claims: { ...state.claims, [operation.targetKey]: operation.leaseUntil } };
}

/** Delivery is at-least-once: an ack records that Pi admitted these events and frees the target's claim. */
export function ackDeliveredEvents(state: HostedRuntimeState, operation: AckOperation): HostedRuntimeState {
	const events = { ...state.events };
	let changed = false;
	for (const eventId of operation.eventIds) {
		const event = events[eventId];
		if (event?.type !== "filesystem.created" || event.targetKey !== operation.targetKey) continue;
		if (event.deliveredAt !== undefined) continue;
		events[eventId] = { ...event, deliveredAt: operation.at };
		changed = true;
	}
	const claims = { ...state.claims };
	if (Object.hasOwn(claims, operation.targetKey)) {
		delete claims[operation.targetKey];
		changed = true;
	}
	if (!changed) return state;
	return pruneSettled({ ...state, events, claims }, Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
}

export function pruneRetention(state: HostedRuntimeState, operation: PruneOperation): HostedRuntimeState {
	return pruneSettled(state, operation.before);
}

function pruneSettled(state: HostedRuntimeState, before: number): HostedRuntimeState {
	let pruned = state;
	for (const grant of Object.values(state.messaging)) {
		if (grant.expiresAt > before) continue;
		pruned = expireMessagingGrant(pruned, { type: "messaging.expire", namespaceId: grant.namespaceId });
	}
	const removable = removableEventIds(pruned, before);
	if (removable.size === 0) return pruned;
	const events = { ...pruned.events };
	const dedupe = { ...pruned.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	return { ...pruned, events, dedupe };
}

function removableEventIds(state: HostedRuntimeState, before: number): Set<string> {
	const retainedMail = new Set(Object.values(state.messaging).flatMap((grant) => Object.values(grant.operations)));
	return new Set(Object.values(state.events).filter((event) => isRemovable(event, before, retainedMail)).map((event) => event.eventId));
}

function isRemovable(event: HostedEvent, before: number, retainedMail: ReadonlySet<string>): boolean {
	if (event.type === "mailbox.message") return event.createdAt < before && !retainedMail.has(event.eventId);
	return event.deliveredAt !== undefined && event.deliveredAt < before;
}
