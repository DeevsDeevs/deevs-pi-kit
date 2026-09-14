import type { HostedEvent, HostedRuntimeState } from "../../hosted-types.ts";
import { HOSTED_MAX_STATE_RECORDS } from "../../schemas/common.ts";

/**
 * The root schema proves every record's shape; this proves the references between them, which no
 * single-record schema can see. Repair is never attempted: a dangling reference fails the load.
 */
export function checkStateIntegrity(state: HostedRuntimeState): void {
	checkCapacity(state);
	for (const participant of Object.values(state.participants)) {
		if (participant.state !== "held") continue;
		const holder = participant.holderTargetKey ? state.targets[participant.holderTargetKey] : undefined;
		if (!holder || holder.projectRoot !== participant.projectRoot) {
			throw new Error(`held participant ${participant.participantKey} has no holder target in its project`);
		}
	}
	for (const event of Object.values(state.events)) checkEventParticipants(state, event);
	for (const claim of Object.values(state.claims)) {
		for (const eventId of claim.eventIds) {
			if (!state.events[eventId]) throw new Error(`claim ${claim.claimId} references absent event ${eventId}`);
		}
	}
}

function checkEventParticipants(state: HostedRuntimeState, event: HostedEvent): void {
	if (event.type !== "mailbox.message") return;
	const sender = state.participants[event.source.id];
	const recipient = state.participants[event.recipientParticipantKey];
	if (!sender || !recipient) throw new Error(`mail event ${event.eventId} references an absent participant`);
}

/** Every collection is bounded by its own schema; only nested messaging operations can outgrow their grant. */
function checkCapacity(state: HostedRuntimeState): void {
	let records = Object.keys(state.messaging).length;
	for (const grant of Object.values(state.messaging)) records += Object.keys(grant.operations).length;
	if (records > HOSTED_MAX_STATE_RECORDS) throw new Error("messaging authority and operation records exceed capacity");
}
