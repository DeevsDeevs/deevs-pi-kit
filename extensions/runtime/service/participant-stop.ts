import { randomUUID } from "node:crypto";
import { type HostedParticipant, type HostedTarget, isHeld, isVacant } from "../hosted-types.ts";
import {
	HostedParticipantError,
	type HostedParticipantStatus,
	participantStatus,
	requireParticipant,
	requireTarget,
} from "./participant-status.ts";
import type { HostedLiveRegistration, RuntimeRegistrationManager } from "./registration.ts";
import type { HostedStateStore } from "./state.ts";

export interface CollaboratorStopOptions {
	now?: () => number;
	createGeneration?: () => string;
	stopTarget?: (target: HostedTarget) => Promise<"closed" | "already_absent" | "unmanaged">;
	onStopped?: (target: HostedTarget, holderGeneration: string) => Promise<void> | void;
}

export interface StoppedParticipant {
	participant: HostedParticipantStatus;
	outcome: "stopped" | "already_stopped" | "unmanaged";
}

export class CollaboratorStopper {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly options: CollaboratorStopOptions;
	private readonly stopping = new Set<string>();
	private readonly stoppingTargets = new Set<string>();

	constructor(store: HostedStateStore, registrations: RuntimeRegistrationManager, options: CollaboratorStopOptions) {
		this.store = store;
		this.registrations = registrations;
		this.options = options;
	}

	assertNotStopping(participantKey: string): void {
		if (this.stopping.has(participantKey)) throw new HostedParticipantError("busy", "Participant collaborator process is stopping.");
	}

	assertTargetNotStopping(targetKey: string): void {
		if (this.stoppingTargets.has(targetKey)) throw new HostedParticipantError("busy", "Target collaborator process is stopping.");
	}

	standDownConfirmed(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		const target = requireTarget(this.store, registration.targetKey);
		const participant = requireParticipant(this.store, participantKey, target.projectRoot);
		if (standDownApplied(participant, expectedGeneration)) {
			return participantStatus(this.store, this.registrations, participant);
		}
		if (!isHeld(participant.state) || participant.generation !== expectedGeneration) {
			throw new HostedParticipantError("conflict", "Participant state or generation changed before confirmed stand-down.");
		}
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw new HostedParticipantError("conflict", "Held participant has no holder target.");
		this.applyStandDown(participantKey, holderTargetKey, expectedGeneration);
		const current = requireParticipant(this.store, participantKey, target.projectRoot);
		return participantStatus(this.store, this.registrations, current);
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
				throw new HostedParticipantError("conflict", "Collaborator target belongs to another project.");
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
			participant: participantStatus(this.store, this.registrations, participant),
			outcome: "unmanaged",
		});
		if (!this.options.stopTarget) return unmanaged();
		const stopped = await this.options.stopTarget(target);
		if (stopped === "unmanaged") return unmanaged();
		this.settleStopped(participant, target.targetKey, expectedGeneration);
		await this.options.onStopped?.(target, expectedGeneration);
		const current = requireParticipant(this.store, participant.participantKey, participant.projectRoot);
		const outcome = stopped === "closed" ? "stopped" : "already_stopped";
		return { participant: participantStatus(this.store, this.registrations, current), outcome };
	}

	private stoppableHolder(
		participant: HostedParticipant,
		registration: HostedLiveRegistration,
		expectedGeneration: string,
	): string {
		if (!isHeld(participant.state) || participant.generation !== expectedGeneration) {
			throw new HostedParticipantError("conflict", "Participant state or generation changed before confirmed stop.");
		}
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw new HostedParticipantError("conflict", "Participant has no stoppable collaborator target.");
		if (holderTargetKey === registration.targetKey) {
			throw new HostedParticipantError("conflict", "A Pi target cannot stop its own Herdr tab.");
		}
		this.assertTargetNotStopping(holderTargetKey);
		const otherHolder = Object.values(this.store.read().participants)
			.find((candidate) => candidate.participantKey !== participant.participantKey
				&& isHeld(candidate.state)
				&& candidate.holderTargetKey === holderTargetKey);
		if (otherHolder) {
			throw new HostedParticipantError("conflict", `Collaborator target now holds ${otherHolder.protocol}/${otherHolder.participantId}.`);
		}
		return holderTargetKey;
	}

	private settleStopped(participant: HostedParticipant, holderTargetKey: string, expectedGeneration: string): void {
		const current = requireParticipant(this.store, participant.participantKey, participant.projectRoot);
		if (!isHeld(current.state) || current.generation !== expectedGeneration || current.holderTargetKey !== holderTargetKey) {
			throw new HostedParticipantError("conflict", "Participant changed while its collaborator process was stopping.");
		}
		this.applyStandDown(participant.participantKey, holderTargetKey, expectedGeneration);
	}

	private applyStandDown(participantKey: string, holderTargetKey: string, expectedGeneration: string): void {
		this.store.apply({
			type: "participant.stand_down",
			participantKey,
			targetKey: holderTargetKey,
			expectedGeneration,
			generation: this.options.createGeneration?.() ?? `lease_${randomUUID()}`,
			at: this.options.now?.() ?? Date.now(),
		});
	}
}

function standDownApplied(participant: HostedParticipant, expectedGeneration: string): boolean {
	return isVacant(participant.state)
		&& participant.transition.cause === "stand_down"
		&& participant.transition.previousGeneration === expectedGeneration;
}
