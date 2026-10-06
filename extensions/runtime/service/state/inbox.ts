import type { HostedMailboxMessageEvent, HostedRuntimeState } from "../../schemas/state.ts";
import type { HostedStateOperation } from "./operations.ts";

type PruneOperation = Extract<HostedStateOperation, { type: "retention.prune" }>;

/** Drops the settled mail no grant can still retry; grants themselves never expire by time. */
export function pruneRetention(state: HostedRuntimeState, operation: PruneOperation): HostedRuntimeState {
	const removable = removableEventIds(state, operation.before, operation.readBefore);
	if (removable.size === 0) return state;
	const events = { ...state.events };
	const dedupe = { ...state.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	return { ...state, events, dedupe };
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
