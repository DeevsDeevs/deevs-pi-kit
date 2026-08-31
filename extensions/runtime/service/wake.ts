import { createHash, randomUUID } from "node:crypto";
import { HOSTED_MAX_DELIVERY_BATCH, type HostedClaim, type HostedEvent } from "../hosted-types.ts";
import type { HostedLiveRegistration } from "./registration.ts";
import { HostedStateStore, hostedEventRoutesToTarget, pendingHostedEvents } from "./state.ts";

const CLAIM_LEASE_MS = 30_000;

export class HostedInboxError extends Error {
	readonly code: "not_found" | "claim_conflict" | "busy";

	constructor(code: "not_found" | "claim_conflict" | "busy", message: string) {
		super(message);
		this.code = code;
	}
}

export interface HostedWakeOptions {
	now?: () => number;
	claimLeaseMs?: number;
	createClaimId?: () => string;
}

export interface HostedClaimResult {
	claim: HostedClaim;
	events: HostedEvent[];
}

export class HostedWakeCoordinator {
	private readonly store: HostedStateStore;
	private readonly options: HostedWakeOptions;
	private closed = false;

	constructor(store: HostedStateStore, options: HostedWakeOptions = {}) {
		this.store = store;
		this.options = options;
	}

	request(targetKey: string): void {
		if (this.closed) return;
		this.releaseExpired();
		this.clearWakeWithoutPending(targetKey);
	}

	accept(registration: HostedLiveRegistration, wakeId: string): HostedClaimResult {
		this.releaseExpired();
		const claimId = claimIdForWake(wakeId);
		const state = this.store.read();
		const existing = state.claims[claimId];
		if (existing) {
			this.verifyClaimOwner(existing, registration);
			if (existing.status === "released") throw new HostedInboxError("claim_conflict", "Wake claim was already released.");
			return { claim: existing, events: claimEvents(state.events, existing) };
		}
		if (this.hasActiveClaim(registration.targetKey)) throw new HostedInboxError("busy", "Target already has an active delivery claim.");
		const wake = state.wakes[registration.targetKey];
		if (!wake || wake.wakeId !== wakeId || wake.registrationId !== registration.registrationId) throw new HostedInboxError("not_found", "Wake is absent or does not match this registration.");
		const events = pendingHostedEvents(state, registration.targetKey).slice(0, HOSTED_MAX_DELIVERY_BATCH);
		if (events.length === 0) throw new HostedInboxError("not_found", "Wake has no pending events.");
		const now = this.now();
		const claim: HostedClaim = {
			claimId,
			targetKey: registration.targetKey,
			registrationId: registration.registrationId,
			clientGeneration: registration.clientGeneration,
			eventIds: events.map((event) => event.eventId),
			createdAt: now,
			leaseUntil: now + (this.options.claimLeaseMs ?? CLAIM_LEASE_MS),
			status: "active",
		};
		this.store.apply({ type: "wake.accept", wakeId, claim });
		return { claim: this.store.read().claims[claimId]!, events };
	}

	claim(registration: HostedLiveRegistration, maxEvents = HOSTED_MAX_DELIVERY_BATCH): HostedClaimResult {
		this.releaseExpired();
		if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > HOSTED_MAX_DELIVERY_BATCH) throw new HostedInboxError("claim_conflict", "Claim batch limit is invalid.");
		if (this.hasActiveClaim(registration.targetKey)) throw new HostedInboxError("busy", "Target already has an active delivery claim.");
		const events = pendingHostedEvents(this.store.read(), registration.targetKey).slice(0, maxEvents);
		if (events.length === 0) throw new HostedInboxError("not_found", "Inbox has no pending events.");
		const now = this.now();
		const claim: HostedClaim = {
			claimId: this.options.createClaimId?.() ?? `claim_${randomUUID()}`,
			targetKey: registration.targetKey,
			registrationId: registration.registrationId,
			clientGeneration: registration.clientGeneration,
			eventIds: events.map((event) => event.eventId),
			createdAt: now,
			leaseUntil: now + (this.options.claimLeaseMs ?? CLAIM_LEASE_MS),
			status: "active",
		};
		this.store.apply({ type: "inbox.claim", claim });
		return { claim: this.store.read().claims[claim.claimId]!, events };
	}

	ack(registration: HostedLiveRegistration, claimId: string, eventIds: string[]): void {
		const claim = this.requireClaim(registration, claimId, eventIds);
		this.store.apply({ type: "inbox.ack", targetKey: registration.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, at: this.now() });
		if (this.store.read().claims[claimId]?.status !== "acked") throw new HostedInboxError("claim_conflict", "Claim no longer owns its delivery events.");
		this.request(registration.targetKey);
	}

	release(registration: HostedLiveRegistration, claimId: string, eventIds: string[]): void {
		const claim = this.requireClaim(registration, claimId, eventIds);
		this.store.apply({ type: "inbox.release", targetKey: registration.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, at: this.now() });
		this.request(registration.targetKey);
	}

	submitBegin(registration: HostedLiveRegistration, claimId: string, eventIds: string[], attemptId: string): void {
		const claim = this.requireClaim(registration, claimId, eventIds);
		this.store.apply({ type: "inbox.submit_begin", targetKey: registration.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, attemptId, at: this.now() });
	}

	submitSettle(registration: HostedLiveRegistration, claimId: string, eventIds: string[], attemptId: string, outcome: "submitted" | "pending" | "needs_attention"): void {
		const claim = this.requireClaim(registration, claimId, eventIds);
		this.store.apply({ type: "inbox.submit_settle", targetKey: registration.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, attemptId, outcome, at: this.now() });
		this.request(registration.targetKey);
	}

	status(registration: HostedLiveRegistration) {
		this.releaseExpired();
		let pending = 0;
		let claimed = 0;
		let submitting = 0;
		let submitted = 0;
		let needsAttention = 0;
		let acknowledged = 0;
		const state = this.store.read();
		for (const event of Object.values(state.events)) {
			if (!hostedEventRoutesToTarget(state, event, registration.targetKey)) continue;
			if (event.delivery.status === "pending") pending++;
			else if (event.delivery.status === "claimed") claimed++;
			else if (event.delivery.status === "submitting") submitting++;
			else if (event.delivery.status === "submitted") submitted++;
			else if (event.delivery.status === "needs_attention") needsAttention++;
			else acknowledged++;
		}
		const wakeId = this.store.read().wakes[registration.targetKey]?.wakeId;
		return { pending, claimed, submitting, submitted, needsAttention, acknowledged, ...(wakeId ? { wakeId } : {}) };
	}

	close(): void {
		this.closed = true;
	}

	private clearWakeWithoutPending(targetKey: string): boolean {
		if (pendingHostedEvents(this.store.read(), targetKey).length > 0) return false;
		const stale = this.store.read().wakes[targetKey];
		if (stale) this.store.apply({ type: "wake.clear", targetKey, wakeId: stale.wakeId });
		return true;
	}

	private requireClaim(registration: HostedLiveRegistration, claimId: string, eventIds: string[]): HostedClaim {
		const claim = this.store.read().claims[claimId];
		if (!claim) throw new HostedInboxError("not_found", "Claim is absent.");
		this.verifyClaimOwner(claim, registration);
		if (!sameIds(claim.eventIds, eventIds)) throw new HostedInboxError("claim_conflict", "Claim event receipt does not match.");
		return claim;
	}

	private verifyClaimOwner(claim: HostedClaim, registration: HostedLiveRegistration): void {
		if (claim.targetKey !== registration.targetKey || claim.registrationId !== registration.registrationId || claim.clientGeneration !== registration.clientGeneration) {
			throw new HostedInboxError("claim_conflict", "Claim belongs to another registration generation.");
		}
	}

	private releaseExpired(): void {
		this.store.apply({ type: "inbox.release_expired", at: this.now() });
	}

	private hasActiveClaim(targetKey: string): boolean {
		return Object.values(this.store.read().claims).some((claim) => claim.targetKey === targetKey && claim.status === "active");
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function claimIdForWake(wakeId: string): string {
	return `claim_${createHash("sha256").update(wakeId).digest("hex").slice(0, 24)}`;
}

function claimEvents(events: Record<string, HostedEvent>, claim: HostedClaim): HostedEvent[] {
	const result = claim.eventIds.map((eventId) => events[eventId]);
	if (!result.every((event): event is HostedEvent => event !== undefined)) throw new HostedInboxError("claim_conflict", "Claim event is missing from durable state.");
	return result;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedRight = [...right].sort();
	return [...left].sort().every((value, index) => value === sortedRight[index]);
}
