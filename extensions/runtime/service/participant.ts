import { randomUUID } from "node:crypto";
import { type HostedMailboxMessageEvent, type HostedParticipant, type HostedTarget, isEnded, isHeld } from "../schemas/state.ts";
import type { HostedStateOperation } from "./state/operations.ts";
import { RuntimeError } from "../errors.ts";
import {
	type HostedParticipantStatus,
	participantStatus,
	requireParticipant,
	requireTarget,
} from "./participant-status.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_RECONNECT_GRACE_MS = 60_000;

type LeaveOperation = Extract<HostedStateOperation, { type: "participant.stand_down" | "participant.release" }>;

interface AcquiredParticipant {
	participant: HostedParticipantStatus;
	revived: boolean;
	transitioned: boolean;
}

/** The one publication a messaging namespace hands its coordinator. */
interface MessagingPublication {
	operationId: string;
	recipientParticipantKey: string;
	body: string;
	inReplyToEventId?: string;
}

interface StoppedParticipant {
	participant: HostedParticipantStatus;
	outcome: "stopped" | "already_stopped" | "unmanaged";
}

export interface HostedParticipantCoordinatorOptions {
	now?: () => number;
	createGeneration?: () => string;
	createEventId?: () => string;
	reconnectGraceMs?: number;
	startedAt?: number;
	stopTarget?: (target: HostedTarget) => Promise<"closed" | "already_absent" | "unmanaged">;
	onStopped?: (target: HostedTarget, holderGeneration: string) => Promise<void> | void;
}

export class HostedParticipantCoordinator {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly options: HostedParticipantCoordinatorOptions;
	private readonly startedAt: number;
	private readonly seenTargets = new Set<string>();
	private readonly stopping = new Set<string>();
	private readonly stoppingTargets = new Set<string>();

	constructor(
		store: HostedStateStore,
		registrations: RuntimeRegistrationManager,
		options: HostedParticipantCoordinatorOptions = {},
	) {
		this.store = store;
		this.registrations = registrations;
		this.options = options;
		this.startedAt = options.startedAt ?? this.now();
	}

	registrationReady(targetKey: string): void {
		this.seenTargets.add(targetKey);
	}

	acquire(registration: HostedLiveRegistration, protocol: string, participantId: string, allowRevive = false): AcquiredParticipant {
		this.seenTargets.add(registration.targetKey);
		this.assertTargetNotStopping(registration.targetKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participantKey = deriveParticipantKey(target.projectRoot, protocol, participantId);
		this.assertNotStopping(participantKey);
		const before = this.store.read().participants[participantKey];
		if (isEnded(before?.state) && !allowRevive) {
			throw new RuntimeError("conflict", "Ended participant requires explicit revival authorization.");
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

	release(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.release");
	}

	takeover(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		this.assertTargetNotStopping(registration.targetKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participant = requireParticipant(this.store, participantKey, target.projectRoot);
		const replayed = transitionAlreadyApplied(participant, "takeover", "held", expectedGeneration);
		if (replayed && participant.holderTargetKey === registration.targetKey) return this.status(participant);
		if (!isHeld(participant.state) || participant.generation !== expectedGeneration) {
			throw new RuntimeError("conflict", "Participant state or generation changed before takeover.");
		}
		if (participant.holderTargetKey === registration.targetKey) return this.status(participant);
		const previousHolderTargetKey = participant.holderTargetKey;
		if (!previousHolderTargetKey) throw new RuntimeError("conflict", "Held participant has no holder target.");
		if (this.registrations.hasLiveTarget(previousHolderTargetKey)) {
			throw new RuntimeError("busy", "Participant holder is still live.");
		}
		const graceMs = this.options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
		if (!this.seenTargets.has(previousHolderTargetKey) && this.now() - this.startedAt < graceMs) {
			throw new RuntimeError("busy", "Participant holder is inside the Runtime reconnect grace period.");
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
		this.assertNotStopping(senderParticipantKey);
		const sender = requireParticipant(this.store, senderParticipantKey, target.projectRoot);
		if (!holdsIdentity(sender, expectedSenderGeneration, registration.targetKey)) {
			throw new RuntimeError("conflict", "Sender identity or generation changed before send.");
		}
		const recipient = requireParticipant(this.store, recipientParticipantKey, target.projectRoot);
		if (isEnded(recipient.state)) throw new RuntimeError("not_found", "Mailbox recipient has ended.");
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
			.find((candidate) => candidate.source.id === sender.participantKey && candidate.sendId === sendId);
		if (!event) throw new RuntimeError("conflict", "Mailbox send did not produce a durable event.");
		return event;
	}

	sendMessaging(registration: HostedLiveRegistration, namespaceId: string, publication: MessagingPublication): void {
		const grant = this.store.read().messaging[namespaceId];
		if (!grant || grant.targetKey !== registration.targetKey) {
			throw new RuntimeError("conflict", "Messaging namespace does not belong to this target.");
		}
		this.assertNotStopping(grant.participantKey);
		this.assertTargetNotStopping(grant.targetKey);
		this.store.apply({ type: "messaging.send", namespaceId, ...publication, eventId: this.createEventId(), at: this.now() });
	}

	private assertNotStopping(participantKey: string): void {
		if (this.stopping.has(participantKey)) throw new RuntimeError("busy", "Participant collaborator process is stopping.");
	}

	private assertTargetNotStopping(targetKey: string): void {
		if (this.stoppingTargets.has(targetKey)) throw new RuntimeError("busy", "Target collaborator process is stopping.");
	}

	standDownConfirmed(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participant = requireParticipant(this.store, participantKey, target.projectRoot);
		if (transitionAlreadyApplied(participant, "stand_down", "vacant", expectedGeneration)) return this.status(participant);
		if (!isHeld(participant.state) || participant.generation !== expectedGeneration) {
			throw new RuntimeError("conflict", "Participant state or generation changed before confirmed stand-down.");
		}
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw new RuntimeError("conflict", "Held participant has no holder target.");
		this.applyStandDown(participantKey, holderTargetKey, expectedGeneration);
		const current = requireParticipant(this.store, participantKey, target.projectRoot);
		return this.status(current);
	}

	async stopConfirmed(
		registration: HostedLiveRegistration,
		participantKey: string,
		expectedGeneration: string,
	): Promise<StoppedParticipant> {
		this.assertNotStopping(participantKey);
		this.stopping.add(participantKey);
		let stoppingTargetKey: string | undefined;
		try {
			const caller = requireTarget(this.store, registration.targetKey);
			const participant = requireParticipant(this.store, participantKey, caller.projectRoot);
			const holderTargetKey = this.stoppableHolder(participant, registration, expectedGeneration);
			this.stoppingTargets.add(holderTargetKey);
			stoppingTargetKey = holderTargetKey;
			const target = requireTarget(this.store, holderTargetKey);
			if (target.projectRoot !== caller.projectRoot) {
				throw new RuntimeError("conflict", "Collaborator target belongs to another project.");
			}
			return await this.stopHolder(participant, target, expectedGeneration);
		} finally {
			this.stopping.delete(participantKey);
			if (stoppingTargetKey) this.stoppingTargets.delete(stoppingTargetKey);
		}
	}

	private async stopHolder(
		participant: HostedParticipant,
		target: HostedTarget,
		expectedGeneration: string,
	): Promise<StoppedParticipant> {
		const unmanaged = (): StoppedParticipant => ({
			participant: this.status(participant),
			outcome: "unmanaged",
		});
		if (!this.options.stopTarget) return unmanaged();
		const stopped = await this.options.stopTarget(target);
		if (stopped === "unmanaged") return unmanaged();
		this.settleStopped(participant, target.targetKey, expectedGeneration);
		await this.options.onStopped?.(target, expectedGeneration);
		const current = requireParticipant(this.store, participant.participantKey, participant.projectRoot);
		const outcome = stopped === "closed" ? "stopped" : "already_stopped";
		return { participant: this.status(current), outcome };
	}

	private stoppableHolder(
		participant: HostedParticipant,
		registration: HostedLiveRegistration,
		expectedGeneration: string,
	): string {
		if (!isHeld(participant.state) || participant.generation !== expectedGeneration) {
			throw new RuntimeError("conflict", "Participant state or generation changed before confirmed stop.");
		}
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw new RuntimeError("conflict", "Participant has no stoppable collaborator target.");
		if (holderTargetKey === registration.targetKey) {
			throw new RuntimeError("conflict", "A Pi target cannot stop its own Herdr tab.");
		}
		this.assertTargetNotStopping(holderTargetKey);
		const otherHolder = Object.values(this.store.read().participants)
			.find((candidate) => candidate.participantKey !== participant.participantKey
				&& isHeld(candidate.state)
				&& candidate.holderTargetKey === holderTargetKey);
		if (otherHolder) {
			throw new RuntimeError("conflict", `Collaborator target now holds ${otherHolder.protocol}/${otherHolder.participantId}.`);
		}
		return holderTargetKey;
	}

	private settleStopped(participant: HostedParticipant, holderTargetKey: string, expectedGeneration: string): void {
		const current = requireParticipant(this.store, participant.participantKey, participant.projectRoot);
		if (!isHeld(current.state) || current.generation !== expectedGeneration || current.holderTargetKey !== holderTargetKey) {
			throw new RuntimeError("conflict", "Participant changed while its collaborator process was stopping.");
		}
		this.applyStandDown(participant.participantKey, holderTargetKey, expectedGeneration, "stop");
	}

	private applyStandDown(
		participantKey: string,
		holderTargetKey: string,
		expectedGeneration: string,
		cause: "stand_down" | "stop" = "stand_down",
	): void {
		this.store.apply({
			type: "participant.stand_down",
			cause,
			participantKey,
			targetKey: holderTargetKey,
			expectedGeneration,
			generation: this.createGeneration(),
			at: this.now(),
		});
	}

	private leave(
		registration: HostedLiveRegistration,
		participantKey: string,
		type: "participant.stand_down" | "participant.release",
		expectedGeneration?: string,
	): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
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

/** True when this exact transition already landed: same resulting state, same cause, same generation replaced. */
function transitionAlreadyApplied(
	participant: HostedParticipant,
	cause: HostedParticipant["transition"]["cause"],
	state: HostedParticipant["state"],
	previousGeneration: string,
): boolean {
	const applied = participant.transition.cause;
	const vacating = applied === "stop" || applied === "stand_down";
	const sameCause = applied === cause || (vacating && (cause === "stop" || cause === "stand_down"));
	return participant.state === state
		&& sameCause
		&& participant.transition.previousGeneration === previousGeneration;
}
