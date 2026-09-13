export const HOSTED_PROTOCOL_VERSION = 1 as const;
export const HOSTED_MAX_DELIVERY_BATCH = 12;
export const HOSTED_MONITOR_MAX_ENTRIES = 10_000;
export const HOSTED_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const HOSTED_ACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const HOSTED_MAILBOX_MAX_BODY_BYTES = 16 * 1024;
export const HOSTED_PARTICIPANT_TRANSITION_LIMIT = 8;

export interface HostedRuntimeInstance {
	version: 1;
	runtimeId: string;
}

interface HostedTargetBase {
	targetKey: string;
	projectRoot: string;
	createdAt: number;
}

export interface HostedPiTarget extends HostedTargetBase {
	kind: "pi";
	piSessionId: string;
	piSessionFile: string;
	worktreePath?: string;
}

export type HostedCollaboratorProfile = "read-only" | "workspace-write";
export type HostedNativeCollaboratorDriver = "claude-code" | "codex";
export type HostedCollaboratorDriver = "pi" | HostedNativeCollaboratorDriver;
export interface HostedAgentSessionIdentity { source: string; agent: string; kind: "id" | "path"; value: string; }

export interface HostedHerdrLocator {
	paneId: string;
	terminalId: string;
	tabId: string;
	workspaceId: string;
}

export interface HostedAgentTarget extends HostedTargetBase {
	kind: "agent";
	agentName: string;
	driver: HostedNativeCollaboratorDriver;
	agentSession: HostedAgentSessionIdentity;
	participantKey: string;
	holderGeneration: string;
	profile: HostedCollaboratorProfile;
	clientGeneration: string;
	herdr: HostedHerdrLocator;
	worktreePath?: string;
}

export type HostedTarget = HostedPiTarget | HostedAgentTarget;

export interface HostedAgentBind {
	target: HostedAgentTarget;
	protocol: string;
	participantId: string;
	callerTargetKey: string;
	callerParticipantKey: string;
	callerGeneration: string;
	expectedParticipantGeneration?: string;
	at: number;
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

export type HostedParticipantState = "held" | "vacant" | "ended";
export type HostedParticipantTransitionCause = "acquire" | "reacquire" | "stand_down" | "release" | "takeover" | "revive";

export interface HostedParticipantTransition {
	cause: HostedParticipantTransitionCause;
	generation: string;
	holderTargetKey?: string;
	previousGeneration?: string;
	previousHolderTargetKey?: string;
	at: number;
}

export interface HostedParticipant {
	participantKey: string;
	projectRoot: string;
	protocol: string;
	participantId: string;
	state: HostedParticipantState;
	generation: string;
	holderTargetKey?: string;
	worktreePath?: string;
	outSeq: Record<string, number>;
	transitions: HostedParticipantTransition[];
	createdAt: number;
	updatedAt: number;
}

export interface HostedMonitorEventSource {
	kind: "monitor";
	id: string;
	generation: string;
	sequence: number;
}

export interface HostedParticipantEventSource {
	kind: "participant";
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

interface HostedEventBase {
	version: 1;
	eventId: string;
	dedupeKey: string;
	createdAt: number;
	summary: string;
	delivery: HostedEventDelivery;
}

export interface HostedFilesystemCreatedEvent extends HostedEventBase {
	source: HostedMonitorEventSource;
	targetKey: string;
	type: "filesystem.created";
	payload: HostedFilesystemCreatedPayload;
}

export interface HostedMailboxMessageEvent extends HostedEventBase {
	type: "mailbox.message";
	source: HostedParticipantEventSource;
	recipientParticipantKey: string;
	sendId: string;
	body: string;
	inReplyToEventId?: string;
	readAt?: number;
}

export type HostedEvent = HostedFilesystemCreatedEvent | HostedMailboxMessageEvent;

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

export interface HostedMessagingGrant {
	namespaceId: string;
	secretDigest: string;
	participantKey: string;
	holderGeneration: string;
	targetKey: string;
	clientGeneration: string;
	terminalId: string;
	configurationHash: string;
	createdAt: number;
	expiresAt: number;
	status: "active" | "revoked" | "expired";
	/** Operation ID to published event ID; a repeated operation ID returns its original event. */
	operations: Record<string, string>;
}

export interface HostedMessagingSend {
	namespaceId: string;
	operationId: string;
	recipientParticipantKey: string;
	body: string;
	inReplyToEventId?: string;
	eventId: string;
	at: number;
}

export interface HostedRuntimeState {
	version: 17;
	messaging: Record<string, HostedMessagingGrant>;
	targets: Record<string, HostedTarget>;
	monitors: Record<string, HostedMonitor>;
	participants: Record<string, HostedParticipant>;
	events: Record<string, HostedEvent>;
	dedupe: Record<string, string>;
	claims: Record<string, HostedClaim>;
	wakes: Record<string, HostedWake>;
}

export type HostedStateOperation =
	| { type: "messaging.issue"; grant: HostedMessagingGrant }
	| { type: "messaging.close"; namespaceId: string; status: "revoked" | "expired" }
	| { type: "messaging.invalidate_client"; targetKey: string; clientGeneration: string; terminalId: string }
	| ({ type: "messaging.send" } & HostedMessagingSend)
	| { type: "messaging.read"; namespaceId: string; eventId: string; at: number }
	| { type: "target.ensure"; target: HostedTarget }
	| { type: "agent.bind"; bind: HostedAgentBind }
	| { type: "monitor.create"; monitor: HostedMonitor }
	| { type: "monitor.delete"; targetKey: string; monitorId: string }
	| { type: "monitor.commit"; monitor: HostedMonitor; events: HostedFilesystemCreatedEvent[] }
	| { type: "participant.acquire"; participantKey: string; projectRoot: string; protocol: string; participantId: string; targetKey: string; generation: string; at: number }
	| { type: "participant.stand_down"; participantKey: string; targetKey: string; generation: string; expectedGeneration?: string; at: number }
	| { type: "participant.release"; participantKey: string; targetKey: string; generation: string; at: number }
	| { type: "participant.worktree.clear"; participantKey: string }
	| { type: "participant.takeover"; participantKey: string; targetKey: string; generation: string; at: number }
	| { type: "mailbox.send"; senderParticipantKey: string; expectedSenderGeneration: string; senderTargetKey: string; recipientParticipantKey: string; sendId: string; eventId: string; body: string; at: number }
	| { type: "inbox.claim"; claim: HostedClaim }
	| { type: "inbox.ack"; targetKey: string; claimId: string; eventIds: string[]; at: number }
	| { type: "inbox.reconcile"; targetKey: string; claimId: string; eventIds: string[]; at: number }
	| { type: "inbox.reconcile_many"; targetKey: string; receipts: Array<{ claimId: string; eventIds: string[] }>; at: number }
	| { type: "inbox.release"; targetKey: string; claimId: string; eventIds: string[]; at: number }
	| { type: "inbox.release_expired"; at: number }
	| { type: "retention.prune"; before: number }
	| { type: "wake.set"; wake: HostedWake }
	| { type: "wake.accept"; wakeId: string; claim: HostedClaim }
	| { type: "wake.clear"; targetKey: string; wakeId: string };
