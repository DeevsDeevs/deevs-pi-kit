import type { HostedEvent, HostedRuntimeState } from "../../hosted-types.ts";
import { HOSTED_ACK_RETENTION_MS, HOSTED_MAX_STATE_RECORDS } from "../../schemas/common.ts";
import { deriveParticipantKey, mailboxDedupeKey, targetIdentityKey } from "./keys.ts";

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
		checkKey(key, targetIdentityKey(target), "target identity");
	}
	for (const [key, monitor] of Object.entries(state.monitors)) {
		checkKey(key, monitor.monitorId, "monitor");
		for (const [path, entry] of Object.entries(monitor.entries)) checkKey(path, entry.relativePath, "file observation");
	}
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

function checkClaims(state: HostedRuntimeState): void {
	for (const targetKey of Object.keys(state.claims)) {
		if (!state.targets[targetKey]) throw new Error(`delivery claim ${targetKey} references an absent target`);
	}
}

/** Every collection is bounded by its own schema; only nested messaging operations can outgrow their grant. */
function checkCapacity(state: HostedRuntimeState): void {
	let records = Object.keys(state.messaging).length;
	for (const grant of Object.values(state.messaging)) records += Object.keys(grant.operations).length;
	if (records > HOSTED_MAX_STATE_RECORDS) throw new Error("messaging authority and operation records exceed capacity");
}
