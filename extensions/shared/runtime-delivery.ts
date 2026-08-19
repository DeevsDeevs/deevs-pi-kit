import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	pendingRuntimeEvents,
	runtimeEvents,
	type RuntimeEvent,
} from "./runtime-events.ts";

export const RUNTIME_DELIVERY_MESSAGE = "deevs.runtime-delivery.v1";
const STALE_CLAIM_MS = 30_000;
const MAX_EVENTS_PER_DELIVERY = 12;

export class RuntimeDeliveryCoordinator {
	private pi?: ExtensionAPI;
	private ctx?: ExtensionContext;
	private delivering = false;
	private retryTimer?: NodeJS.Timeout;
	private readonly confirmationTimers = new Map<string, NodeJS.Timeout>();
	private retryAttempts = 0;

	private readonly confirmationMs: number;

	constructor(confirmationMs = STALE_CLAIM_MS) { this.confirmationMs = confirmationMs; }

	initialize(pi: ExtensionAPI): void {
		this.pi = pi;
	}

	restore(ctx: ExtensionContext): void {
		this.ctx = ctx;
		runtimeEvents.restore(ctx.sessionManager.getBranch());
		this.acknowledgeDelivered(ctx);
		if (this.pi) runtimeEvents.record(this.pi, { type: "release_stale_claims", at: Date.now(), staleAfterMs: STALE_CLAIM_MS });
	}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	clearContext(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		for (const timer of this.confirmationTimers.values()) clearTimeout(timer);
		this.retryTimer = undefined;
		this.confirmationTimers.clear();
		this.retryAttempts = 0;
		this.ctx = undefined;
	}

	async maybeDeliver(): Promise<void> {
		if (this.delivering || !this.pi || !this.ctx) return;
		let idle = false;
		try {
			idle = this.ctx.isIdle() && !this.ctx.hasPendingMessages();
		} catch {
			return;
		}
		if (!idle) return;
		const events = pendingRuntimeEvents(runtimeEvents.read()).slice(0, MAX_EVENTS_PER_DELIVERY);
		if (!events.length) return;

		this.delivering = true;
		const claimant = this.ctx.sessionManager.getSessionFile() ?? "memory-session";
		try {
			for (const event of events) runtimeEvents.record(this.pi, { type: "claim", eventId: event.id, claimant, at: Date.now() });
			this.pi.sendMessage({
				customType: RUNTIME_DELIVERY_MESSAGE,
				content: deliveryContent(events),
				display: false,
				details: { version: 1, eventIds: events.map((event) => event.id), claimant },
			}, { triggerTurn: true, deliverAs: "followUp" });
			this.retryAttempts = 0;
			this.watchConfirmation(events.map((event) => event.id), claimant);
		} catch {
			for (const event of events) runtimeEvents.record(this.pi, { type: "release", eventId: event.id, claimant, at: Date.now() });
			this.scheduleRetry();
		} finally {
			this.delivering = false;
		}
	}

	private watchConfirmation(eventIds: string[], claimant: string): void {
		for (const eventId of eventIds) {
			const previous = this.confirmationTimers.get(eventId);
			if (previous) clearTimeout(previous);
			const timer = setTimeout(() => {
				this.confirmationTimers.delete(eventId);
				if (!this.pi || !this.ctx) return;
				this.acknowledgeDelivered(this.ctx);
				const delivery = runtimeEvents.read().deliveries[eventId];
				if (delivery?.status === "claimed" && delivery.claimedBy === claimant) runtimeEvents.record(this.pi, { type: "release", eventId, claimant, at: Date.now() });
				void this.maybeDeliver();
			}, this.confirmationMs);
			timer.unref?.();
			this.confirmationTimers.set(eventId, timer);
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer || this.retryAttempts >= 3) return;
		this.retryAttempts++;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.maybeDeliver();
		}, 250 * this.retryAttempts);
		this.retryTimer.unref?.();
	}

	acknowledgeMessage(message: unknown): void {
		if (!this.pi) return;
		const record = asRecord(message);
		if (record?.role !== "custom" || record.customType !== RUNTIME_DELIVERY_MESSAGE) return;
		const details = asRecord(record.details);
		const claimant = typeof details?.claimant === "string" ? details.claimant : undefined;
		if (!claimant || !Array.isArray(details?.eventIds)) return;
		for (const eventId of details.eventIds) if (typeof eventId === "string") {
			runtimeEvents.record(this.pi, { type: "ack", eventId, claimant, at: Date.now() });
			const timer = this.confirmationTimers.get(eventId);
			if (timer) clearTimeout(timer);
			this.confirmationTimers.delete(eventId);
		}
	}

	acknowledgeDelivered(ctx: ExtensionContext): void {
		if (!this.pi) return;
		const delivered = new Map<string, string>();
		for (const entry of ctx.sessionManager.getBranch() as readonly unknown[]) {
			const record = asRecord(entry);
			if (record?.type !== "custom_message" || record.customType !== RUNTIME_DELIVERY_MESSAGE) continue;
			const details = asRecord(record.details);
			const claimant = typeof details?.claimant === "string" ? details.claimant : undefined;
			if (!claimant || !Array.isArray(details?.eventIds)) continue;
			for (const id of details.eventIds) if (typeof id === "string") delivered.set(id, claimant);
		}
		for (const [eventId, claimant] of delivered) {
			runtimeEvents.record(this.pi, { type: "ack", eventId, claimant, at: Date.now() });
			const timer = this.confirmationTimers.get(eventId);
			if (timer) clearTimeout(timer);
			this.confirmationTimers.delete(eventId);
		}
	}
}

export const runtimeDelivery = new RuntimeDeliveryCoordinator();

export function requestRuntimeDelivery(): void {
	void runtimeDelivery.maybeDeliver();
}

function deliveryContent(events: RuntimeEvent[]): string {
	const lines = events.map((event) => `- ${event.source.kind} ${event.source.id} [${event.status}]: ${event.summary}`);
	return [
		`Background work reached a terminal state.`,
		...lines,
		`Continue runnable independent work first. Collect structured results with the relevant wait/read tool when they become the next dependency or final-settlement gate.`,
	].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
