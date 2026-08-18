export const HOSTED_PROTOCOL_VERSION = 1 as const;
export const HOSTED_MAX_DELIVERY_BATCH = 12;
export const HOSTED_MONITOR_MAX_ENTRIES = 10_000;
export const HOSTED_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const HOSTED_ACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface HostedRuntimeInstance {
	version: 1;
	runtimeId: string;
}

export interface HostedTarget {
	targetKey: string;
	projectRoot: string;
	piSessionId: string;
	piSessionFile: string;
	createdAt: number;
}

export interface HostedFileObservation {
	relativePath: string;
	size: number;
	mtimeMs: number;
	stableSince: number;
	present: boolean;
	emitted: boolean;
}

export interface HostedMonitor {
	monitorId: string;
	targetKey: string;
	generation: string;
	directory: string;
	settleMs: number;
	status: "watching" | "degraded";
	sequence: number;
	entries: Record<string, HostedFileObservation>;
	createdAt: number;
	updatedAt: number;
}

export interface HostedEventSource {
	kind: "monitor";
	id: string;
	generation: string;
	sequence: number;
}

export interface HostedFilesystemCreatedPayload {
	relativePath: string;
	path: string;
	fileType: "regular";
	size: number;
	mtimeMs: number;
}

export type HostedEventDelivery =
	| { status: "pending"; latestClaimId?: string }
	| { status: "claimed"; claimId: string }
	| { status: "acked"; claimId: string; ackedAt: number };

export interface HostedEvent {
	version: 1;
	eventId: string;
	dedupeKey: string;
	source: HostedEventSource;
	targetKey: string;
	type: "filesystem.created";
	createdAt: number;
	summary: string;
	payload: HostedFilesystemCreatedPayload;
	delivery: HostedEventDelivery;
}

export interface HostedClaim {
	claimId: string;
	targetKey: string;
	registrationId: string;
	clientGeneration: string;
	eventIds: string[];
	createdAt: number;
	leaseUntil: number;
	status: "active" | "released" | "acked";
	settledAt?: number;
}

export interface HostedWake {
	wakeId: string;
	targetKey: string;
	registrationId: string;
	createdAt: number;
}

export interface HostedRuntimeState {
	version: 1;
	targets: Record<string, HostedTarget>;
	monitors: Record<string, HostedMonitor>;
	events: Record<string, HostedEvent>;
	dedupe: Record<string, string>;
	claims: Record<string, HostedClaim>;
	wakes: Record<string, HostedWake>;
}

export type HostedStateOperation =
	| { type: "target.ensure"; target: HostedTarget }
	| { type: "monitor.create"; monitor: HostedMonitor }
	| { type: "monitor.delete"; targetKey: string; monitorId: string }
	| { type: "monitor.commit"; monitor: HostedMonitor; events: HostedEvent[] }
	| { type: "inbox.claim"; claim: HostedClaim }
	| { type: "inbox.ack"; targetKey: string; claimId: string; eventIds: string[]; at: number }
	| { type: "inbox.release"; targetKey: string; claimId: string; eventIds: string[]; at: number }
	| { type: "inbox.release_expired"; at: number }
	| { type: "retention.prune"; before: number }
	| { type: "wake.set"; wake: HostedWake }
	| { type: "wake.accept"; wakeId: string; claim: HostedClaim }
	| { type: "wake.clear"; targetKey: string; wakeId: string };
