export const HOSTED_PROTOCOL_VERSION = 1 as const;
export const HOSTED_MAX_DELIVERY_BATCH = 12;
export const HOSTED_MONITOR_MAX_ENTRIES = 10_000;
export const HOSTED_STATE_MAX_BYTES = 8 * 1024 * 1024;
export const HOSTED_ACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const HOSTED_MAILBOX_MAX_BODY_BYTES = 16 * 1024;
export const HOSTED_PARTICIPANT_TRANSITION_LIMIT = 8;
export const HOSTED_BRIDGE_MAX_METADATA_ENTRIES = 16;
export const HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES = 1_024;
export const HOSTED_BRIDGE_FORBIDDEN_METADATA_KEYS = ["driver", "model", "persona", "profile", "token", "secret", "secrets", "credential", "credentials", "password", "api_key", "auth", "authorization", "launch_token", "reconnect_token"] as const;

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
	workspaceId?: string;
	workspaceRoot?: string;
}

export type HostedCollaboratorProfile = "read-only" | "workspace-write";

export interface HostedBridgeTarget extends HostedTargetBase {
	kind: "bridge";
	bridgeId: string;
	participantKey: string;
	holderGeneration: string;
	profile: HostedCollaboratorProfile;
	configurationHash: string;
	clientGeneration: string;
	reconnectDigest: string;
	herdr: { paneId: string; terminalId: string; tabId: string; workspaceId: string };
	metadata: Record<string, string>;
}

export type HostedTarget = HostedPiTarget | HostedBridgeTarget;

export interface HostedBridgeLaunch {
	version: 1;
	launchId: string;
	requestId: string;
	launchDigest: string;
	reconnectDigest: string;
	callerParticipantKey: string;
	callerGeneration: string;
	callerTargetKey: string;
	participantKey: string;
	protocol: string;
	participantId: string;
	expectedParticipantGeneration?: string;
	holderGeneration: string;
	targetKey: string;
	projectRoot: string;
	profile: HostedCollaboratorProfile;
	configurationHash: string;
	herdr: { paneId: string; terminalId: string; tabId: string; workspaceId: string };
	metadata: Record<string, string>;
	createdAt: number;
	expiresAt: number;
	status: "pending" | "consumed" | "cancelled" | "expired";
	consumedAt?: number;
	clientGeneration?: string;
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

export interface HostedMailboxMessagePayload {
	sendId: string;
	senderParticipantKey: string;
	recipientParticipantKey: string;
	body: string;
	fingerprint: string;
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
	source: HostedParticipantEventSource;
	recipientParticipantKey: string;
	type: "mailbox.message";
	payload: HostedMailboxMessagePayload;
}

export type HostedEvent = HostedFilesystemCreatedEvent | HostedMailboxMessageEvent;

export type HostedWorkspaceState = "provisioning" | "ready" | "bound" | "active" | "ready_handoff" | "partial" | "retained" | "needs_attention" | "integrated" | "cleaned";

export interface HostedWorkspace {
	version: 1;
	workspaceId: string;
	requestId: string;
	projectRoot: string;
	gitCommonDir: string;
	worktreePath: string;
	branchRef: string;
	participantKey: string;
	protocol: string;
	participantId: string;
	expectedParticipantGeneration?: string;
	holderGeneration: string;
	targetKey: string;
	piSessionId: string;
	profile: "workspace-write";
	launchDigest: string;
	callerParticipantKey: string;
	callerGeneration: string;
	callerTargetKey: string;
	baseCommit: string;
	headCommit: string;
	herdr?: { paneId: string; terminalId: string; tabId: string; workspaceId: string };
	state: HostedWorkspaceState;
	taskStatus?: "completed" | "failed" | "cancelled";
	commits?: string[];
	changedFiles?: number;
	additions?: number;
	deletions?: number;
	integratedHead?: string;
	createdAt: number;
	expiresAt: number;
	updatedAt: number;
}

export type HostedIntegrationState = "preparing" | "prepared" | "conflicted" | "needs_attention" | "finalized" | "cleaned";

export interface HostedIntegration {
	version: 1;
	integrationId: string;
	workspaceId: string;
	projectRoot: string;
	gitCommonDir: string;
	worktreePath: string;
	branchRef: string;
	mainBranchRef: string;
	mainHead: string;
	sourceHead: string;
	sourceCommits: string[];
	state: HostedIntegrationState;
	preparedHead?: string;
	conflictPaths?: string[];
	createdAt: number;
	updatedAt: number;
	finalizedAt?: number;
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
	version: 4;
	targets: Record<string, HostedTarget>;
	bridgeLaunches: Record<string, HostedBridgeLaunch>;
	workspaces: Record<string, HostedWorkspace>;
	integrations: Record<string, HostedIntegration>;
	monitors: Record<string, HostedMonitor>;
	participants: Record<string, HostedParticipant>;
	events: Record<string, HostedEvent>;
	dedupe: Record<string, string>;
	claims: Record<string, HostedClaim>;
	wakes: Record<string, HostedWake>;
}

export type HostedStateOperation =
	| { type: "target.ensure"; target: HostedTarget }
	| { type: "bridge.launch.ensure"; launch: HostedBridgeLaunch }
	| { type: "bridge.launch.consume"; launchId: string; launchDigest: string; clientGeneration: string; target: HostedBridgeTarget; at: number }
	| { type: "bridge.launch.cancel"; launchId: string; callerTargetKey: string; callerParticipantKey: string; callerGeneration: string; at: number }
	| { type: "bridge.launch.expire"; launchId: string; at: number }
	| { type: "workspace.ensure"; workspace: HostedWorkspace }
	| { type: "workspace.replace"; workspace: HostedWorkspace; expectedState: HostedWorkspaceState; expectedUpdatedAt: number }
	| { type: "workspace.bind"; workspaceId: string; callerTargetKey: string; callerParticipantKey: string; callerGeneration: string; herdr: { paneId: string; terminalId: string; tabId: string; workspaceId: string }; at: number }
	| { type: "workspace.consume"; workspaceId: string; launchDigest: string; target: HostedPiTarget; at: number }
	| { type: "integration.ensure"; integration: HostedIntegration }
	| { type: "integration.replace"; integration: HostedIntegration; expectedState: HostedIntegrationState; expectedUpdatedAt: number }
	| { type: "monitor.create"; monitor: HostedMonitor }
	| { type: "monitor.delete"; targetKey: string; monitorId: string }
	| { type: "monitor.commit"; monitor: HostedMonitor; events: HostedFilesystemCreatedEvent[] }
	| { type: "participant.acquire"; participantKey: string; projectRoot: string; protocol: string; participantId: string; targetKey: string; generation: string; at: number }
	| { type: "participant.stand_down"; participantKey: string; targetKey: string; generation: string; expectedGeneration?: string; at: number }
	| { type: "participant.release"; participantKey: string; targetKey: string; generation: string; at: number }
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
