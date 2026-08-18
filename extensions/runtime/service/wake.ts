import { createHash, randomUUID } from "node:crypto";
import { HOSTED_MAX_DELIVERY_BATCH, type HostedClaim, type HostedEvent, type HostedWake } from "../hosted-types.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveRegistration } from "./registration.ts";
import { HostedStateStore, pendingHostedEvents } from "./state.ts";

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
	createWakeId?: () => string;
	createClaimId?: () => string;
	onError?: (error: unknown) => void;
}

export interface HostedClaimResult {
	claim: HostedClaim;
	events: HostedEvent[];
}

export class HostedWakeCoordinator {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly host: HostedHostVerifier;
	private readonly options: HostedWakeOptions;
	private readonly active = new Set<string>();
	private closed = false;

	constructor(store: HostedStateStore, registrations: RuntimeRegistrationManager, host: HostedHostVerifier, options: HostedWakeOptions = {}) {
		this.store = store;
		this.registrations = registrations;
		this.host = host;
		this.options = options;
	}

	request(targetKey: string): void {
		if (this.closed || this.active.has(targetKey)) return;
		this.active.add(targetKey);
		void this.wake(targetKey).catch((error) => this.options.onError?.(error)).finally(() => this.active.delete(targetKey));
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

	claim(registration: HostedLiveRegistration): HostedClaimResult {
		this.releaseExpired();
		const events = pendingHostedEvents(this.store.read(), registration.targetKey).slice(0, HOSTED_MAX_DELIVERY_BATCH);
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
	}

	release(registration: HostedLiveRegistration, claimId: string, eventIds: string[]): void {
		const claim = this.requireClaim(registration, claimId, eventIds);
		this.store.apply({ type: "inbox.release", targetKey: registration.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, at: this.now() });
		this.request(registration.targetKey);
	}

	status(registration: HostedLiveRegistration): { pending: number; claimed: number; acknowledged: number; wakeId?: string } {
		this.releaseExpired();
		let pending = 0;
		let claimed = 0;
		let acknowledged = 0;
		for (const event of Object.values(this.store.read().events)) {
			if (event.targetKey !== registration.targetKey) continue;
			if (event.delivery.status === "pending") pending++;
			else if (event.delivery.status === "claimed") claimed++;
			else acknowledged++;
		}
		const wakeId = this.store.read().wakes[registration.targetKey]?.wakeId;
		return { pending, claimed, acknowledged, ...(wakeId ? { wakeId } : {}) };
	}

	close(): void {
		this.closed = true;
		this.active.clear();
	}

	private async wake(targetKey: string): Promise<void> {
		this.releaseExpired();
		if (pendingHostedEvents(this.store.read(), targetKey).length === 0) {
			const stale = this.store.read().wakes[targetKey];
			if (stale) this.store.apply({ type: "wake.clear", targetKey, wakeId: stale.wakeId });
			return;
		}
		const verified = await this.registrations.verifyTarget(targetKey);
		const registration = this.registrations.authorize(verified.registrationId, verified.registrationKey);
		if (registration.host.status !== "idle" && registration.host.status !== "done") return;
		let wake: HostedWake | undefined = this.store.read().wakes[targetKey];
		if (wake && wake.registrationId !== registration.registrationId) {
			this.store.apply({ type: "wake.clear", targetKey, wakeId: wake.wakeId });
			wake = undefined;
		}
		if (!wake) {
			wake = {
				wakeId: this.options.createWakeId?.() ?? `wake_${randomUUID()}`,
				targetKey,
				registrationId: registration.registrationId,
				createdAt: this.now(),
			};
			this.store.apply({ type: "wake.set", wake });
		}
		await this.host.prompt(registration.host.paneId, `/pi-kit-runtime-wake 1 ${registration.registrationId} ${wake.wakeId}`);
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

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function claimIdForWake(wakeId: string): string {
	return `claim_${createHash("sha256").update(wakeId).digest("hex").slice(0, 24)}`;
}

function claimEvents(events: Record<string, HostedEvent>, claim: HostedClaim): HostedEvent[] {
	const result = claim.eventIds.map((eventId) => events[eventId]);
	if (result.some((event) => !event)) throw new HostedInboxError("claim_conflict", "Claim event is missing from durable state.");
	return result as HostedEvent[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedRight = [...right].sort();
	return [...left].sort().every((value, index) => value === sortedRight[index]);
}
