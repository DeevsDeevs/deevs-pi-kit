import { type HostedMailboxMessageEvent, type HostedRuntimeState, isEnded } from "../../schemas/state.ts";
import { messagingGrantIsLive } from "./messaging.ts";
import type { HostedStateOperation } from "./operations.ts";

type PruneOperation = Extract<HostedStateOperation, { type: "retention.prune" }>;

/**
 * Drops the settled mail no grant can still retry, mail to a participant that is gone, the operation records of mail that is gone,
 * and grants created before the window that are no longer live (superseded, or their holder left), so the shared record cap only
 * ever holds live authority. A live grant never expires by time.
 */
export function pruneRetention(state: HostedRuntimeState, operation: PruneOperation): HostedRuntimeState {
	const retired = new Set(Object.values(state.messaging).filter((grant) => grant.createdAt < operation.before && !messagingGrantIsLive(state, grant)).map((grant) => grant.namespaceId));
	const retainedMail = new Set(Object.values(state.messaging).filter((grant) => !retired.has(grant.namespaceId)).flatMap((grant) => Object.values(grant.operations)));
	const removable = new Set(Object.values(state.events).filter((event) => isRemovable(state, event, operation, retainedMail)).map((event) => event.eventId));
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
		if (retired.has(namespaceId)) {
			changed = true;
			continue;
		}
		const operations = Object.entries(grant.operations).filter(([, eventId]) => Object.hasOwn(events, eventId));
		changed ||= operations.length !== Object.keys(grant.operations).length;
		messaging[namespaceId] = { ...grant, operations: Object.fromEntries(operations) };
	}
	return changed ? { ...state, events, dedupe, messaging } : state;
}

/** Unread mail its sender may still retry waits for its reader while one can come; read mail and other mail go after their windows. */
function isRemovable(state: HostedRuntimeState, event: HostedMailboxMessageEvent, { before, readBefore }: PruneOperation, retainedMail: ReadonlySet<string>): boolean {
	if (readBefore !== undefined && event.readAt !== undefined && event.readAt < readBefore) return true;
	if (event.createdAt >= before) return false;
	const recipient = state.participants[event.recipientParticipantKey];
	return !retainedMail.has(event.eventId) || !recipient || isEnded(recipient.state);
}
