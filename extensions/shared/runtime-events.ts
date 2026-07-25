import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_EVENT_ENTRY = "deevs.runtime-event-op.v1";

export type RuntimeSourceKind = "subagent" | "subagent-group" | "job" | "mission";
export type RuntimeEventType = "attention" | "terminal";
export type RuntimeTerminalStatus = "completed" | "partial" | "failed" | "cancelled" | "timeout" | "limited" | "blocked" | "lost";
export type RuntimeDeliveryStatus = "pending" | "claimed" | "acked";

export interface RuntimeSource {
	kind: RuntimeSourceKind;
	id: string;
	generation: string;
}

export interface RuntimeUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

export function toToolUsage(usage: RuntimeUsage): Usage {
	const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return {
		input: usage.inputTokens,
		output: usage.outputTokens,
		cacheRead: usage.cacheReadTokens,
		cacheWrite: usage.cacheWriteTokens,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costUsd },
	};
}

export interface RuntimeEvent {
	version: 1;
	id: string;
	dedupeKey: string;
	source: RuntimeSource;
	type: RuntimeEventType;
	status: RuntimeTerminalStatus;
	createdAt: number;
	summary: string;
	artifactRef?: string;
	usage?: RuntimeUsage;
}

export interface RuntimeDelivery {
	status: RuntimeDeliveryStatus;
	claimedBy?: string;
	claimedAt?: number;
	ackedAt?: number;
}

export interface RuntimeEventState {
	version: 1;
	generations: Record<string, string>;
	events: Record<string, RuntimeEvent>;
	dedupe: Record<string, string>;
	deliveries: Record<string, RuntimeDelivery>;
}

export type RuntimeEventOperation =
	| { type: "activate"; source: Omit<RuntimeSource, "generation">; generation: string }
	| { type: "emit"; event: RuntimeEvent }
	| { type: "claim"; eventId: string; claimant: string; at: number }
	| { type: "ack"; eventId: string; claimant: string; at: number }
	| { type: "release"; eventId: string; claimant: string; at: number }
	| { type: "release_stale_claims"; at: number; staleAfterMs: number };

export function emptyRuntimeEventState(): RuntimeEventState {
	return { version: 1, generations: {}, events: {}, dedupe: {}, deliveries: {} };
}

export function runtimeSourceKey(source: Pick<RuntimeSource, "kind" | "id">): string {
	return `${source.kind}:${source.id}`;
}

export function reduceRuntimeEvent(state: RuntimeEventState, operation: RuntimeEventOperation): RuntimeEventState {
	if (operation.type === "activate") {
		const key = runtimeSourceKey(operation.source);
		if (state.generations[key] === operation.generation) return state;
		return { ...state, generations: { ...state.generations, [key]: operation.generation } };
	}

	if (operation.type === "emit") {
		const { event } = operation;
		const key = runtimeSourceKey(event.source);
		const generation = state.generations[key];
		if (generation && generation !== event.source.generation) return state;
		if (state.events[event.id] || state.dedupe[event.dedupeKey]) return state;
		return {
			...state,
			generations: generation ? state.generations : { ...state.generations, [key]: event.source.generation },
			events: { ...state.events, [event.id]: event },
			dedupe: { ...state.dedupe, [event.dedupeKey]: event.id },
			deliveries: { ...state.deliveries, [event.id]: { status: "pending" } },
		};
	}

	if (operation.type === "release_stale_claims") {
		let next = state;
		for (const [eventId, candidate] of Object.entries(state.deliveries)) {
			if (candidate.status !== "claimed" || candidate.claimedAt === undefined) continue;
			if (operation.at - candidate.claimedAt < operation.staleAfterMs) continue;
			next = withDelivery(next, eventId, { status: "pending" });
		}
		return next;
	}

	const event = state.events[operation.eventId];
	if (!event || !isCurrentEvent(state, event)) return state;
	const delivery = state.deliveries[operation.eventId];
	if (!delivery) return state;

	if (operation.type === "claim") {
		if (delivery.status === "acked") return state;
		if (delivery.status === "claimed" && delivery.claimedBy !== operation.claimant) return state;
		return withDelivery(state, operation.eventId, {
			status: "claimed",
			claimedBy: operation.claimant,
			claimedAt: operation.at,
		});
	}

	if (operation.type === "ack") {
		if (delivery.status === "acked") return state;
		if (delivery.status !== "claimed" || delivery.claimedBy !== operation.claimant) return state;
		return withDelivery(state, operation.eventId, { ...delivery, status: "acked", ackedAt: operation.at });
	}
	if (operation.type === "release") {
		if (delivery.status !== "claimed" || delivery.claimedBy !== operation.claimant) return state;
		return withDelivery(state, operation.eventId, { status: "pending" });
	}

	return state;
}

export function replayRuntimeEventEntries(entries: readonly unknown[]): RuntimeEventState {
	let state = emptyRuntimeEventState();
	for (const entry of entries) {
		const record = asRecord(entry);
		if (record?.type !== "custom" || record.customType !== RUNTIME_EVENT_ENTRY) continue;
		const operation = record.data;
		if (!isRuntimeEventOperation(operation)) continue;
		state = reduceRuntimeEvent(state, operation);
	}
	return state;
}

export class RuntimeEventJournal {
	private state = emptyRuntimeEventState();

	restore(entries: readonly unknown[]): void {
		this.state = replayRuntimeEventEntries(entries);
	}

	read(): RuntimeEventState {
		return this.state;
	}

	record(pi: ExtensionAPI, operation: RuntimeEventOperation): boolean {
		const next = reduceRuntimeEvent(this.state, operation);
		if (next === this.state) return false;
		pi.appendEntry(RUNTIME_EVENT_ENTRY, operation);
		this.state = next;
		return true;
	}
}

export const runtimeEvents = new RuntimeEventJournal();

export function pendingRuntimeEvents(state: RuntimeEventState): RuntimeEvent[] {
	return Object.values(state.events)
		.filter((event) => isCurrentEvent(state, event) && state.deliveries[event.id]?.status === "pending")
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function isRuntimeEventOperation(value: unknown): value is RuntimeEventOperation {
	const record = asRecord(value);
	if (!record || typeof record.type !== "string") return false;
	if (record.type === "activate") {
		const source = asRecord(record.source);
		return isSourceIdentity(source) && typeof record.generation === "string";
	}
	if (record.type === "emit") return isRuntimeEvent(record.event);
	if (record.type === "claim" || record.type === "ack" || record.type === "release") {
		return typeof record.eventId === "string" && typeof record.claimant === "string" && typeof record.at === "number";
	}
	if (record.type === "release_stale_claims") return typeof record.at === "number" && typeof record.staleAfterMs === "number";
	return false;
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
	const event = asRecord(value);
	const source = asRecord(event?.source);
	return event?.version === 1
		&& typeof event.id === "string"
		&& typeof event.dedupeKey === "string"
		&& isSourceIdentity(source)
		&& typeof source.generation === "string"
		&& (event.type === "attention" || event.type === "terminal")
		&& typeof event.status === "string"
		&& typeof event.createdAt === "number"
		&& typeof event.summary === "string";
}

function isSourceIdentity(value: Record<string, unknown> | undefined): value is Record<string, unknown> & { kind: RuntimeSourceKind; id: string } {
	return !!value
		&& ["subagent", "subagent-group", "workflow", "job", "mission"].includes(String(value.kind))
		&& typeof value.id === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isCurrentEvent(state: RuntimeEventState, event: RuntimeEvent): boolean {
	return state.generations[runtimeSourceKey(event.source)] === event.source.generation;
}

function withDelivery(state: RuntimeEventState, eventId: string, delivery: RuntimeDelivery): RuntimeEventState {
	return { ...state, deliveries: { ...state.deliveries, [eventId]: delivery } };
}
