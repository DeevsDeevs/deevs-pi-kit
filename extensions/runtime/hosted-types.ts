import type {
	HostedAgentTarget,
	HostedClaim,
	HostedFilesystemCreatedEvent,
	HostedMessagingGrant,
	HostedMonitor,
	HostedTarget,
	HostedWake,
} from "./schemas/state.ts";

export {
	HOSTED_ACK_RETENTION_MS,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
	HOSTED_PROTOCOL_VERSION,
	HOSTED_STATE_MAX_BYTES,
} from "./schemas/common.ts";

export type {
	HostedAgentTarget,
	HostedClaim,
	HostedCollaboratorDriver,
	HostedCollaboratorProfile,
	HostedEvent,
	HostedEventDelivery,
	HostedFileObservation,
	HostedFilesystemCreatedEvent,
	HostedHerdrLocator,
	HostedMailboxMessageEvent,
	HostedMessagingGrant,
	HostedMonitor,
	HostedNativeCollaboratorDriver,
	HostedParticipant,
	HostedParticipantState,
	HostedParticipantTransition,
	HostedRuntimeInstance,
	HostedRuntimeState,
	HostedTarget,
	HostedWake,
} from "./schemas/state.ts";

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

export interface HostedMessagingSend {
	namespaceId: string;
	operationId: string;
	recipientParticipantKey: string;
	body: string;
	inReplyToEventId?: string;
	eventId: string;
	at: number;
}

export type HostedStateOperation =
	| { type: "messaging.issue"; grant: HostedMessagingGrant }
	| { type: "messaging.expire"; namespaceId: string }
	| ({ type: "messaging.send" } & HostedMessagingSend)
	| { type: "messaging.read"; namespaceId: string; eventId: string; at: number }
	| { type: "target.ensure"; target: HostedTarget }
	| { type: "agent.bind"; bind: HostedAgentBind }
	| { type: "monitor.create"; monitor: HostedMonitor }
	| { type: "monitor.delete"; targetKey: string; monitorId: string }
	| { type: "monitor.commit"; monitor: HostedMonitor; events: HostedFilesystemCreatedEvent[] }
	| {
			type: "participant.acquire";
			participantKey: string;
			projectRoot: string;
			protocol: string;
			participantId: string;
			targetKey: string;
			generation: string;
			at: number;
	  }
	| {
			type: "participant.stand_down";
			participantKey: string;
			targetKey: string;
			generation: string;
			expectedGeneration?: string;
			at: number;
	  }
	| { type: "participant.release"; participantKey: string; targetKey: string; generation: string; at: number }
	| { type: "participant.worktree.clear"; participantKey: string }
	| { type: "participant.takeover"; participantKey: string; targetKey: string; generation: string; at: number }
	| {
			type: "mailbox.send";
			senderParticipantKey: string;
			expectedSenderGeneration: string;
			senderTargetKey: string;
			recipientParticipantKey: string;
			sendId: string;
			eventId: string;
			body: string;
			at: number;
	  }
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
