import {
	HOSTED_ACK_RETENTION_MS,
	HOSTED_MAX_DELIVERY_BATCH,
	type HostedClaim,
	type HostedEvent,
	type HostedRuntimeState,
	type HostedStateOperation,
} from "../../hosted-types.ts";
import { sameClaim, sameIds, sameOrderedIds, sameWake } from "./compare.ts";
import { HostedStateConflictError } from "./errors.ts";
import { deliveryBelongsToClaim, hostedEventRoutesToTarget, pendingHostedEvents } from "./events.ts";
import { closeMessagingGrant } from "./messaging.ts";

type ClaimOperation = Extract<HostedStateOperation, { type: "inbox.claim" }>;
type AckOperation = Extract<HostedStateOperation, { type: "inbox.ack" }>;
type ReconcileOperation = Extract<HostedStateOperation, { type: "inbox.reconcile" }>;
type ReconcileManyOperation = Extract<HostedStateOperation, { type: "inbox.reconcile_many" }>;
type ReleaseOperation = Extract<HostedStateOperation, { type: "inbox.release" }>;
type ReleaseExpiredOperation = Extract<HostedStateOperation, { type: "inbox.release_expired" }>;
type PruneOperation = Extract<HostedStateOperation, { type: "retention.prune" }>;
type WakeSetOperation = Extract<HostedStateOperation, { type: "wake.set" }>;
type WakeAcceptOperation = Extract<HostedStateOperation, { type: "wake.accept" }>;
type WakeClearOperation = Extract<HostedStateOperation, { type: "wake.clear" }>;

export function claimInboxEvents(state: HostedRuntimeState, operation: ClaimOperation): HostedRuntimeState {
	return claimEvents(state, operation.claim);
}

export function ackClaim(state: HostedRuntimeState, operation: AckOperation): HostedRuntimeState {
	const claim = state.claims[operation.claimId];
	if (!claim || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds)) return state;
	if (claim.status === "acked") return state;
	const claimed = claim.eventIds.map((eventId) => state.events[eventId]);
	if (!claimed.every((event): event is HostedEvent => event !== undefined
		&& hostedEventRoutesToTarget(event, claim.targetKey)
		&& deliveryBelongsToClaim(event.delivery, claim.claimId))) return state;
	const events = { ...state.events };
	for (const event of claimed) {
		if (event.delivery.status === "acked") continue;
		events[event.eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
	}
	return pruneAcknowledged(settledClaimState(state, claim, events, operation.at), Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
}

export function reconcileClaims(state: HostedRuntimeState, operation: ReconcileManyOperation): HostedRuntimeState {
	const claimIds = new Set(operation.receipts.map((receipt) => receipt.claimId));
	if (operation.receipts.length > HOSTED_MAX_DELIVERY_BATCH || claimIds.size !== operation.receipts.length) {
		throw new HostedStateConflictError("claim_conflict", "Admission reconciliation receipts are invalid.");
	}
	let next = state;
	for (const receipt of operation.receipts) {
		next = reconcileClaim(next, {
			type: "inbox.reconcile",
			targetKey: operation.targetKey,
			claimId: receipt.claimId,
			eventIds: receipt.eventIds,
			at: operation.at,
		});
	}
	return next;
}

export function reconcileClaim(state: HostedRuntimeState, operation: ReconcileOperation): HostedRuntimeState {
	const claim = state.claims[operation.claimId];
	if (!claim || claim.status === "acked") return state;
	if (claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds)) return state;
	const admitted = claim.eventIds.map((eventId) => state.events[eventId]);
	if (!admitted.every((event): event is HostedEvent => event !== undefined
		&& hostedEventRoutesToTarget(event, claim.targetKey))) return state;
	if (admitted.some((event) => event.delivery.status === "acked" && event.delivery.claimId !== claim.claimId)) return state;
	const next = releaseCompetingClaims(state, admitted, claim, operation.at);
	const events = { ...next.events };
	for (const event of admitted) {
		events[event.eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
	}
	return pruneAcknowledged(settledClaimState(next, claim, events, operation.at), Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
}

export function releaseInboxClaim(state: HostedRuntimeState, operation: ReleaseOperation): HostedRuntimeState {
	return releaseClaim(state, operation.targetKey, operation.claimId, operation.eventIds, operation.at);
}

export function releaseExpiredClaims(state: HostedRuntimeState, operation: ReleaseExpiredOperation): HostedRuntimeState {
	let next = state;
	for (const claim of Object.values(state.claims)) {
		if (claim.status !== "active" || claim.leaseUntil > operation.at) continue;
		next = releaseClaim(next, claim.targetKey, claim.claimId, claim.eventIds, operation.at);
	}
	return next;
}

export function pruneRetention(state: HostedRuntimeState, operation: PruneOperation): HostedRuntimeState {
	return pruneAcknowledged(state, operation.before);
}

export function setWake(state: HostedRuntimeState, operation: WakeSetOperation): HostedRuntimeState {
	if (!state.targets[operation.wake.targetKey]) return state;
	const existing = state.wakes[operation.wake.targetKey];
	if (existing) {
		if (!sameWake(existing, operation.wake)) throw new HostedStateConflictError("conflict", "Target already has another outstanding wake.");
		return state;
	}
	return { ...state, wakes: { ...state.wakes, [operation.wake.targetKey]: operation.wake } };
}

export function acceptWake(state: HostedRuntimeState, operation: WakeAcceptOperation): HostedRuntimeState {
	const wake = state.wakes[operation.claim.targetKey];
	const existingClaim = state.claims[operation.claim.claimId];
	if (!wake) {
		if (existingClaim && sameClaim(existingClaim, operation.claim)) return claimEvents(state, operation.claim);
		throw new HostedStateConflictError("claim_conflict", "Wake is absent or no longer current.");
	}
	if (wake.wakeId !== operation.wakeId || wake.registrationId !== operation.claim.registrationId) {
		throw new HostedStateConflictError("claim_conflict", "Wake does not match this claim owner.");
	}
	const expected = pendingHostedEvents(state, wake.targetKey).slice(0, HOSTED_MAX_DELIVERY_BATCH).map((event) => event.eventId);
	if (expected.length === 0 || !sameOrderedIds(expected, operation.claim.eventIds)) {
		throw new HostedStateConflictError("claim_conflict", "Wake claim is not the current first delivery batch.");
	}
	const claimed = claimEvents(state, operation.claim);
	const wakes = { ...claimed.wakes };
	delete wakes[wake.targetKey];
	return { ...claimed, wakes };
}

export function clearWake(state: HostedRuntimeState, operation: WakeClearOperation): HostedRuntimeState {
	const wake = state.wakes[operation.targetKey];
	if (!wake || wake.wakeId !== operation.wakeId) return state;
	const wakes = { ...state.wakes };
	delete wakes[operation.targetKey];
	return { ...state, wakes };
}

function claimEvents(state: HostedRuntimeState, claim: HostedClaim): HostedRuntimeState {
	assertNoOrdinaryMail(state, claim.eventIds);
	const existing = state.claims[claim.claimId];
	if (existing) {
		if (!sameClaim(existing, claim)) throw new HostedStateConflictError("claim_conflict", "Claim ID does not match its durable receipt.");
		return state;
	}
	if (claim.status !== "active" || claim.eventIds.length < 1 || claim.eventIds.length > HOSTED_MAX_DELIVERY_BATCH) return state;
	if (Object.values(state.claims).some((candidate) => candidate.status === "active" && candidate.targetKey === claim.targetKey)) {
		throw new HostedStateConflictError("claim_conflict", "Target already has an active delivery claim.");
	}
	if (new Set(claim.eventIds).size !== claim.eventIds.length || claim.leaseUntil <= claim.createdAt) return state;
	const claimed = claim.eventIds.map((eventId) => state.events[eventId]);
	if (!claimed.every((event): event is HostedEvent => event !== undefined
		&& hostedEventRoutesToTarget(event, claim.targetKey)
		&& event.delivery.status === "pending")) return state;
	const events = { ...state.events };
	for (const event of claimed) events[event.eventId] = { ...event, delivery: { status: "claimed", claimId: claim.claimId } };
	return { ...state, claims: { ...state.claims, [claim.claimId]: claim }, events };
}

function releaseClaim(state: HostedRuntimeState, targetKey: string, claimId: string, eventIds: string[], at: number): HostedRuntimeState {
	const claim = state.claims[claimId];
	if (!claim || claim.targetKey !== targetKey || !sameIds(claim.eventIds, eventIds) || claim.status !== "active") return state;
	assertNoOrdinaryMail(state, claim.eventIds);
	const events = { ...state.events };
	for (const eventId of claim.eventIds) {
		const event = events[eventId];
		if (event?.delivery.status === "claimed" && event.delivery.claimId === claimId) {
			events[eventId] = { ...event, delivery: { status: "pending", latestClaimId: claimId } };
		}
	}
	return {
		...state,
		claims: { ...state.claims, [claimId]: { ...claim, status: "released", settledAt: at } },
		events,
	};
}

function releaseCompetingClaims(state: HostedRuntimeState, admitted: HostedEvent[], claim: HostedClaim, at: number): HostedRuntimeState {
	const competingClaims = new Set(admitted.flatMap((event) => event.delivery.status === "claimed" && event.delivery.claimId !== claim.claimId
		? [event.delivery.claimId]
		: []));
	let next = state;
	for (const competingClaimId of competingClaims) {
		const competing = next.claims[competingClaimId];
		if (competing?.status === "active") next = releaseClaim(next, competing.targetKey, competing.claimId, competing.eventIds, at);
	}
	return next;
}

function settledClaimState(
	state: HostedRuntimeState,
	claim: HostedClaim,
	events: Record<string, HostedEvent>,
	at: number,
): HostedRuntimeState {
	return {
		...state,
		claims: { ...state.claims, [claim.claimId]: { ...claim, status: "acked", settledAt: at } },
		events,
	};
}

function pruneAcknowledged(state: HostedRuntimeState, before: number): HostedRuntimeState {
	let pruned = state;
	for (const grant of Object.values(state.messaging)) {
		if (grant.expiresAt > before) continue;
		pruned = closeMessagingGrant(pruned, { type: "messaging.close", namespaceId: grant.namespaceId, status: "expired" });
	}
	const removable = removableEventIds(pruned, before);
	retainClaimedEvents(pruned, removable);
	if (removable.size === 0) return pruned;
	const events = { ...pruned.events };
	const dedupe = { ...pruned.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	const claims = { ...pruned.claims };
	for (const claim of Object.values(pruned.claims)) {
		if (claim.eventIds.every((eventId) => removable.has(eventId))) delete claims[claim.claimId];
	}
	return { ...pruned, events, dedupe, claims };
}

function removableEventIds(state: HostedRuntimeState, before: number): Set<string> {
	const retainedMail = new Set(Object.values(state.messaging).flatMap((grant) => Object.values(grant.operations)));
	return new Set(Object.values(state.events)
		.filter((event) => event.type === "mailbox.message"
			? event.createdAt < before && !retainedMail.has(event.eventId)
			: event.delivery.status === "acked" && event.delivery.ackedAt < before)
		.map((event) => event.eventId));
}

/** A claim is pruned whole or not at all, so any claim that keeps one event keeps all of its events. */
function retainClaimedEvents(state: HostedRuntimeState, removable: Set<string>): void {
	let changed = true;
	while (changed) {
		changed = false;
		for (const claim of Object.values(state.claims)) {
			const count = claim.eventIds.filter((eventId) => removable.has(eventId)).length;
			if (count === 0 || (count === claim.eventIds.length && claim.status !== "active")) continue;
			for (const eventId of claim.eventIds) if (removable.delete(eventId)) changed = true;
		}
	}
}

function assertNoOrdinaryMail(state: HostedRuntimeState, eventIds: readonly string[]): void {
	if (eventIds.some((eventId) => state.events[eventId]?.type === "mailbox.message")) {
		throw new HostedStateConflictError("claim_conflict", "Ordinary mail cannot enter native claims.");
	}
}
