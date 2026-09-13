import type { HostedEvent, HostedEventDelivery, HostedRuntimeState } from "../../hosted-types.ts";

export function pendingHostedEvents(state: HostedRuntimeState, targetKey: string): HostedEvent[] {
	return Object.values(state.events)
		.filter((event) => event.delivery.status === "pending" && hostedEventRoutesToTarget(event, targetKey))
		.sort(byDeliveryOrder);
}

export function hostedEventRoutesToTarget(event: HostedEvent, targetKey: string): boolean {
	if (event.type === "mailbox.message") return false;
	return event.targetKey === targetKey;
}

export function deliveryBelongsToClaim(delivery: HostedEventDelivery, claimId: string): boolean {
	if (delivery.status !== "pending") return delivery.claimId === claimId;
	return delivery.latestClaimId === claimId;
}

function byDeliveryOrder(left: HostedEvent, right: HostedEvent): number {
	return left.createdAt - right.createdAt
		|| left.source.kind.localeCompare(right.source.kind)
		|| left.source.id.localeCompare(right.source.id)
		|| left.source.generation.localeCompare(right.source.generation)
		|| left.source.sequence - right.source.sequence
		|| left.eventId.localeCompare(right.eventId);
}
