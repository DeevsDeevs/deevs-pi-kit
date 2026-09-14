import type { HostedFilesystemCreatedEvent, HostedRuntimeState } from "../../hosted-types.ts";

/** Ordinary mail is read through MCP and never enters this queue, so only Monitor events are deliverable. */
export function undeliveredHostedEvents(state: HostedRuntimeState, targetKey: string): HostedFilesystemCreatedEvent[] {
	const events: HostedFilesystemCreatedEvent[] = [];
	for (const event of Object.values(state.events)) {
		if (event.type !== "filesystem.created") continue;
		if (event.targetKey !== targetKey || event.deliveredAt !== undefined) continue;
		events.push(event);
	}
	return events.sort(byDeliveryOrder);
}

function byDeliveryOrder(left: HostedFilesystemCreatedEvent, right: HostedFilesystemCreatedEvent): number {
	return left.createdAt - right.createdAt
		|| left.source.id.localeCompare(right.source.id)
		|| left.eventId.localeCompare(right.eventId);
}
