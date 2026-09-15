import type { HostedMailboxMessageEvent, HostedRuntimeState } from "../../schemas/state.ts";
import type { HostedStateOperation } from "./operations.ts";
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
	const removable = removableEventIds(pruned, before, operation.readBefore);
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

function removableEventIds(state: HostedRuntimeState, before: number, readBefore: number | undefined): Set<string> {
	const retainedMail = new Set(Object.values(state.messaging).flatMap((grant) => Object.values(grant.operations)));
	return new Set(Object.values(state.events).filter((event) => isRemovable(event, before, readBefore, retainedMail)).map((event) => event.eventId));
}

/** Unread mail waits out the full window for a holder; read mail only needs its id kept by the sender's grant, so it goes earlier. */
function isRemovable(event: HostedMailboxMessageEvent, before: number, readBefore: number | undefined, retainedMail: ReadonlySet<string>): boolean {
	if (readBefore !== undefined && event.readAt !== undefined && event.readAt < readBefore) return true;
	return event.createdAt < before && !retainedMail.has(event.eventId);
}
