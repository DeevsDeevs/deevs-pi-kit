import {
	type HostedCollaboratorDriver,
	type HostedParticipant,
	type HostedTarget,
	isAgentTarget,
	isHeld,
	isPiTarget,
} from "../schemas/state.ts";
import { RuntimeError } from "../errors.ts";
import type { HerdrAgentStatus } from "../schemas/herdr.ts";
import type { LiveTargets } from "./live.ts";
import type { HostedStateStore } from "./state.ts";

export interface HostedParticipantStatus {
	participantKey: string;
	projectRoot: string;
	protocol: string;
	participantId: string;
	state: HostedParticipant["state"];
	generation: string;
	holderTargetKey?: string;
	holderLive: boolean;
	/** Herdr's view of a live native holder's tab: `blocked` means it is waiting on a human. */
	agentStatus?: HerdrAgentStatus;
	driver?: HostedCollaboratorDriver;
	profile?: "read-only" | "workspace-write";
	repo?: string;
	repoRoot?: string;
	unreadMail?: number;
	awaitingReply?: boolean;
	lastTransition: HostedParticipant["transition"];
}

export function requireTarget(store: HostedStateStore, targetKey: string): HostedTarget {
	const target = store.read().targets[targetKey];
	if (!target) throw new RuntimeError("not_found", "Runtime target is absent.");
	return target;
}

export function requireParticipant(store: HostedStateStore, participantKey: string, projectRoot: string): HostedParticipant {
	const participant = store.read().participants[participantKey];
	if (!participant || participant.projectRoot !== projectRoot) {
		throw new RuntimeError("not_found", "Participant is absent from this project.");
	}
	return participant;
}

export function participantStatus(
	store: HostedStateStore,
	live: LiveTargets,
	participant: HostedParticipant,
	includeQueue = true,
): HostedParticipantStatus {
	const holderTargetKey = participant.holderTargetKey;
	const holder = holderTargetKey ? store.read().targets[holderTargetKey] : undefined;
	const status: HostedParticipantStatus = {
		participantKey: participant.participantKey,
		projectRoot: participant.projectRoot,
		protocol: participant.protocol,
		participantId: participant.participantId,
		state: participant.state,
		generation: participant.generation,
		holderLive: isHeld(participant.state) && holderTargetKey !== undefined && live.hasLiveTarget(holderTargetKey),
		lastTransition: participant.transition,
	};
	if (holderTargetKey) status.holderTargetKey = holderTargetKey;
	if (participant.repo) status.repo = participant.repo;
	if (participant.repoRoot) status.repoRoot = participant.repoRoot;
	if (isPiTarget(holder)) status.driver = "pi";
	if (isAgentTarget(holder)) {
		status.driver = holder.driver;
		status.profile = holder.profile;
		const agentStatus = holderTargetKey ? live.agentStatus(holderTargetKey) : undefined;
		if (agentStatus) status.agentStatus = agentStatus;
	}
	if (includeQueue) Object.assign(status, mailQueue(store, participant.participantKey));
	return status;
}

/**
 * Mail is read by `messaging.read`, never claimed, so unread depth is the absence of a read time. A reply is owed only
 * while mail is unread: a Pi marks mail read at its own send or once its turn ends, a native once it sends or took the
 * turn, and Herdr reports a native mid-turn as working; mail read and answered in text owes nothing.
 */
function mailQueue(store: HostedStateStore, participantKey: string): Pick<HostedParticipantStatus, "unreadMail" | "awaitingReply"> {
	const unreadMail = Object.values(store.read().events).filter((event) => event.recipientParticipantKey === participantKey && event.readAt === undefined).length;
	return { unreadMail, awaitingReply: unreadMail > 0 };
}
