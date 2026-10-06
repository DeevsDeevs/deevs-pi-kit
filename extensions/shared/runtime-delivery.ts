import type { ExtensionAPI, ExtensionContext, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import {
	pendingRuntimeEvents,
	runtimeEvents,
	type RuntimeEvent,
} from "./runtime-events.ts";

export const RUNTIME_DELIVERY_MESSAGE = "deevs.runtime-delivery.v1";
const STALE_CLAIM_MS = 30_000;
const MAX_EVENTS_PER_DELIVERY = 12;

interface PersistedDeliveryDetails {
	claimant?: string;
	eventIds?: string[];
}

interface PersistedDeliveryMessage {
	type?: string;
	role?: string;
	customType?: string;
	details?: PersistedDeliveryDetails | null;
}

/** Plain data only, shared by every module graph; each graph binds its own coordinator code to it, so a /reload after an update runs the new code. */
interface DeliveryState {
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	delivering: boolean;
	retryTimer?: NodeJS.Timeout;
	confirmationTimers: Map<string, NodeJS.Timeout>;
	retryAttempts: number;
}

const freshState = (): DeliveryState => ({ delivering: false, confirmationTimers: new Map(), retryAttempts: 0 });

export class RuntimeDeliveryCoordinator {
	private readonly confirmationMs: number;
	private readonly state: DeliveryState;

	constructor(confirmationMs = STALE_CLAIM_MS, state = freshState()) {
		this.confirmationMs = confirmationMs;
		this.state = state;
	}

	initialize(pi: ExtensionAPI): void {
		this.state.pi = pi;
	}

	restore(ctx: ExtensionContext): void {
		this.state.ctx = ctx;
		runtimeEvents.restore(ctx.sessionManager.getBranch());
		this.acknowledgeDelivered(ctx);
		if (this.state.pi) runtimeEvents.record(this.state.pi, { type: "release_stale_claims", at: Date.now(), staleAfterMs: STALE_CLAIM_MS });
	}

	setContext(ctx: ExtensionContext): void {
		this.state.ctx = ctx;
	}

	clearContext(): void {
		const state = this.state;
		if (state.retryTimer) clearTimeout(state.retryTimer);
		for (const timer of state.confirmationTimers.values()) clearTimeout(timer);
		state.retryTimer = undefined;
		state.confirmationTimers.clear();
		state.retryAttempts = 0;
		state.ctx = undefined;
	}

	async maybeDeliver(): Promise<void> {
		const state = this.state;
		const { pi, ctx } = state;
		if (state.delivering || !pi || !ctx) return;
		let idle = false;
		try {
			idle = ctx.isIdle() && !ctx.hasPendingMessages();
		} catch {
			return;
		}
		if (!idle) return;
		const events = pendingRuntimeEvents(runtimeEvents.read()).slice(0, MAX_EVENTS_PER_DELIVERY);
		if (!events.length) return;

		state.delivering = true;
		const claimant = ctx.sessionManager.getSessionFile() ?? "memory-session";
		try {
			for (const event of events) runtimeEvents.record(pi, { type: "claim", eventId: event.id, claimant, at: Date.now() });
			pi.sendMessage({
				customType: RUNTIME_DELIVERY_MESSAGE,
				content: deliveryContent(events),
				display: false,
				details: { version: 1, eventIds: events.map((event) => event.id), claimant },
			}, { triggerTurn: true, deliverAs: "followUp" });
			state.retryAttempts = 0;
			this.watchConfirmation(events.map((event) => event.id), claimant);
		} catch {
			for (const event of events) runtimeEvents.record(pi, { type: "release", eventId: event.id, claimant, at: Date.now() });
			this.scheduleRetry();
		} finally {
			state.delivering = false;
		}
	}

	private watchConfirmation(eventIds: string[], claimant: string): void {
		const timers = this.state.confirmationTimers;
		for (const eventId of eventIds) {
			const previous = timers.get(eventId);
			if (previous) clearTimeout(previous);
			const timer = setTimeout(() => {
				timers.delete(eventId);
				const { pi, ctx } = this.state;
				if (!pi || !ctx) return;
				this.acknowledgeDelivered(ctx);
				const delivery = runtimeEvents.read().deliveries[eventId];
				if (delivery?.status === "claimed" && delivery.claimedBy === claimant) runtimeEvents.record(pi, { type: "release", eventId, claimant, at: Date.now() });
				void this.maybeDeliver();
			}, this.confirmationMs);
			timer.unref?.();
			timers.set(eventId, timer);
		}
	}

	private scheduleRetry(): void {
		const state = this.state;
		if (state.retryTimer || state.retryAttempts >= 3) return;
		state.retryAttempts++;
		state.retryTimer = setTimeout(() => {
			state.retryTimer = undefined;
			void this.maybeDeliver();
		}, 250 * state.retryAttempts);
		state.retryTimer.unref?.();
	}

	acknowledgeMessage(message: MessageStartEvent["message"]): void {
		const pi = this.state.pi;
		if (!pi || message.role !== "custom" || message.customType !== RUNTIME_DELIVERY_MESSAGE) return;
		// SAFETY: Pi exposes custom-message details as unknown; the exact delivery fields are validated before use.
		const details = message.details as PersistedDeliveryDetails | null;
		if (!details || !isString(details.claimant) || !Array.isArray(details.eventIds)) return;
		for (const eventId of details.eventIds) if (isString(eventId)) this.acknowledge(pi, eventId, details.claimant);
	}

	acknowledgeDelivered(ctx: ExtensionContext): void {
		const pi = this.state.pi;
		if (!pi) return;
		const delivered = new Map<string, string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			// SAFETY: Session entries remain untrusted until the exact delivery fields below are validated.
			const record = entry as PersistedDeliveryMessage | null;
			const details = record?.details;
			if (record?.type !== "custom_message" || record.customType !== RUNTIME_DELIVERY_MESSAGE || !details || !isString(details.claimant) || !Array.isArray(details.eventIds)) continue;
			for (const id of details.eventIds) if (isString(id)) delivered.set(id, details.claimant);
		}
		for (const [eventId, claimant] of delivered) this.acknowledge(pi, eventId, claimant);
	}

	private acknowledge(pi: ExtensionAPI, eventId: string, claimant: string): void {
		runtimeEvents.record(pi, { type: "ack", eventId, claimant, at: Date.now() });
		if (runtimeEvents.read().deliveries[eventId]?.status !== "acked") return;
		const timer = this.state.confirmationTimers.get(eventId);
		if (timer) clearTimeout(timer);
		this.state.confirmationTimers.delete(eventId);
	}
}

// Pi loads each extension with its own module graph; they all share one delivery state. v2 holds state, where v1 held a coordinator.
const RUNTIME_DELIVERY = Symbol.for("deevs.pi-kit.runtime-delivery.v2");
// SAFETY: This package exclusively owns the symbol-keyed slot and only ever stores DeliveryState in it.
const globalRegistry = globalThis as typeof globalThis & { [RUNTIME_DELIVERY]?: DeliveryState };
export const runtimeDelivery = new RuntimeDeliveryCoordinator(STALE_CLAIM_MS, globalRegistry[RUNTIME_DELIVERY] ??= freshState());

function deliveryContent(events: RuntimeEvent[]): string {
	const lines = events.map((event) => `- ${event.source.kind} ${event.source.id} [${event.status}]: ${event.summary}`);
	return [
		`Background work reached a terminal state.`,
		...lines,
		`Report the result to the user and do not start work the user did not ask for. The relevant wait/read tool returns the full output.`,
	].join("\n");
}

function isString(value: string | undefined): value is string {
	try {
		return value !== undefined && String.prototype.valueOf.call(value) === value;
	} catch {
		return false;
	}
}
