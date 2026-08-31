import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RUNTIME_EVENT_ENTRY = "deevs.runtime-event-op.v1";

export const RUNTIME_SOURCE_KINDS = ["subagent", "subagent-group", "job", "mission"] as const;
export type RuntimeSourceKind = typeof RUNTIME_SOURCE_KINDS[number];
export type RuntimeEventType = "attention" | "terminal";
export type RuntimeTerminalStatus = "completed" | "partial" | "failed" | "cancelled" | "timeout" | "limited" | "blocked" | "lost";
export type RuntimeDeliveryPolicy = "notify" | "record_only";
export type RuntimeDeliveryStatus = "pending" | "claimed" | "acked";

export interface RuntimeSource {
	kind: RuntimeSourceKind;
	id: string;
	generation: string;
}

type RuntimeSourceIdentity = Pick<RuntimeSource, "kind" | "id">;

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
	delivery?: RuntimeDeliveryPolicy;
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

interface PersistedRuntimeSource {
	kind?: RuntimeSourceKind;
	id?: string;
	generation?: string;
}

interface PersistedRuntimeUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
}

interface PersistedRuntimeEvent {
	version?: number;
	id?: string;
	dedupeKey?: string;
	source?: PersistedRuntimeSource | null;
	type?: RuntimeEventType;
	status?: RuntimeTerminalStatus;
	delivery?: RuntimeDeliveryPolicy;
	createdAt?: number;
	summary?: string;
	artifactRef?: string;
	usage?: PersistedRuntimeUsage | null;
}

interface PersistedRuntimeEventOperation {
	type?: RuntimeEventOperation["type"];
	source?: PersistedRuntimeSource | null;
	generation?: string;
	event?: PersistedRuntimeEvent | null;
	eventId?: string;
	claimant?: string;
	at?: number;
	staleAfterMs?: number;
}

interface PersistedRuntimeEventEntry {
	type?: string;
	customType?: string;
	data?: PersistedRuntimeEventOperation | null;
}

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
			deliveries: {
				...state.deliveries,
				[event.id]: event.delivery === "record_only" ? { status: "acked", ackedAt: event.createdAt } : { status: "pending" },
			},
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
		// SAFETY: Session entries are not trusted; the exact operation decoder below validates every consumed field before replay.
		const record = entry as PersistedRuntimeEventEntry | null;
		if (record?.type !== "custom" || record.customType !== RUNTIME_EVENT_ENTRY || !record.data) continue;
		const operation = decodeRuntimeEventOperation(record.data);
		if (!operation) continue;
		state = reduceRuntimeEvent(state, operation);
	}
	return state;
}

interface RuntimeEventStateHolder { state: RuntimeEventState }

export class RuntimeEventJournal {
	private readonly holder: RuntimeEventStateHolder;

	constructor(holder: RuntimeEventStateHolder = { state: emptyRuntimeEventState() }) { this.holder = holder; }

	restore(entries: readonly unknown[]): void {
		this.holder.state = replayRuntimeEventEntries(entries);
	}

	read(): RuntimeEventState {
		return this.holder.state;
	}

	record(pi: ExtensionAPI, operation: RuntimeEventOperation): boolean {
		const next = reduceRuntimeEvent(this.holder.state, operation);
		if (next === this.holder.state) return false;
		pi.appendEntry(RUNTIME_EVENT_ENTRY, operation);
		this.holder.state = next;
		return true;
	}
}

// SAFETY: This package exclusively owns the named hot-reload registry and initializes its exact shape below.
const globalRegistry = globalThis as typeof globalThis & { __deevsPiKitRuntimeEventState?: RuntimeEventStateHolder };
const runtimeEventState = globalRegistry.__deevsPiKitRuntimeEventState ??= { state: emptyRuntimeEventState() };
export const runtimeEvents = new RuntimeEventJournal(runtimeEventState);

export function pendingRuntimeEvents(state: RuntimeEventState): RuntimeEvent[] {
	return Object.values(state.events)
		.filter((event) => event.delivery !== "record_only" && isCurrentEvent(state, event) && state.deliveries[event.id]?.status === "pending")
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function consumeRuntimeEvent(pi: ExtensionAPI, eventId: string, claimant: string): boolean {
	const delivery = runtimeEvents.read().deliveries[eventId];
	if (!delivery || delivery.status === "acked") return delivery?.status === "acked";
	const at = Date.now();
	if (delivery.status === "pending") runtimeEvents.record(pi, { type: "claim", eventId, claimant, at });
	const claimed = runtimeEvents.read().deliveries[eventId];
	if (claimed?.status === "claimed" && claimed.claimedBy === claimant) runtimeEvents.record(pi, { type: "ack", eventId, claimant, at });
	return runtimeEvents.read().deliveries[eventId]?.status === "acked";
}

function decodeRuntimeEventOperation(record: PersistedRuntimeEventOperation): RuntimeEventOperation | undefined {
	try {
		if (record.type === "activate" && isSourceIdentity(record.source) && isString(record.generation)) {
			return { type: "activate", source: { kind: record.source.kind, id: record.source.id }, generation: record.generation };
		}
		if (record.type === "emit" && isRuntimeEvent(record.event)) return { type: "emit", event: record.event };
		if ((record.type === "claim" || record.type === "ack" || record.type === "release") && isString(record.eventId) && isString(record.claimant) && isFiniteNumber(record.at)) {
			return { type: record.type, eventId: record.eventId, claimant: record.claimant, at: record.at };
		}
		if (record.type === "release_stale_claims" && isFiniteNumber(record.at) && isFiniteNumber(record.staleAfterMs)) {
			return { type: "release_stale_claims", at: record.at, staleAfterMs: record.staleAfterMs };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function isRuntimeEvent(event: PersistedRuntimeEvent | null | undefined): event is RuntimeEvent {
	if (!event || !event.source) return false;
	return event.version === 1
		&& nonEmptyString(event.id)
		&& nonEmptyString(event.dedupeKey)
		&& isSourceIdentity(event.source)
		&& nonEmptyString(event.source.generation)
		&& (event.type === "attention" || event.type === "terminal")
		&& event.status !== undefined
		&& ["completed", "partial", "failed", "cancelled", "timeout", "limited", "blocked", "lost"].includes(event.status)
		&& (event.delivery === undefined || event.delivery === "notify" || event.delivery === "record_only")
		&& isFiniteNumber(event.createdAt)
		&& isString(event.summary)
		&& (event.artifactRef === undefined || isString(event.artifactRef))
		&& (event.usage === undefined || isRuntimeUsage(event.usage));
}

function isSourceIdentity(value: PersistedRuntimeSource | null | undefined): value is PersistedRuntimeSource & RuntimeSourceIdentity {
	return !!value
		&& RUNTIME_SOURCE_KINDS.some((kind) => kind === value.kind)
		&& nonEmptyString(value.id);
}

function isRuntimeUsage(usage: PersistedRuntimeUsage | null): usage is RuntimeUsage {
	return !!usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd].every((amount) => Number.isFinite(amount) && Number(amount) >= 0);
}

function nonEmptyString(value: string | undefined): value is string {
	return value !== undefined && value.trim().length > 0;
}

function isString(value: string | undefined): value is string {
	return value !== undefined && String.prototype.valueOf.call(value) === value;
}

function isFiniteNumber(value: number | undefined): value is number {
	return Number.isFinite(value);
}

function isCurrentEvent(state: RuntimeEventState, event: RuntimeEvent): boolean {
	return state.generations[runtimeSourceKey(event.source)] === event.source.generation;
}

function withDelivery(state: RuntimeEventState, eventId: string, delivery: RuntimeDelivery): RuntimeEventState {
	return { ...state, deliveries: { ...state.deliveries, [eventId]: delivery } };
}
