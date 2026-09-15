import type { HostedAgentTarget, HostedMessagingGrant, HostedTarget } from "../../schemas/state.ts";

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
	| { type: "messaging.read"; namespaceId: string; eventIds: string[]; at: number }
	| { type: "target.ensure"; target: HostedTarget }
	| { type: "agent.bind"; bind: HostedAgentBind }
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
			/** "stop" records that the holder's process was closed, so a later start must not try to replace it. */
			cause?: "stand_down" | "stop";
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
	| { type: "retention.prune"; before: number; readBefore?: number };
