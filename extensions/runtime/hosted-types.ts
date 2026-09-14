import type {
	HostedAgentTarget,
	HostedCollaboratorProfile,
	HostedFilesystemCreatedEvent,
	HostedMessagingGrant,
	HostedMonitor,
	HostedParticipantState,
	HostedPiTarget,
	HostedTarget,
} from "./schemas/state.ts";

export {
	HOSTED_ACK_RETENTION_MS,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PROTOCOL_VERSION,
	HOSTED_STATE_MAX_BYTES,
} from "./schemas/common.ts";

export type {
	HostedAgentTarget,
	HostedCollaboratorDriver,
	HostedCollaboratorProfile,
	HostedEvent,
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
	HostedPiTarget,
	HostedRuntimeInstance,
	HostedRuntimeState,
	HostedTarget,
} from "./schemas/state.ts";

export function isHeld(state: HostedParticipantState | undefined): boolean {
	return state === "held";
}

export function isVacant(state: HostedParticipantState | undefined): boolean {
	return state === "vacant";
}

export function isEnded(state: HostedParticipantState | undefined): boolean {
	return state === "ended";
}

export function isPiTarget(target: HostedTarget | undefined): target is HostedPiTarget {
	return target?.kind === "pi";
}

export function isAgentTarget(target: HostedTarget | undefined): target is HostedAgentTarget {
	return target?.kind === "agent";
}

export function isWriter(profile: HostedCollaboratorProfile | undefined): boolean {
	return profile === "workspace-write";
}

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
	| { type: "inbox.claim"; targetKey: string; leaseUntil: number }
	| { type: "inbox.ack"; targetKey: string; eventIds: string[]; at: number }
	| { type: "retention.prune"; before: number };
