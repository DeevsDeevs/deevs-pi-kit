import { randomUUID } from "node:crypto";
import type { HostedAutoCapacityReservation, HostedMailboxMessageEvent, HostedMailboxTaskEvent, HostedMailboxTaskResultEvent, HostedParticipant, HostedTarget, HostedTaskWorkspaceEvidence } from "../hosted-types.ts";
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
	onStopped?: (target: HostedTarget, holderGeneration: string) => Promise<void> | void;
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
	private readonly stoppingTargets = new Set<string>();

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
		this.assertTargetNotStopping(registration.targetKey);
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

	reserveAutoCapacity(registration: HostedLiveRegistration, operationId: string, protocol: string, callerParticipantId: string, expectedCallerGeneration: string | undefined, participantIds: string[]): HostedAutoCapacityReservation {
		const target = this.requireTarget(registration.targetKey);
		if (target.kind !== "pi") throw new HostedParticipantError("conflict", "Only an authenticated Pi target may reserve Runtime Auto capacity.");
		const reservation: HostedAutoCapacityReservation = {
			version: 1,
			operationId,
			projectRoot: target.projectRoot,
			callerTargetKey: target.targetKey,
			callerParticipantKey: deriveParticipantKey(target.projectRoot, protocol, callerParticipantId),
			...(expectedCallerGeneration === undefined ? {} : { expectedCallerGeneration }),
			participantKeys: participantIds.map((participantId) => deriveParticipantKey(target.projectRoot, protocol, participantId)),
			createdAt: this.now(),
		};
		this.store.apply({ type: "auto_capacity.ensure", reservation });
		return this.store.read().autoCapacityReservations[operationId]!;
	}

	listAutoCapacity(registration: HostedLiveRegistration): HostedAutoCapacityReservation[] {
		this.requireTarget(registration.targetKey);
		return Object.values(this.store.read().autoCapacityReservations).filter((reservation) => reservation.callerTargetKey === registration.targetKey).sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId));
	}

	releaseAutoCapacity(registration: HostedLiveRegistration, operationId: string): void {
		this.requireTarget(registration.targetKey);
		this.store.apply({ type: "auto_capacity.release", operationId, callerTargetKey: registration.targetKey });
	}

	recoverAutoCapacity(registration: HostedLiveRegistration, operationId: string, confirmedAbsent: boolean): { released: boolean; confirmedAbsent: boolean } {
		this.requireTarget(registration.targetKey);
		const reservation = this.store.read().autoCapacityReservations[operationId];
		if (!reservation) return { released: false, confirmedAbsent: false };
		if (reservation.callerTargetKey !== registration.targetKey) throw new HostedParticipantError("conflict", "Only the exact Auto capacity caller may recover its reservation.");
		const absenceRequired = reservation.participantKeys.some((participantKey) => {
			const participant = this.store.read().participants[participantKey];
			return !participant || participant.state === "vacant";
		});
		if (absenceRequired && !confirmedAbsent) throw new HostedParticipantError("conflict", "Unsettled Auto capacity requires explicit exact-host absence confirmation.");
		this.store.apply({ type: "auto_capacity.release", operationId, callerTargetKey: registration.targetKey });
		return { released: true, confirmedAbsent: absenceRequired };
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
		let stoppingTargetKey: string | undefined;
		try {
			const caller = this.requireTarget(registration.targetKey);
			const participant = this.requireParticipant(participantKey, caller.projectRoot);
			const latest = participant.transitions.at(-1)!;
			const vacantStoppedTarget = participant.state === "vacant" && latest.cause === "stand_down" ? latest.previousHolderTargetKey : undefined;
			const retryingLostResponse = vacantStoppedTarget !== undefined && latest.previousGeneration === expectedGeneration;
			if (participant.generation !== expectedGeneration && !retryingLostResponse) throw new HostedParticipantError("conflict", "Participant generation changed before confirmed stop.");
			const holderTargetKey = participant.state === "held" ? participant.holderTargetKey : vacantStoppedTarget;
			if (!holderTargetKey) throw new HostedParticipantError("conflict", "Participant has no stoppable collaborator target.");
			if (holderTargetKey === registration.targetKey) throw new HostedParticipantError("conflict", "A Pi target cannot stop its own Herdr tab.");
			this.assertTargetNotStopping(holderTargetKey);
			const otherHolder = Object.values(this.store.read().participants).find((candidate) => candidate.participantKey !== participantKey && candidate.state === "held" && candidate.holderTargetKey === holderTargetKey);
			if (otherHolder) throw new HostedParticipantError("conflict", `Collaborator target now holds ${otherHolder.protocol}/${otherHolder.participantId}.`);
			this.stoppingTargets.add(holderTargetKey);
			stoppingTargetKey = holderTargetKey;
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
			} else if (current.state !== "vacant" || current.generation !== participant.generation) {
				throw new HostedParticipantError("conflict", "Participant changed while its prior collaborator process was stopping.");
			}
			await this.options.onStopped?.(target, participant.state === "held" ? expectedGeneration : latest.previousGeneration!);
			return { participant: this.status(this.requireParticipant(participantKey, caller.projectRoot)), outcome: stopped === "closed" ? "stopped" : "already_stopped" };
		} finally {
			this.stopping.delete(participantKey);
			if (stoppingTargetKey) this.stoppingTargets.delete(stoppingTargetKey);
		}
	}

	release(registration: HostedLiveRegistration, participantKey: string): HostedParticipantStatus {
		return this.leave(registration, participantKey, "participant.release");
	}

	takeover(registration: HostedLiveRegistration, participantKey: string, expectedGeneration: string): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		this.assertTargetNotStopping(registration.targetKey);
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
		return this.sendEnvelope("mailbox.send", registration, senderParticipantKey, expectedSenderGeneration, recipientParticipantKey, sendId, body) as HostedMailboxMessageEvent;
	}

	sendTask(registration: HostedLiveRegistration, senderParticipantKey: string, expectedSenderGeneration: string, recipientParticipantKey: string, sendId: string, body: string): HostedMailboxTaskEvent {
		return this.sendEnvelope("task.send", registration, senderParticipantKey, expectedSenderGeneration, recipientParticipantKey, sendId, body) as HostedMailboxTaskEvent;
	}

	recoverTaskResult(registration: HostedLiveRegistration, senderParticipantKey: string, expectedSenderGeneration: string, inReplyToEventId: string, sendId: string, status: "completed" | "failed" | "cancelled", body: string, sessionAdvance: "none" | "committed"): HostedMailboxTaskResultEvent | undefined {
		const target = this.requireTarget(registration.targetKey);
		const sender = this.requireParticipant(senderParticipantKey, target.projectRoot);
		if (sender.state !== "held" || sender.generation !== expectedSenderGeneration || sender.holderTargetKey !== registration.targetKey) throw new HostedParticipantError("conflict", "Task result sender identity or generation changed.");
		const task = this.store.read().events[inReplyToEventId];
		if (!task || task.type !== "mailbox.task" || task.recipientParticipantKey !== senderParticipantKey) throw new HostedParticipantError("not_found", "Bounded task is absent for this responder.");
		const event = Object.values(this.store.read().events).find((candidate): candidate is HostedMailboxTaskResultEvent => candidate.type === "mailbox.task_result" && candidate.payload.senderParticipantKey === senderParticipantKey && candidate.payload.sendId === sendId);
		if (!event) return undefined;
		if (event.payload.inReplyToEventId !== inReplyToEventId || event.payload.status !== status || event.payload.body !== body || event.payload.sessionAdvance !== sessionAdvance) throw new HostedParticipantError("conflict", "Task result retry changed its durable input.");
		return event;
	}

	resultTask(registration: HostedLiveRegistration, senderParticipantKey: string, expectedSenderGeneration: string, inReplyToEventId: string, sendId: string, status: "completed" | "failed" | "cancelled", body: string, sessionAdvance: "none" | "committed", workspace?: HostedTaskWorkspaceEvidence): HostedMailboxTaskResultEvent {
		const target = this.requireTarget(registration.targetKey);
		this.assertNotStopping(senderParticipantKey);
		this.requireParticipant(senderParticipantKey, target.projectRoot);
		this.store.apply({ type: "task.result", senderParticipantKey, expectedSenderGeneration, senderTargetKey: registration.targetKey, sendId, eventId: this.options.createEventId?.() ?? `evt_${randomUUID()}`, inReplyToEventId, status, body, sessionAdvance, ...(workspace ? { workspace } : {}), at: this.now() });
		const event = Object.values(this.store.read().events).find((candidate): candidate is HostedMailboxTaskResultEvent => candidate.type === "mailbox.task_result" && candidate.payload.senderParticipantKey === senderParticipantKey && candidate.payload.sendId === sendId);
		if (!event) throw new HostedParticipantError("conflict", "Task result did not produce a durable event.");
		const recipient = this.store.read().participants[event.recipientParticipantKey];
		if (recipient?.state === "held") this.wakes.request(recipient.holderTargetKey!);
		return event;
	}

	taskStatus(registration: HostedLiveRegistration, senderParticipantKey: string, expectedSenderGeneration: string, eventId: string): { eventId: string; recipientParticipantKey: string; status: "pending" } | { eventId: string; recipientParticipantKey: string; status: "completed" | "failed" | "cancelled"; resultEventId: string; replyId: string; body: string; sessionAdvance: "none" | "committed"; workspace?: HostedTaskWorkspaceEvidence } {
		const target = this.requireTarget(registration.targetKey);
		const sender = this.requireParticipant(senderParticipantKey, target.projectRoot);
		if (sender.state !== "held" || sender.generation !== expectedSenderGeneration || sender.holderTargetKey !== registration.targetKey) throw new HostedParticipantError("conflict", "Task status caller identity or generation changed.");
		const task = this.store.read().events[eventId];
		if (!task || task.type !== "mailbox.task" || task.payload.senderParticipantKey !== senderParticipantKey) throw new HostedParticipantError("not_found", "Bounded task is absent for this sender.");
		const result = Object.values(this.store.read().events).find((candidate): candidate is HostedMailboxTaskResultEvent => candidate.type === "mailbox.task_result" && candidate.payload.inReplyToEventId === task.eventId);
		return result ? { eventId: task.eventId, recipientParticipantKey: task.recipientParticipantKey, status: result.payload.status, resultEventId: result.eventId, replyId: result.payload.replyId, body: result.payload.body, sessionAdvance: result.payload.sessionAdvance, ...(result.payload.workspace ? { workspace: result.payload.workspace } : {}) } : { eventId: task.eventId, recipientParticipantKey: task.recipientParticipantKey, status: "pending" };
	}

	private sendEnvelope(type: "mailbox.send" | "task.send", registration: HostedLiveRegistration, senderParticipantKey: string, expectedSenderGeneration: string, recipientParticipantKey: string, sendId: string, body: string): HostedMailboxMessageEvent | HostedMailboxTaskEvent {
		const target = this.requireTarget(registration.targetKey);
		this.assertNotStopping(senderParticipantKey);
		const sender = this.requireParticipant(senderParticipantKey, target.projectRoot);
		if (sender.state !== "held" || sender.generation !== expectedSenderGeneration || sender.holderTargetKey !== registration.targetKey) throw new HostedParticipantError("conflict", "Sender identity or generation changed before send.");
		const recipient = this.requireParticipant(recipientParticipantKey, target.projectRoot);
		if (recipient.state === "ended") throw new HostedParticipantError("not_found", "Mailbox recipient has ended.");
		this.store.apply({ type, senderParticipantKey: sender.participantKey, expectedSenderGeneration, senderTargetKey: registration.targetKey, recipientParticipantKey, sendId, eventId: this.options.createEventId?.() ?? `evt_${randomUUID()}`, body, at: this.now() });
		const eventType = type === "task.send" ? "mailbox.task" : "mailbox.message";
		const event = Object.values(this.store.read().events).find((candidate): candidate is HostedMailboxMessageEvent | HostedMailboxTaskEvent => candidate.type === eventType && candidate.payload.senderParticipantKey === sender.participantKey && candidate.payload.sendId === sendId);
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
			if (event.type === "filesystem.created" || event.recipientParticipantKey !== participant.participantKey) continue;
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

	private assertTargetNotStopping(targetKey: string): void {
		if (this.stoppingTargets.has(targetKey)) throw new HostedParticipantError("busy", "Target collaborator process is stopping.");
	}

	private hasActiveClaim(participantKey: string): boolean {
		const state = this.store.read();
		return Object.values(state.claims).some((claim) => claim.status === "active" && claim.eventIds.some((eventId) => {
			const event = state.events[eventId];
			return event?.type !== "filesystem.created" && event.recipientParticipantKey === participantKey;
		}));
	}

	private createGeneration(): string {
		return this.options.createGeneration?.() ?? `lease_${randomUUID()}`;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
}
