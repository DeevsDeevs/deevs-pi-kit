import { randomUUID } from "node:crypto";
import type { HostedMailboxMessageEvent, HostedParticipant } from "../hosted-types.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_RECONNECT_GRACE_MS = 60_000;

export class HostedParticipantError extends Error {
	readonly code: "not_found" | "conflict" | "busy";

	constructor(code: "not_found" | "conflict" | "busy", message: string) {
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
	queued?: { pending: number; claimed: number };
	lastTransition: HostedParticipant["transitions"][number];
}

export interface HostedParticipantCoordinatorOptions {
	now?: () => number;
	createGeneration?: () => string;
	createEventId?: () => string;
	reconnectGraceMs?: number;
	epochStartedAt?: number;
}

export interface HostedParticipantWakeRequester {
	request(targetKey: string): void;
}

export class HostedParticipantCoordinator {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly wakes: HostedParticipantWakeRequester;
	private readonly options: HostedParticipantCoordinatorOptions;
	private readonly epochStartedAt: number;
	private readonly seenTargets = new Set<string>();

	constructor(store: HostedStateStore, registrations: RuntimeRegistrationManager, wakes: HostedParticipantWakeRequester, options: HostedParticipantCoordinatorOptions = {}) {
		this.store = store;
		this.registrations = registrations;
		this.wakes = wakes;
		this.options = options;
		this.epochStartedAt = options.epochStartedAt ?? this.now();
	}

	registrationReady(targetKey: string): void {
		this.seenTargets.add(targetKey);
	}

	acquire(registration: HostedLiveRegistration, protocol: string, participantId: string, allowRevive = false): { participant: HostedParticipantStatus; revived: boolean } {
		this.seenTargets.add(registration.targetKey);
		const target = this.requireTarget(registration.targetKey);
		const participantKey = deriveParticipantKey(target.projectRoot, protocol, participantId);
		const before = this.store.read().participants[participantKey];
		if (before?.state === "ended" && !allowRevive) throw new HostedParticipantError("conflict", "Ended participant requires explicit revival authorization.");
		const latest = before?.transitions.at(-1);
		const revived = before?.state === "ended" || (before?.state === "held" && before.holderTargetKey === registration.targetKey && latest?.cause === "revive");
		this.store.apply({
			type: "participant.acquire",
			participantKey,
			projectRoot: target.projectRoot,
			protocol,
			participantId,
			targetKey: registration.targetKey,
			generation: this.createGeneration(),
			at: this.now(),
		});
		const participant = this.requireParticipant(participantKey, target.projectRoot);
		this.wakes.request(registration.targetKey);
		return { participant: this.status(participant), revived };
	}

	get(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		const target = this.requireTarget(registration.targetKey);
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
	}

	list(registration: HostedLiveRegistration): HostedParticipantStatus[] {
		const target = this.requireTarget(registration.targetKey);
		return Object.values(this.store.read().participants)
			.filter((participant) => participant.projectRoot === target.projectRoot)
			.sort((left, right) => left.protocol.localeCompare(right.protocol) || left.participantId.localeCompare(right.participantId))
			.map((participant) => this.status(participant, false));
	}

	standDown(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.stand_down");
	}

	release(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.release");
	}

	takeover(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		const target = this.requireTarget(registration.targetKey);
		const participant = this.requireParticipant(participantKey, target.projectRoot);
		const latest = participant.transitions.at(-1);
		if (participant.state === "held" && participant.holderTargetKey === registration.targetKey && latest?.cause === "takeover" && latest.previousGeneration === expectedGeneration) return this.status(participant);
		if (participant.state !== "held" || participant.generation !== expectedGeneration) throw new HostedParticipantError("conflict", "Participant state or generation changed before takeover.");
		if (participant.holderTargetKey === registration.targetKey) return this.status(participant);
		if (this.registrations.hasLiveTarget(participant.holderTargetKey!)) throw new HostedParticipantError("busy", "Participant holder is still live.");
		if (!this.seenTargets.has(participant.holderTargetKey!) && this.now() - this.epochStartedAt < (this.options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS)) {
			throw new HostedParticipantError("busy", "Participant holder is inside the Runtime reconnect grace period.");
		}
		this.store.apply({ type: "inbox.release_expired", at: this.now() });
		if (this.hasActiveClaim(participantKey)) throw new HostedParticipantError("busy", "Participant still has an active delivery claim.");
		this.store.apply({
			type: "participant.takeover",
			participantKey,
			targetKey: registration.targetKey,
			generation: this.createGeneration(),
			at: this.now(),
		});
		this.wakes.request(registration.targetKey);
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
	}

	send(registration: HostedLiveRegistration, recipientParticipantKey: string, sendId: string, body: string): HostedMailboxMessageEvent {
		const target = this.requireTarget(registration.targetKey);
		const sender = Object.values(this.store.read().participants).find((participant) => participant.projectRoot === target.projectRoot && participant.state === "held" && participant.holderTargetKey === registration.targetKey);
		if (!sender) throw new HostedParticipantError("not_found", "This Pi target does not hold a participant identity.");
		const recipient = this.requireParticipant(recipientParticipantKey, target.projectRoot);
		if (recipient.state === "ended") throw new HostedParticipantError("not_found", "Mailbox recipient has ended.");
		this.store.apply({
			type: "mailbox.send",
			senderParticipantKey: sender.participantKey,
			senderTargetKey: registration.targetKey,
			recipientParticipantKey,
			sendId,
			eventId: this.options.createEventId?.() ?? `evt_${randomUUID()}`,
			body,
			at: this.now(),
		});
		const event = Object.values(this.store.read().events).find((candidate): candidate is HostedMailboxMessageEvent => candidate.type === "mailbox.message" && candidate.payload.senderParticipantKey === sender.participantKey && candidate.payload.sendId === sendId);
		if (!event) throw new HostedParticipantError("conflict", "Mailbox send did not produce a durable event.");
		const currentRecipient = this.store.read().participants[recipientParticipantKey];
		if (currentRecipient?.state === "held") this.wakes.request(currentRecipient.holderTargetKey!);
		return event;
	}

	private leave(registration: HostedLiveRegistration, participantKey: string, type: "participant.stand_down" | "participant.release"): HostedParticipantStatus {
		const target = this.requireTarget(registration.targetKey);
		this.requireParticipant(participantKey, target.projectRoot);
		this.store.apply({ type, participantKey, targetKey: registration.targetKey, generation: this.createGeneration(), at: this.now() });
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
	}

	private status(participant: HostedParticipant, includeQueue = true): HostedParticipantStatus {
		let pending = 0;
		let claimed = 0;
		if (includeQueue) for (const event of Object.values(this.store.read().events)) {
			if (event.type !== "mailbox.message" || event.recipientParticipantKey !== participant.participantKey) continue;
			if (event.delivery.status === "pending") pending++;
			else if (event.delivery.status === "claimed") claimed++;
		}
		return {
			participantKey: participant.participantKey,
			projectRoot: participant.projectRoot,
			protocol: participant.protocol,
			participantId: participant.participantId,
			state: participant.state,
			generation: participant.generation,
			...(participant.holderTargetKey ? { holderTargetKey: participant.holderTargetKey } : {}),
			holderLive: participant.state === "held" && this.registrations.hasLiveTarget(participant.holderTargetKey!),
			...(includeQueue ? { queued: { pending, claimed } } : {}),
			lastTransition: participant.transitions.at(-1)!,
		};
	}

	private requireTarget(targetKey: string) {
		const target = this.store.read().targets[targetKey];
		if (!target) throw new HostedParticipantError("not_found", "Runtime target is absent.");
		return target;
	}

	private requireParticipant(participantKey: string, projectRoot: string): HostedParticipant {
		const participant = this.store.read().participants[participantKey];
		if (!participant || participant.projectRoot !== projectRoot) throw new HostedParticipantError("not_found", "Participant is absent from this project.");
		return participant;
	}

	private hasActiveClaim(participantKey: string): boolean {
		const state = this.store.read();
		return Object.values(state.claims).some((claim) => claim.status === "active" && claim.eventIds.some((eventId) => {
			const event = state.events[eventId];
			return event?.type === "mailbox.message" && event.recipientParticipantKey === participantKey;
		}));
	}

	private createGeneration(): string {
		return this.options.createGeneration?.() ?? `lease_${randomUUID()}`;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}
