import type { HostedMailboxMessageEvent, HostedRuntimeState } from "../../schemas/state.ts";
import type { HostedStateOperation } from "./operations.ts";

type PruneOperation = Extract<HostedStateOperation, { type: "retention.prune" }>;

/**
 * Drops the settled mail no grant can still retry, the operation records of mail that is gone, and superseded grants created
 * before the window, so the shared record cap only ever holds live authority. A live grant never expires by time.
 */
export function pruneRetention(state: HostedRuntimeState, operation: PruneOperation): HostedRuntimeState {
	const removable = removableEventIds(state, operation.before, operation.readBefore);
	const events = { ...state.events };
	const dedupe = { ...state.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	let changed = removable.size > 0;
	const messaging: HostedRuntimeState["messaging"] = {};
	for (const [namespaceId, grant] of Object.entries(state.messaging)) {
		if (grant.status === "expired" && grant.createdAt < operation.before) {
			changed = true;
			continue;
		}
		const operations = Object.entries(grant.operations).filter(([, eventId]) => Object.hasOwn(events, eventId));
		changed ||= operations.length !== Object.keys(grant.operations).length;
		messaging[namespaceId] = { ...grant, operations: Object.fromEntries(operations) };
	}
	return changed ? { ...state, events, dedupe, messaging } : state;
}

function removableEventIds(state: HostedRuntimeState, before: number, readBefore: number | undefined): Set<string> {
	const retainedMail = new Set(Object.values(state.messaging).flatMap((grant) => Object.values(grant.operations)));
	return new Set(Object.values(state.events).filter((event) => isRemovable(event, before, readBefore, retainedMail)).map((event) => event.eventId));
}

/** Unread mail its sender may still retry waits for its reader; read mail and mail no grant lists go after their windows. */
function isRemovable(event: HostedMailboxMessageEvent, before: number, readBefore: number | undefined, retainedMail: ReadonlySet<string>): boolean {
	if (readBefore !== undefined && event.readAt !== undefined && event.readAt < readBefore) return true;
	return event.createdAt < before && !retainedMail.has(event.eventId);
}
