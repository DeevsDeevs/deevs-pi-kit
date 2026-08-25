import { randomUUID } from "node:crypto";
import type { HostedMailboxMessageEvent, HostedParticipant, HostedTarget } from "../hosted-types.ts";
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
	stopTarget?: (target: HostedTarget) => Promise<"closed" | "already_absent" | "unmanaged">;
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
	private readonly stopping = new Set<string>();

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

	acquire(registration: HostedLiveRegistration, protocol: string, participantId: string, allowRevive = false): { participant: HostedParticipantStatus; revived: boolean; transitioned: boolean } {
		this.seenTargets.add(registration.targetKey);
		const target = this.requireTarget(registration.targetKey);
		const participantKey = deriveParticipantKey(target.projectRoot, protocol, participantId);
		this.assertNotStopping(participantKey);
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
		return { participant: this.status(participant), revived, transitioned: before?.state !== "held" || before.holderTargetKey !== registration.targetKey };
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

	standDown(registration: HostedLiveRegistration, participantKey: string, expectedGeneration?: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.stand_down", expectedGeneration);
	}

	standDownConfirmed(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		const target = this.requireTarget(registration.targetKey);
		const participant = this.requireParticipant(participantKey, target.projectRoot);
		const latest = participant.transitions.at(-1);
		if (participant.state === "vacant" && latest?.cause === "stand_down" && latest.previousGeneration === expectedGeneration) return this.status(participant);
		if (participant.state !== "held" || participant.generation !== expectedGeneration) throw new HostedParticipantError("conflict", "Participant state or generation changed before confirmed stand-down.");
		const holderTargetKey = participant.holderTargetKey!;
		this.store.apply({ type: "participant.stand_down", participantKey, targetKey: holderTargetKey, expectedGeneration, generation: this.createGeneration(), at: this.now() });
		this.wakes.request(holderTargetKey);
		if (registration.targetKey !== holderTargetKey) this.wakes.request(registration.targetKey);
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
	}

	async stopConfirmed(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): Promise<{ participant: HostedParticipantStatus; outcome: "stopped" | "already_stopped" | "unmanaged" }> {
		this.assertNotStopping(participantKey);
		this.stopping.add(participantKey);
		try {
			const caller = this.requireTarget(registration.targetKey);
			const participant = this.requireParticipant(participantKey, caller.projectRoot);
			if (participant.generation !== expectedGeneration) throw new HostedParticipantError("conflict", "Participant generation changed before confirmed stop.");
			const latest = participant.transitions.at(-1)!;
			const holderTargetKey = participant.state === "held" ? participant.holderTargetKey : participant.state === "vacant" && latest.cause === "stand_down" ? latest.previousHolderTargetKey : undefined;
			if (!holderTargetKey) throw new HostedParticipantError("conflict", "Participant has no stoppable collaborator target.");
			if (holderTargetKey === registration.targetKey) throw new HostedParticipantError("conflict", "A Pi target cannot stop its own Herdr tab.");
			const target = this.requireTarget(holderTargetKey);
			if (target.projectRoot !== caller.projectRoot) throw new HostedParticipantError("conflict", "Collaborator target belongs to another project.");
			if (!this.options.stopTarget) return { participant: this.status(participant), outcome: "unmanaged" };
			const stopped = await this.options.stopTarget(target);
			if (stopped === "unmanaged") return { participant: this.status(participant), outcome: "unmanaged" };
			const current = this.requireParticipant(participantKey, caller.projectRoot);
			if (participant.state === "held") {
				if (current.state !== "held" || current.generation !== expectedGeneration || current.holderTargetKey !== holderTargetKey) throw new HostedParticipantError("conflict", "Participant changed while its collaborator process was stopping.");
				this.store.apply({ type: "participant.stand_down", participantKey, targetKey: holderTargetKey, expectedGeneration, generation: this.createGeneration(), at: this.now() });
				this.wakes.request(holderTargetKey);
				if (registration.targetKey !== holderTargetKey) this.wakes.request(registration.targetKey);
			} else if (current.state !== "vacant" || current.generation !== expectedGeneration) {
				throw new HostedParticipantError("conflict", "Participant changed while its prior collaborator process was stopping.");
			}
			return { participant: this.status(this.requireParticipant(participantKey, caller.projectRoot)), outcome: stopped === "closed" ? "stopped" : "already_stopped" };
		} finally {
			this.stopping.delete(participantKey);
		}
	}

	release(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.release");
	}

	takeover(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		const target = this.requireTarget(registration.targetKey);
		const participant = this.requireParticipant(participantKey, target.projectRoot);
		const latest = participant.transitions.at(-1);
		if (participant.state === "held" && participant.holderTargetKey === registration.targetKey && latest?.cause === "takeover" && latest.previousGeneration === expectedGeneration) return this.status(participant);
		if (participant.state !== "held" || participant.generation !== expectedGeneration) throw new HostedParticipantError("conflict", "Participant state or generation changed before takeover.");
		if (participant.holderTargetKey === registration.targetKey) return this.status(participant);
		const previousHolderTargetKey = participant.holderTargetKey!;
		if (this.registrations.hasLiveTarget(previousHolderTargetKey)) throw new HostedParticipantError("busy", "Participant holder is still live.");
		if (!this.seenTargets.has(previousHolderTargetKey) && this.now() - this.epochStartedAt < (this.options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS)) {
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
		this.wakes.request(previousHolderTargetKey);
		this.wakes.request(registration.targetKey);
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
	}

	send(registration: HostedLiveRegistration, senderParticipantKey: string, expectedSenderGeneration: string, recipientParticipantKey: string, sendId: string, body: string): HostedMailboxMessageEvent {
		const target = this.requireTarget(registration.targetKey);
		this.assertNotStopping(senderParticipantKey);
		const sender = this.requireParticipant(senderParticipantKey, target.projectRoot);
		if (sender.state !== "held" || sender.generation !== expectedSenderGeneration || sender.holderTargetKey !== registration.targetKey) throw new HostedParticipantError("conflict", "Sender identity or generation changed before send.");
		const recipient = this.requireParticipant(recipientParticipantKey, target.projectRoot);
		if (recipient.state === "ended") throw new HostedParticipantError("not_found", "Mailbox recipient has ended.");
		this.store.apply({
			type: "mailbox.send",
			senderParticipantKey: sender.participantKey,
			expectedSenderGeneration,
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

	private leave(registration: HostedLiveRegistration, participantKey: string, type: "participant.stand_down" | "participant.release", expectedGeneration?: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		const target = this.requireTarget(registration.targetKey);
		this.requireParticipant(participantKey, target.projectRoot);
		this.store.apply({ type, participantKey, targetKey: registration.targetKey, generation: this.createGeneration(), ...(type === "participant.stand_down" && expectedGeneration !== undefined ? { expectedGeneration } : {}), at: this.now() });
		this.wakes.request(registration.targetKey);
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

	private assertNotStopping(participantKey: string): void {
		if (this.stopping.has(participantKey)) throw new HostedParticipantError("busy", "Participant collaborator process is stopping.");
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
