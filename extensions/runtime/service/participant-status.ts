import {
	type HostedCollaboratorDriver,
	type HostedParticipant,
	type HostedTarget,
	isAgentTarget,
	isHeld,
	isPiTarget,
} from "../hosted-types.ts";
import type { RuntimeRegistrationManager } from "./registration.ts";
import type { HostedStateStore } from "./state.ts";

export class HostedParticipantError extends Error {
	readonly code: "not_found" | "conflict" | "busy" | "capability_unavailable";

	constructor(code: "not_found" | "conflict" | "busy" | "capability_unavailable", message: string) {
		super(message);
		this.code = code;
	}
}

export interface HostedParticipantStatus {
	participantKey: string;
	projectRoot: string;
	protocol: string;
	participantId: string;
	state: HostedParticipant["state"];
	generation: string;
	holderTargetKey?: string;
	holderLive: boolean;
	driver?: HostedCollaboratorDriver;
	profile?: "read-only" | "workspace-write";
	unreadMail?: number;
	lastTransition: HostedParticipant["transition"];
}

export function requireTarget(store: HostedStateStore, targetKey: string): HostedTarget {
	const target = store.read().targets[targetKey];
	if (!target) throw new HostedParticipantError("not_found", "Runtime target is absent.");
	return target;
}

export function requireParticipant(store: HostedStateStore, participantKey: string, projectRoot: string): HostedParticipant {
	const participant = store.read().participants[participantKey];
	if (!participant || participant.projectRoot !== projectRoot) {
		throw new HostedParticipantError("not_found", "Participant is absent from this project.");
	}
	return participant;
}

export function participantStatus(
	store: HostedStateStore,
	registrations: RuntimeRegistrationManager,
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
		holderLive: isHeld(participant.state) && holderTargetKey !== undefined && registrations.hasLiveTarget(holderTargetKey),
		lastTransition: participant.transition,
	};
	if (holderTargetKey) status.holderTargetKey = holderTargetKey;
	if (isPiTarget(holder)) status.driver = "pi";
	if (isAgentTarget(holder)) {
		status.driver = holder.driver;
		status.profile = holder.profile;
	}
	if (includeQueue) status.unreadMail = unreadMail(store, participant.participantKey);
	return status;
}

/** Mail is read by `messaging.read`, never claimed, so unread depth is the absence of a read time. */
function unreadMail(store: HostedStateStore, participantKey: string): number {
	return Object.values(store.read().events)
		.filter((event) => event.type === "mailbox.message"
			&& event.recipientParticipantKey === participantKey
			&& event.readAt === undefined)
		.length;
}
