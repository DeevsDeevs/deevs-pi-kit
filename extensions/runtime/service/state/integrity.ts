import type { HostedClaim, HostedEvent, HostedEventDelivery, HostedRuntimeState } from "../../hosted-types.ts";
import { HOSTED_ACK_RETENTION_MS, HOSTED_MAX_STATE_RECORDS } from "../../schemas/common.ts";
import { hostedEventRoutesToTarget } from "./events.ts";
import { deriveAgentTargetKey, deriveParticipantKey, mailboxDedupeKey } from "./keys.ts";

/**
 * The root schema proves every record's shape; this proves the references between them and the
 * derived identities no single-record schema can see. Repair is never attempted: a dangling or
 * forged reference fails the load.
 */
export function checkStateIntegrity(state: HostedRuntimeState): void {
	checkCapacity(state);
	checkKeyedRecords(state);
	checkParticipants(state);
	checkEvents(state);
	checkClaims(state);
}

function checkKey(key: string, identity: string, subject: string): void {
	if (identity !== key) throw new Error(`${subject} ${identity} does not match its map key ${key}`);
}

function checkKeyedRecords(state: HostedRuntimeState): void {
	for (const [key, grant] of Object.entries(state.messaging)) {
		checkKey(key, grant.namespaceId, "messaging namespace");
		if (grant.expiresAt !== grant.createdAt + HOSTED_ACK_RETENTION_MS) throw new Error(`messaging namespace ${key} has an invalid lifetime`);
	}
	for (const [key, target] of Object.entries(state.targets)) {
		checkKey(key, target.targetKey, "target");
		if (target.kind === "agent") checkKey(key, deriveAgentTargetKey(target.projectRoot, target.agentName), "agent target identity");
	}
	for (const [key, monitor] of Object.entries(state.monitors)) {
		checkKey(key, monitor.monitorId, "monitor");
		for (const [path, entry] of Object.entries(monitor.entries)) checkKey(path, entry.relativePath, "file observation");
	}
	for (const [key, wake] of Object.entries(state.wakes)) checkKey(key, wake.targetKey, "wake target");
}

function checkParticipants(state: HostedRuntimeState): void {
	for (const [key, participant] of Object.entries(state.participants)) {
		checkKey(key, participant.participantKey, "participant");
		const derived = deriveParticipantKey(participant.projectRoot, participant.protocol, participant.participantId);
		checkKey(key, derived, "participant identity");
		if (participant.state !== "held") continue;
		const holder = participant.holderTargetKey ? state.targets[participant.holderTargetKey] : undefined;
		if (!holder || holder.projectRoot !== participant.projectRoot) {
			throw new Error(`held participant ${key} has no holder target in its project`);
		}
	}
}

function checkEvents(state: HostedRuntimeState): void {
	for (const [dedupeKey, eventId] of Object.entries(state.dedupe)) {
		const event = state.events[eventId];
		if (!event || event.dedupeKey !== dedupeKey) throw new Error(`dedupe key ${dedupeKey} does not resolve to an event that carries it`);
	}
	for (const [key, event] of Object.entries(state.events)) {
		checkKey(key, event.eventId, "event");
		if (state.dedupe[event.dedupeKey] !== event.eventId) throw new Error(`event ${key} is unreachable through its dedupe key`);
		checkEventParticipants(state, event);
		checkEventClaim(state, event);
	}
}

function checkEventParticipants(state: HostedRuntimeState, event: HostedEvent): void {
	if (event.type !== "mailbox.message") return;
	const sender = state.participants[event.source.id];
	const recipient = state.participants[event.recipientParticipantKey];
	if (!sender || !recipient) throw new Error(`mail event ${event.eventId} references an absent participant`);
	if (event.dedupeKey !== mailboxDedupeKey(event.source.id, event.sendId)) {
		throw new Error(`mail event ${event.eventId} carries a dedupe key that is not derived from its sender and send ID`);
	}
}

function checkEventClaim(state: HostedRuntimeState, event: HostedEvent): void {
	const claimId = deliveryClaimId(event.delivery);
	if (!claimId) return;
	const claim = state.claims[claimId];
	if (!claim || !claimCoversEvent(claim, event)) {
		throw new Error(`event ${event.eventId} references claim ${claimId} that does not cover it`);
	}
}

function deliveryClaimId(delivery: HostedEventDelivery): string | undefined {
	if (delivery.status === "pending") return delivery.latestClaimId;
	return delivery.claimId;
}

function claimCoversEvent(claim: HostedClaim, event: HostedEvent): boolean {
	return hostedEventRoutesToTarget(event, claim.targetKey) && claim.eventIds.includes(event.eventId);
}

function checkClaims(state: HostedRuntimeState): void {
	for (const [key, claim] of Object.entries(state.claims)) {
		checkKey(key, claim.claimId, "claim");
		if (claim.leaseUntil <= claim.createdAt) throw new Error(`claim ${key} has a lease that does not outlive its creation`);
		for (const eventId of claim.eventIds) {
			if (!state.events[eventId]) throw new Error(`claim ${key} references absent event ${eventId}`);
		}
	}
}

/** Every collection is bounded by its own schema; only nested messaging operations can outgrow their grant. */
function checkCapacity(state: HostedRuntimeState): void {
	let records = Object.keys(state.messaging).length;
	for (const grant of Object.values(state.messaging)) records += Object.keys(grant.operations).length;
	if (records > HOSTED_MAX_STATE_RECORDS) throw new Error("messaging authority and operation records exceed capacity");
}
