import { HOSTED_MAX_DELIVERY_BATCH, type HostedFilesystemCreatedEvent } from "../hosted-types.ts";
import type { HostedLiveRegistration } from "./registration.ts";
import { HostedStateStore, undeliveredHostedEvents } from "./state.ts";

const CLAIM_LEASE_MS = 30_000;

export interface HostedDeliveryOptions {
	now?: () => number;
	claimLeaseMs?: number;
}

export interface HostedInboxStatus {
	undelivered: number;
	delivered: number;
}

/**
 * At-least-once delivery: a heartbeat hands a target its undelivered events, and Pi's ack records
 * them as delivered. One claim per target with an expiry keeps two heartbeats from handing out the
 * same batch, and a Pi that dies before acking simply gets the batch again once that claim expires.
 */
export class RuntimeInbox {
	private readonly store: HostedStateStore;
	private readonly options: HostedDeliveryOptions;

	constructor(store: HostedStateStore, options: HostedDeliveryOptions = {}) {
		this.store = store;
		this.options = options;
	}

	deliver(registration: HostedLiveRegistration): HostedFilesystemCreatedEvent[] {
		const now = this.now();
		const state = this.store.read();
		const claimedUntil = state.claims[registration.targetKey] ?? 0;
		if (claimedUntil > now) return [];
		const events = undeliveredHostedEvents(state, registration.targetKey).slice(0, HOSTED_MAX_DELIVERY_BATCH);
		if (events.length === 0) return [];
		const leaseUntil = now + (this.options.claimLeaseMs ?? CLAIM_LEASE_MS);
		this.store.apply({ type: "inbox.claim", targetKey: registration.targetKey, leaseUntil });
		return events;
	}

	ack(registration: HostedLiveRegistration, eventIds: string[]): void {
		this.store.apply({ type: "inbox.ack", targetKey: registration.targetKey, eventIds, at: this.now() });
	}

	status(registration: HostedLiveRegistration): HostedInboxStatus {
		let undelivered = 0;
		let delivered = 0;
		for (const event of Object.values(this.store.read().events)) {
			if (event.type !== "filesystem.created" || event.targetKey !== registration.targetKey) continue;
			if (event.deliveredAt === undefined) undelivered++;
			else delivered++;
		}
		return { undelivered, delivered };
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}
