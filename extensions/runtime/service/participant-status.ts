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
 * Mail is read by `messaging.read`, never claimed, so unread depth is the absence of a read time.
 * A reply is owed while mail is unread or the latest read is newer than the participant's latest send.
 */
function mailQueue(store: HostedStateStore, participantKey: string): Pick<HostedParticipantStatus, "unreadMail" | "awaitingReply"> {
	let unreadMail = 0;
	let lastRead = -1;
	let lastSent = -1;
	for (const event of Object.values(store.read().events)) {
		if (event.source.id === participantKey) lastSent = Math.max(lastSent, event.createdAt);
		if (event.recipientParticipantKey !== participantKey) continue;
		if (event.readAt === undefined) unreadMail++;
		else lastRead = Math.max(lastRead, event.readAt);
	}
	return { unreadMail, awaitingReply: unreadMail > 0 || lastRead > lastSent };
}
