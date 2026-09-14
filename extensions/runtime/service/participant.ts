import { randomUUID } from "node:crypto";
import {
	type HostedMailboxMessageEvent,
	type HostedParticipant,
	type HostedStateOperation,
	isEnded,
	isHeld,
} from "../hosted-types.ts";
import {
	HostedParticipantError,
	type HostedParticipantStatus,
	participantStatus,
	requireParticipant,
	requireTarget,
} from "./participant-status.ts";
import { type CollaboratorStopOptions, CollaboratorStopper, type StoppedParticipant } from "./participant-stop.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_RECONNECT_GRACE_MS = 60_000;

type LeaveOperation = Extract<HostedStateOperation, { type: "participant.stand_down" | "participant.release" }>;

export interface AcquiredParticipant {
	participant: HostedParticipantStatus;
	revived: boolean;
	transitioned: boolean;
}

export interface MessagingPublication {
	operationId: string;
	recipientParticipantKey: string;
	body: string;
	inReplyToEventId?: string;
}

export interface HostedParticipantCoordinatorOptions extends CollaboratorStopOptions {
	createEventId?: () => string;
	reconnectGraceMs?: number;
	startedAt?: number;
}

export class HostedParticipantCoordinator {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly options: HostedParticipantCoordinatorOptions;
	private readonly startedAt: number;
	private readonly seenTargets = new Set<string>();
	private readonly stopper: CollaboratorStopper;

	constructor(
		store: HostedStateStore,
		registrations: RuntimeRegistrationManager,
		options: HostedParticipantCoordinatorOptions = {},
	) {
		this.store = store;
		this.registrations = registrations;
		this.options = options;
		this.startedAt = options.startedAt ?? this.now();
		this.stopper = new CollaboratorStopper(store, registrations, options);
	}

	registrationReady(targetKey: string): void {
		this.seenTargets.add(targetKey);
	}

	acquire(registration: HostedLiveRegistration, protocol: string, participantId: string, allowRevive = false): AcquiredParticipant {
		this.seenTargets.add(registration.targetKey);
		this.stopper.assertTargetNotStopping(registration.targetKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participantKey = deriveParticipantKey(target.projectRoot, protocol, participantId);
		this.stopper.assertNotStopping(participantKey);
		const before = this.store.read().participants[participantKey];
		if (isEnded(before?.state) && !allowRevive) {
			throw new HostedParticipantError("conflict", "Ended participant requires explicit revival authorization.");
		}
		const revivedOwnHold = isHeld(before?.state)
			&& before.holderTargetKey === registration.targetKey
			&& before.transition.cause === "revive";
		const revived = isEnded(before?.state) || revivedOwnHold;
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
		const participant = requireParticipant(this.store, participantKey, target.projectRoot);
		const transitioned = !isHeld(before?.state) || before.holderTargetKey !== registration.targetKey;
		return { participant: this.status(participant), revived, transitioned };
	}

	get(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		const target = requireTarget(this.store, registration.targetKey);
		return this.status(requireParticipant(this.store, participantKey, target.projectRoot));
	}

	list(registration: HostedLiveRegistration): HostedParticipantStatus[] {
		const target = requireTarget(this.store, registration.targetKey);
		return Object.values(this.store.read().participants)
			.filter((participant) => participant.projectRoot === target.projectRoot)
			.sort((left, right) => left.protocol.localeCompare(right.protocol) || left.participantId.localeCompare(right.participantId))
			.map((participant) => this.status(participant, false));
	}

	standDown(registration: HostedLiveRegistration, participantKey: string, expectedGeneration?: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.stand_down", expectedGeneration);
	}

	standDownConfirmed(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		return this.stopper.standDownConfirmed(registration, participantKey, expectedGeneration);
	}

	stopConfirmed(
		registration: HostedLiveRegistration,
		participantKey: string,
		expectedGeneration: string,
	): Promise<StoppedParticipant> {
		return this.stopper.stopConfirmed(registration, participantKey, expectedGeneration);
	}

	release(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.release");
	}

	takeover(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.stopper.assertNotStopping(participantKey);
		this.stopper.assertTargetNotStopping(registration.targetKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participant = requireParticipant(this.store, participantKey, target.projectRoot);
		if (takeoverAlreadyApplied(participant, registration.targetKey, expectedGeneration)) return this.status(participant);
		if (!isHeld(participant.state) || participant.generation !== expectedGeneration) {
			throw new HostedParticipantError("conflict", "Participant state or generation changed before takeover.");
		}
		if (participant.holderTargetKey === registration.targetKey) return this.status(participant);
		const previousHolderTargetKey = participant.holderTargetKey;
		if (!previousHolderTargetKey) throw new HostedParticipantError("conflict", "Held participant has no holder target.");
		if (this.registrations.hasLiveTarget(previousHolderTargetKey)) {
			throw new HostedParticipantError("busy", "Participant holder is still live.");
		}
		const graceMs = this.options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
		if (!this.seenTargets.has(previousHolderTargetKey) && this.now() - this.startedAt < graceMs) {
			throw new HostedParticipantError("busy", "Participant holder is inside the Runtime reconnect grace period.");
		}
		this.store.apply({
			type: "participant.takeover",
			participantKey,
			targetKey: registration.targetKey,
			generation: this.createGeneration(),
			at: this.now(),
		});
		return this.status(requireParticipant(this.store, participantKey, target.projectRoot));
	}

	send(
		registration: HostedLiveRegistration,
		senderParticipantKey: string,
		expectedSenderGeneration: string,
		recipientParticipantKey: string,
		sendId: string,
		body: string,
	): HostedMailboxMessageEvent {
		const target = requireTarget(this.store, registration.targetKey);
		this.stopper.assertNotStopping(senderParticipantKey);
		const sender = requireParticipant(this.store, senderParticipantKey, target.projectRoot);
		if (!holdsIdentity(sender, expectedSenderGeneration, registration.targetKey)) {
			throw new HostedParticipantError("conflict", "Sender identity or generation changed before send.");
		}
		const recipient = requireParticipant(this.store, recipientParticipantKey, target.projectRoot);
		if (isEnded(recipient.state)) throw new HostedParticipantError("not_found", "Mailbox recipient has ended.");
		this.store.apply({
			type: "mailbox.send",
			senderParticipantKey: sender.participantKey,
			expectedSenderGeneration,
			senderTargetKey: registration.targetKey,
			recipientParticipantKey,
			sendId,
			eventId: this.createEventId(),
			body,
			at: this.now(),
		});
		const event = Object.values(this.store.read().events)
			.find((candidate): candidate is HostedMailboxMessageEvent => candidate.type === "mailbox.message"
				&& candidate.source.id === sender.participantKey
				&& candidate.sendId === sendId);
		if (!event) throw new HostedParticipantError("conflict", "Mailbox send did not produce a durable event.");
		return event;
	}

	sendMessaging(registration: HostedLiveRegistration, namespaceId: string, publication: MessagingPublication): void {
		const grant = this.store.read().messaging[namespaceId];
		if (!grant || grant.targetKey !== registration.targetKey) {
			throw new HostedParticipantError("conflict", "Messaging namespace does not belong to this target.");
		}
		this.stopper.assertNotStopping(grant.participantKey);
		this.stopper.assertTargetNotStopping(grant.targetKey);
		this.store.apply({ type: "messaging.send", namespaceId, ...publication, eventId: this.createEventId(), at: this.now() });
	}

	private leave(
		registration: HostedLiveRegistration,
		participantKey: string,
		type: "participant.stand_down" | "participant.release",
		expectedGeneration?: string,
	): HostedParticipantStatus {
		this.stopper.assertNotStopping(participantKey);
		const target = requireTarget(this.store, registration.targetKey);
		requireParticipant(this.store, participantKey, target.projectRoot);
		const operation: LeaveOperation = {
			type,
			participantKey,
			targetKey: registration.targetKey,
			generation: this.createGeneration(),
			at: this.now(),
		};
		if (operation.type === "participant.stand_down" && expectedGeneration !== undefined) operation.expectedGeneration = expectedGeneration;
		this.store.apply(operation);
		return this.status(requireParticipant(this.store, participantKey, target.projectRoot));
	}

	private status(participant: HostedParticipant, includeQueue = true): HostedParticipantStatus {
		return participantStatus(this.store, this.registrations, participant, includeQueue);
	}

	private createEventId(): string {
		return this.options.createEventId?.() ?? `evt_${randomUUID()}`;
	}

	private createGeneration(): string {
		return this.options.createGeneration?.() ?? `lease_${randomUUID()}`;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}

function holdsIdentity(participant: HostedParticipant, generation: string, targetKey: string): boolean {
	return isHeld(participant.state)
		&& participant.generation === generation
		&& participant.holderTargetKey === targetKey;
}

function takeoverAlreadyApplied(participant: HostedParticipant, targetKey: string, expectedGeneration: string): boolean {
	return isHeld(participant.state)
		&& participant.holderTargetKey === targetKey
		&& participant.transition.cause === "takeover"
		&& participant.transition.previousGeneration === expectedGeneration;
}
