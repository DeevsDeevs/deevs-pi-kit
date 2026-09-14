import { randomUUID } from "node:crypto";
import type {
	HostedCollaboratorDriver,
	HostedMailboxMessageEvent,
	HostedParticipant,
	HostedStateOperation,
	HostedTarget,
} from "../hosted-types.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_RECONNECT_GRACE_MS = 60_000;

type LeaveOperation = Extract<HostedStateOperation, { type: "participant.stand_down" | "participant.release" }>;

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
	lastTransition: HostedParticipant["transitions"][number];
}

export interface AcquiredParticipant {
	participant: HostedParticipantStatus;
	revived: boolean;
	transitioned: boolean;
}

export interface StoppedParticipant {
	participant: HostedParticipantStatus;
	outcome: "stopped" | "already_stopped" | "unmanaged";
}

export interface MessagingPublication {
	operationId: string;
	recipientParticipantKey: string;
	body: string;
	inReplyToEventId?: string;
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

	constructor(
		store: HostedStateStore,
		registrations: RuntimeRegistrationManager,
		wakes: HostedParticipantWakeRequester,
		options: HostedParticipantCoordinatorOptions = {},
	) {
		this.store = store;
		this.registrations = registrations;
		this.wakes = wakes;
		this.options = options;
		this.epochStartedAt = options.epochStartedAt ?? this.now();
	}

	registrationReady(targetKey: string): void {
		this.seenTargets.add(targetKey);
	}

	acquire(registration: HostedLiveRegistration, protocol: string, participantId: string, allowRevive = false): AcquiredParticipant {
		this.seenTargets.add(registration.targetKey);
		this.assertTargetNotStopping(registration.targetKey);
		const target = this.requireTarget(registration.targetKey);
		const participantKey = deriveParticipantKey(target.projectRoot, protocol, participantId);
		this.assertNotStopping(participantKey);
		const before = this.store.read().participants[participantKey];
		if (before?.state === "ended" && !allowRevive) {
			throw new HostedParticipantError("conflict", "Ended participant requires explicit revival authorization.");
		}
		const latest = before?.transitions.at(-1);
		const revivedOwnHold = before?.state === "held"
			&& before.holderTargetKey === registration.targetKey
			&& latest?.cause === "revive";
		const revived = before?.state === "ended" || revivedOwnHold;
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
		const transitioned = before?.state !== "held" || before.holderTargetKey !== registration.targetKey;
		return { participant: this.status(participant), revived, transitioned };
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
		if (participant.state === "vacant" && latest?.cause === "stand_down" && latest.previousGeneration === expectedGeneration) {
			return this.status(participant);
		}
		if (participant.state !== "held" || participant.generation !== expectedGeneration) {
			throw new HostedParticipantError("conflict", "Participant state or generation changed before confirmed stand-down.");
		}
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw new HostedParticipantError("conflict", "Held participant has no holder target.");
		this.store.apply({
			type: "participant.stand_down",
			participantKey,
			targetKey: holderTargetKey,
			expectedGeneration,
			generation: this.createGeneration(),
			at: this.now(),
		});
		this.wakes.request(holderTargetKey);
		if (registration.targetKey !== holderTargetKey) this.wakes.request(registration.targetKey);
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
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
			const caller = this.requireTarget(registration.targetKey);
			const participant = this.requireParticipant(participantKey, caller.projectRoot);
			const latest = participant.transitions.at(-1);
			if (!latest) throw new HostedParticipantError("conflict", "Participant has no transition history.");
			const holderTargetKey = this.stoppableHolder(participant, latest, registration, expectedGeneration);
			this.stoppingTargets.add(holderTargetKey);
			stoppingTargetKey = holderTargetKey;
			const target = this.requireTarget(holderTargetKey);
			if (target.projectRoot !== caller.projectRoot) {
				throw new HostedParticipantError("conflict", "Collaborator target belongs to another project.");
			}
			if (!this.options.stopTarget) return { participant: this.status(participant), outcome: "unmanaged" };
			const stopped = await this.options.stopTarget(target);
			if (stopped === "unmanaged") return { participant: this.status(participant), outcome: "unmanaged" };
			this.settleStopped(registration, participant, holderTargetKey, expectedGeneration);
			await this.options.onStopped?.(target, stoppedGeneration(participant, latest, expectedGeneration));
			const current = this.requireParticipant(participantKey, caller.projectRoot);
			return { participant: this.status(current), outcome: stopped === "closed" ? "stopped" : "already_stopped" };
		} finally {
			this.stopping.delete(participantKey);
			if (stoppingTargetKey) this.stoppingTargets.delete(stoppingTargetKey);
		}
	}

	private stoppableHolder(
		participant: HostedParticipant,
		latest: HostedParticipant["transitions"][number],
		registration: HostedLiveRegistration,
		expectedGeneration: string,
	): string {
		const vacantStoppedTarget = participant.state === "vacant" && latest.cause === "stand_down" ? latest.previousHolderTargetKey : undefined;
		const retryingLostResponse = vacantStoppedTarget !== undefined && latest.previousGeneration === expectedGeneration;
		if (participant.generation !== expectedGeneration && !retryingLostResponse) {
			throw new HostedParticipantError("conflict", "Participant generation changed before confirmed stop.");
		}
		const holderTargetKey = participant.state === "held" ? participant.holderTargetKey : vacantStoppedTarget;
		if (!holderTargetKey) throw new HostedParticipantError("conflict", "Participant has no stoppable collaborator target.");
		if (holderTargetKey === registration.targetKey) {
			throw new HostedParticipantError("conflict", "A Pi target cannot stop its own Herdr tab.");
		}
		this.assertTargetNotStopping(holderTargetKey);
		const otherHolder = Object.values(this.store.read().participants)
			.find((candidate) => candidate.participantKey !== participant.participantKey
				&& candidate.state === "held"
				&& candidate.holderTargetKey === holderTargetKey);
		if (otherHolder) {
			throw new HostedParticipantError("conflict", `Collaborator target now holds ${otherHolder.protocol}/${otherHolder.participantId}.`);
		}
		return holderTargetKey;
	}

	private settleStopped(
		registration: HostedLiveRegistration,
		participant: HostedParticipant,
		holderTargetKey: string,
		expectedGeneration: string,
	): void {
		const current = this.requireParticipant(participant.participantKey, participant.projectRoot);
		if (participant.state !== "held") {
			if (current.state !== "vacant" || current.generation !== participant.generation) {
				throw new HostedParticipantError("conflict", "Participant changed while its prior collaborator process was stopping.");
			}
			return;
		}
		if (current.state !== "held" || current.generation !== expectedGeneration || current.holderTargetKey !== holderTargetKey) {
			throw new HostedParticipantError("conflict", "Participant changed while its collaborator process was stopping.");
		}
		this.store.apply({
			type: "participant.stand_down",
			participantKey: participant.participantKey,
			targetKey: holderTargetKey,
			expectedGeneration,
			generation: this.createGeneration(),
			at: this.now(),
		});
		this.wakes.request(holderTargetKey);
		if (registration.targetKey !== holderTargetKey) this.wakes.request(registration.targetKey);
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
		if (takeoverAlreadyApplied(participant, latest, registration.targetKey, expectedGeneration)) return this.status(participant);
		if (participant.state !== "held" || participant.generation !== expectedGeneration) {
			throw new HostedParticipantError("conflict", "Participant state or generation changed before takeover.");
		}
		if (participant.holderTargetKey === registration.targetKey) return this.status(participant);
		const previousHolderTargetKey = participant.holderTargetKey;
		if (!previousHolderTargetKey) throw new HostedParticipantError("conflict", "Held participant has no holder target.");
		if (this.registrations.hasLiveTarget(previousHolderTargetKey)) {
			throw new HostedParticipantError("busy", "Participant holder is still live.");
		}
		const graceMs = this.options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
		if (!this.seenTargets.has(previousHolderTargetKey) && this.now() - this.epochStartedAt < graceMs) {
			throw new HostedParticipantError("busy", "Participant holder is inside the Runtime reconnect grace period.");
		}
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

	send(
		registration: HostedLiveRegistration,
		senderParticipantKey: string,
		expectedSenderGeneration: string,
		recipientParticipantKey: string,
		sendId: string,
		body: string,
	): HostedMailboxMessageEvent {
		const target = this.requireTarget(registration.targetKey);
		this.assertNotStopping(senderParticipantKey);
		const sender = this.requireParticipant(senderParticipantKey, target.projectRoot);
		if (!holdsIdentity(sender, expectedSenderGeneration, registration.targetKey)) {
			throw new HostedParticipantError("conflict", "Sender identity or generation changed before send.");
		}
		const recipient = this.requireParticipant(recipientParticipantKey, target.projectRoot);
		if (recipient.state === "ended") throw new HostedParticipantError("not_found", "Mailbox recipient has ended.");
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
		const currentRecipient = this.store.read().participants[recipientParticipantKey];
		const recipientHolder = currentRecipient?.state === "held" ? currentRecipient.holderTargetKey : undefined;
		if (recipientHolder) this.wakes.request(recipientHolder);
		return event;
	}

	sendMessaging(registration: HostedLiveRegistration, namespaceId: string, publication: MessagingPublication): void {
		const grant = this.store.read().messaging[namespaceId];
		if (!grant || grant.targetKey !== registration.targetKey || grant.clientGeneration !== registration.clientGeneration) {
			throw new HostedParticipantError("conflict", "Messaging sender binding changed.");
		}
		this.assertNotStopping(grant.participantKey);
		this.assertTargetNotStopping(grant.targetKey);
		const retry = Object.hasOwn(grant.operations, publication.operationId);
		this.store.apply({ type: "messaging.send", namespaceId, ...publication, eventId: this.createEventId(), at: this.now() });
		const recipient = this.store.read().participants[publication.recipientParticipantKey];
		if (!retry && recipient?.state === "held" && recipient.holderTargetKey) this.wakes.request(recipient.holderTargetKey);
	}

	private leave(
		registration: HostedLiveRegistration,
		participantKey: string,
		type: "participant.stand_down" | "participant.release",
		expectedGeneration?: string,
	): HostedParticipantStatus {
		this.assertNotStopping(participantKey);
		const target = this.requireTarget(registration.targetKey);
		this.requireParticipant(participantKey, target.projectRoot);
		const operation: LeaveOperation = {
			type,
			participantKey,
			targetKey: registration.targetKey,
			generation: this.createGeneration(),
			at: this.now(),
		};
		if (operation.type === "participant.stand_down" && expectedGeneration !== undefined) operation.expectedGeneration = expectedGeneration;
		this.store.apply(operation);
		this.wakes.request(registration.targetKey);
		return this.status(this.requireParticipant(participantKey, target.projectRoot));
	}

	private status(participant: HostedParticipant, includeQueue = true): HostedParticipantStatus {
		const holderTargetKey = participant.holderTargetKey;
		const holder = holderTargetKey ? this.store.read().targets[holderTargetKey] : undefined;
		const lastTransition = participant.transitions.at(-1);
		if (!lastTransition) throw new HostedParticipantError("not_found", "Participant has no transition history.");
		const status: HostedParticipantStatus = {
			participantKey: participant.participantKey,
			projectRoot: participant.projectRoot,
			protocol: participant.protocol,
			participantId: participant.participantId,
			state: participant.state,
			generation: participant.generation,
			holderLive: participant.state === "held" && holderTargetKey !== undefined && this.registrations.hasLiveTarget(holderTargetKey),
			lastTransition,
		};
		if (holderTargetKey) status.holderTargetKey = holderTargetKey;
		if (holder?.kind === "pi") {
			status.driver = "pi";
		} else if (holder?.kind === "agent") {
			status.driver = holder.driver;
			status.profile = holder.profile;
		}
		if (includeQueue) status.unreadMail = this.unreadMail(participant.participantKey);
		return status;
	}

	/** Mail is read by `messaging.read`, never claimed, so unread depth is the absence of a read time. */
	private unreadMail(participantKey: string): number {
		return Object.values(this.store.read().events)
			.filter((event) => event.type === "mailbox.message"
				&& event.recipientParticipantKey === participantKey
				&& event.readAt === undefined)
			.length;
	}

	private requireTarget(targetKey: string): HostedTarget {
		const target = this.store.read().targets[targetKey];
		if (!target) throw new HostedParticipantError("not_found", "Runtime target is absent.");
		return target;
	}

	private requireParticipant(participantKey: string, projectRoot: string): HostedParticipant {
		const participant = this.store.read().participants[participantKey];
		if (!participant || participant.projectRoot !== projectRoot) {
			throw new HostedParticipantError("not_found", "Participant is absent from this project.");
		}
		return participant;
	}

	private assertNotStopping(participantKey: string): void {
		if (this.stopping.has(participantKey)) throw new HostedParticipantError("busy", "Participant collaborator process is stopping.");
	}

	private assertTargetNotStopping(targetKey: string): void {
		if (this.stoppingTargets.has(targetKey)) throw new HostedParticipantError("busy", "Target collaborator process is stopping.");
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
	return participant.state === "held"
		&& participant.generation === generation
		&& participant.holderTargetKey === targetKey;
}

function takeoverAlreadyApplied(
	participant: HostedParticipant,
	latest: HostedParticipant["transitions"][number] | undefined,
	targetKey: string,
	expectedGeneration: string,
): boolean {
	return participant.state === "held"
		&& participant.holderTargetKey === targetKey
		&& latest?.cause === "takeover"
		&& latest.previousGeneration === expectedGeneration;
}

function stoppedGeneration(
	participant: HostedParticipant,
	latest: HostedParticipant["transitions"][number],
	expectedGeneration: string,
): string {
	if (participant.state === "held") return expectedGeneration;
	const previous = latest.previousGeneration;
	if (previous === undefined) throw new HostedParticipantError("conflict", "Stopped participant has no prior generation.");
	return previous;
}
