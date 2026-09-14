import { type HostedMailboxMessageEvent, type HostedRuntimeState, type HostedStateOperation } from "../../hosted-types.ts";
import { expireMessagingGrant } from "./messaging.ts";

type PruneOperation = Extract<HostedStateOperation, { type: "retention.prune" }>;

/** Expires every grant past its window and drops the settled mail no live grant can still retry. */
export function pruneRetention(state: HostedRuntimeState, operation: PruneOperation): HostedRuntimeState {
	const before = operation.before;
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

function isRemovable(event: HostedMailboxMessageEvent, before: number, retainedMail: ReadonlySet<string>): boolean {
	return event.createdAt < before && !retainedMail.has(event.eventId);
}
