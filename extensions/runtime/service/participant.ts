import { randomUUID } from "node:crypto";
import { type HostedParticipant, type HostedTarget, holds, isHeld, isVacant } from "../schemas/state.ts";
import { RuntimeError } from "../errors.ts";
import {
	type HostedParticipantStatus,
	participantStatus,
	requireParticipant,
	requireTarget,
} from "./participant-status.ts";
import { LiveTargets, type HostedCaller } from "./live.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_RECONNECT_GRACE_MS = 60_000;


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
	private readonly live: LiveTargets;
	private readonly options: HostedParticipantCoordinatorOptions;
	private readonly startedAt: number;
	private readonly seenTargets = new Set<string>();
	private readonly stopping = new Set<string>();
	private readonly stoppingTargets = new Set<string>();

	constructor(
		store: HostedStateStore,
		live: LiveTargets,
		options: HostedParticipantCoordinatorOptions = {},
	) {
		this.store = store;
		this.live = live;
		this.options = options;
		this.startedAt = options.startedAt ?? this.now();
	}

	registrationReady(targetKey: string): void {
		this.seenTargets.add(targetKey);
	}

	acquire(registration: HostedCaller, protocol: string, participantId: string) {
		this.seenTargets.add(registration.targetKey);
		this.assertTargetNotStopping(registration.targetKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participantKey = deriveParticipantKey(target.projectRoot, protocol, participantId);
		this.assertNotStopping(participantKey);
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
		return { participant: this.status(requireParticipant(this.store, participantKey, target.projectRoot)) };
	}

	get(registration: HostedCaller, participantKey: string): HostedParticipantStatus {
		const target = requireTarget(this.store, registration.targetKey);
		return this.status(requireParticipant(this.store, participantKey, target.projectRoot));
	}

	list(registration: HostedCaller): HostedParticipantStatus[] {
		const target = requireTarget(this.store, registration.targetKey);
		return Object.values(this.store.read().participants)
			.filter((participant) => participant.projectRoot === target.projectRoot)
			.sort((left, right) => left.protocol.localeCompare(right.protocol) || left.participantId.localeCompare(right.participantId))
			.map((participant) => this.status(participant, false));
	}

	takeover(registration: HostedCaller, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
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
		if (this.live.hasLiveTarget(previousHolderTargetKey)) {
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

	sendMessaging(registration: HostedCaller, namespaceId: string, publication: MessagingPublication): void {
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

	standDownConfirmed(registration: HostedCaller, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
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
		registration: HostedCaller,
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
			const target = this.store.read().targets[holderTargetKey];
			if (!target) return this.dormantStopped(participant, holderTargetKey, expectedGeneration, "already_stopped");
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
		const outcome = stopped === "closed" ? "stopped" : "already_stopped";
		if (isVacant(participant.state)) return this.dormantStopped(participant, target.targetKey, expectedGeneration, outcome);
		this.settleStopped(participant, target.targetKey, expectedGeneration);
		await this.options.onStopped?.(target, expectedGeneration);
		const current = requireParticipant(this.store, participant.participantKey, participant.projectRoot);
		return { participant: this.status(current), outcome };
	}

	/** A stood-down participant's dormant tab is closed and its cause becomes "stop", so a start no longer tries to replace it. */
	private dormantStopped(
		participant: HostedParticipant,
		targetKey: string,
		expectedGeneration: string,
		outcome: "stopped" | "already_stopped",
	): StoppedParticipant {
		this.store.apply({ type: "participant.dormant_stopped", participantKey: participant.participantKey, targetKey, expectedGeneration, at: this.now() });
		return { participant: this.status(requireParticipant(this.store, participant.participantKey, participant.projectRoot)), outcome };
	}

	private stoppableHolder(
		participant: HostedParticipant,
		registration: HostedCaller,
		expectedGeneration: string,
	): string {
		const dormant = isVacant(participant.state) && participant.transition.cause === "stand_down" && participant.generation === expectedGeneration;
		if (!dormant && (!isHeld(participant.state) || participant.generation !== expectedGeneration)) {
			throw new RuntimeError("conflict", "Participant state or generation changed before confirmed stop.");
		}
		const holderTargetKey = dormant ? participant.transition.previousHolderTargetKey : participant.holderTargetKey;
		if (!holderTargetKey) throw new RuntimeError("conflict", "Participant has no stoppable collaborator target.");
		if (holderTargetKey === registration.targetKey) {
			throw new RuntimeError("conflict", "A Pi target cannot stop its own Herdr tab.");
		}
		this.assertTargetNotStopping(holderTargetKey);
		const otherHolder = Object.values(this.store.read().participants)
			.find((candidate) => candidate.participantKey !== participant.participantKey
				&& holds(candidate, holderTargetKey));
		if (otherHolder) {
			throw new RuntimeError("conflict", `Collaborator target now holds ${otherHolder.protocol}/${otherHolder.participantId}.`);
		}
		return holderTargetKey;
	}

	private settleStopped(participant: HostedParticipant, holderTargetKey: string, expectedGeneration: string): void {
		const current = requireParticipant(this.store, participant.participantKey, participant.projectRoot);
		if (!holds(current, holderTargetKey, expectedGeneration)) {
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

	private status(participant: HostedParticipant, includeQueue = true): HostedParticipantStatus {
		return participantStatus(this.store, this.live, participant, includeQueue);
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
