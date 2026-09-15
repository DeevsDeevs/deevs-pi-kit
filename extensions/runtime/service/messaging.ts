import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_ACK_RETENTION_MS } from "../schemas/common.ts";
import {
	type HostedMailboxMessageEvent,
	type HostedMessagingGrant,
	type HostedParticipant,
	type HostedRuntimeState,
	type HostedTarget,
	isHeld,
	isPiTarget,
} from "../schemas/state.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RuntimeError } from "../errors.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import type { MessagingInboxMessageView, MessagingInboxView } from "../schemas/rpc.ts";
import {
	deriveParticipantKey,
	HostedStateStorageError,
	HostedStateStore,
	messagingConfigurationHash,
	messagingGrantIsLive,
	messagingInboxEvent,
} from "./state.ts";

const MAX_IN_FLIGHT = 12;
const INBOX_PAGE = 50;
const INBOX_PAGE_BYTES = 96 * 1024;

export type MessagingInput =
	| { method: "peers" }
	| { method: "inbox" }
	| { method: "send"; participantId: string; operationId: string; body: string }
	| { method: "reply"; operationId: string; eventId: string; body: string };

interface VerifiedNamespace {
	grant: HostedMessagingGrant;
	registration: HostedLiveRegistration;
}

interface MessagingMailHint {
	namespaceId: string;
	eventId: string;
}

interface MessagingIssued {
	namespaceId: string;
	descriptorPath: string;
	expiresAt: number;
}

interface MessagingPeer {
	participantId: string;
	live: boolean;
}

type MessagingBinding =
	| { kind: "pi"; sessionId: string; sessionFile: string; cwd: string }
	| { kind: "agent" };

/** `binding` exists for the Pi bridge's descriptor check; the bridge strips it before the model sees the result. */
interface MessagingPeersResult {
	me: string;
	binding: MessagingBinding;
	peers: MessagingPeer[];
}

interface MessagingEventResult {
	eventId: string;
}

type MessagingResult = MessagingInboxView | MessagingPeersResult | MessagingEventResult;

export class RuntimeMessaging {
	private inFlight = 0;
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly participants: HostedParticipantCoordinator;
	private readonly socketPath: string;
	private readonly now: () => number;
	private readonly onPublished: () => void;

	constructor(
		store: HostedStateStore,
		registrations: RuntimeRegistrationManager,
		participants: HostedParticipantCoordinator,
		socketPath: string,
		now: () => number = Date.now,
		onPublished: () => void = () => {},
	) {
		this.store = store;
		this.registrations = registrations;
		this.participants = participants;
		this.socketPath = socketPath;
		this.now = now;
		this.onPublished = onPublished;
	}

	async issue(caller: HostedLiveRegistration, participantKey: string, expectedGeneration: string): Promise<MessagingIssued> {
		const state = this.store.read();
		const held = (candidate: HostedParticipant) => isHeld(candidate.state) && candidate.holderTargetKey === caller.targetKey;
		const callerParticipant = Object.values(state.participants).find(held);
		const participant = state.participants[participantKey];
		if (!isPiTarget(state.targets[caller.targetKey]) || !callerParticipant || !participant) throw issuanceMismatch();
		if (!issuanceScopeMatches(callerParticipant, participant, expectedGeneration)) throw issuanceMismatch();
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw issuanceMismatch();
		const registration = await this.registrations.verifyTarget(holderTargetKey);
		this.registrations.authorize(caller.registrationId, caller.registrationKey);
		this.registrations.authorize(registration.registrationId, registration.registrationKey);
		const currentCaller = this.store.read().participants[callerParticipant.participantKey];
		if (!stillHeldBy(currentCaller, callerParticipant.generation, caller.targetKey)) {
			throw new RuntimeError("registration_stale", "Messaging controller changed during verification.");
		}
		const target = this.store.read().targets[registration.targetKey];
		const currentParticipant = this.store.read().participants[participantKey];
		if (!target || !stillHeldBy(currentParticipant, expectedGeneration, registration.targetKey)) {
			throw new RuntimeError("registration_stale", "Messaging recipient authority changed during issuance.");
		}
		const createdAt = this.now();
		const descriptorPath = messagingDescriptorPath(this.store.root, target.targetKey);
		const current = this.store.read();
		const existing = Object.values(current.messaging)
			.find((grant) => reusableGrant(current, grant, target, expectedGeneration, createdAt));
		// The reused secret only exists on disk, so a descriptor that names another namespace forces a fresh grant.
		if (existing && descriptorNames(descriptorPath, existing.namespaceId)) {
			return { namespaceId: existing.namespaceId, descriptorPath, expiresAt: existing.expiresAt };
		}
		const secret = randomBytes(32).toString("base64url");
		const grant: HostedMessagingGrant = {
			namespaceId: `msg_${randomUUID()}`,
			secretDigest: digest(secret),
			participantKey,
			holderGeneration: expectedGeneration,
			targetKey: target.targetKey,
			configurationHash: messagingConfigurationHash(target),
			createdAt,
			expiresAt: createdAt + HOSTED_ACK_RETENTION_MS,
			status: "active",
			operations: {},
		};
		this.writeDescriptor(descriptorPath, grant, secret);
		return { namespaceId: grant.namespaceId, descriptorPath, expiresAt: grant.expiresAt };
	}

	/** The live descriptor is replaced only once its successor grant is durable, never truncated in place. */
	private writeDescriptor(descriptorPath: string, grant: HostedMessagingGrant, secret: string): void {
		const pending = `${descriptorPath}.${randomUUID()}.tmp`;
		const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			const descriptor = { version: 1, socketPath: this.socketPath, namespaceId: grant.namespaceId, secret };
			writeFileSync(fd, `${JSON.stringify(descriptor)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			this.store.apply({ type: "messaging.issue", grant });
		} catch (error) {
			// An uncertain write may still have issued the grant, so its descriptor has to be published anyway.
			if (error instanceof HostedStateStorageError && error.uncertain) renameSync(pending, descriptorPath);
			else unlinkSync(pending);
			throw error;
		}
		renameSync(pending, descriptorPath);
	}

	/** Best-effort idle hint for a Pi holder: the oldest unread message in its sole live namespace. */
	unread(registration: HostedLiveRegistration): MessagingMailHint | undefined {
		const state = this.store.read();
		const grant = liveTargetNamespace(state, registration, this.now());
		if (!grant) return undefined;
		const [event] = unreadMailEvents(state, grant.participantKey);
		return event ? { namespaceId: grant.namespaceId, eventId: event.eventId } : undefined;
	}

	async call(namespaceId: string, secret: string, input: MessagingInput): Promise<MessagingResult> {
		if (this.inFlight >= MAX_IN_FLIGHT) {
			throw new RuntimeError("conflict", "Messaging request capacity is exhausted; retry the same operation ID.");
		}
		this.inFlight++;
		try {
			const { grant, registration } = await this.verify(namespaceId, secret);
			switch (input.method) {
				case "peers": return this.peers(grant);
				case "inbox": return this.inbox(grant);
				case "send": return this.publish(registration, grant, input.operationId, this.recipientKey(grant, input.participantId), input.body);
				case "reply": return this.publishReply(registration, grant, input.operationId, input.eventId, input.body);
				default: {
					const unsupported: never = input;
					throw new RuntimeError("invalid_request", `Unsupported messaging method ${JSON.stringify(unsupported)}.`);
				}
			}
		} finally {
			this.inFlight--;
		}
	}

	/** Delivery is the read: whatever this page returns is marked read in the same state write. */
	private inbox(grant: HostedMessagingGrant): MessagingInboxView {
		const unread = unreadMailEvents(this.store.read(), grant.participantKey);
		const messages: MessagingInboxMessageView[] = [];
		let bytes = 0;
		for (const event of unread) {
			const message: MessagingInboxMessageView = { eventId: event.eventId, from: this.requireParticipant(event.source.id).participantId, body: event.body };
			if (event.inReplyToEventId) message.inReplyTo = event.inReplyToEventId;
			bytes += Buffer.byteLength(JSON.stringify(message));
			// A page is marked read before it is sent, so it must stay under the response cap or the mail is lost.
			if (messages.length === INBOX_PAGE || (messages.length > 0 && bytes > INBOX_PAGE_BYTES)) break;
			messages.push(message);
		}
		if (messages.length > 0) {
			this.store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventIds: messages.map((message) => message.eventId), at: this.now() });
		}
		return { messages, truncated: unread.length > messages.length };
	}

	private peers(grant: HostedMessagingGrant): MessagingPeersResult {
		const state = this.store.read();
		const sender = this.requireParticipant(grant.participantKey);
		const target = state.targets[grant.targetKey];
		if (!target) throw new RuntimeError("registration_stale", "Messaging target is absent.");
		const peers = Object.values(state.participants)
			.filter((candidate) => isPeerOf(sender, candidate))
			.sort((left, right) => left.participantId.localeCompare(right.participantId))
			.map((peer) => ({ participantId: peer.participantId, live: this.peerLive(peer) }));
		return { me: sender.participantId, binding: messagingBinding(target), peers };
	}

	private peerLive(peer: HostedParticipant): boolean {
		return isHeld(peer.state) && peer.holderTargetKey !== undefined && this.registrations.hasLiveTarget(peer.holderTargetKey);
	}

	private publishReply(
		registration: HostedLiveRegistration,
		grant: HostedMessagingGrant,
		operationId: string,
		eventId: string,
		body: string,
	): MessagingEventResult {
		const inbound = messagingInboxEvent(this.store.read(), grant, eventId);
		return this.publish(registration, grant, operationId, inbound.source.id, body, eventId);
	}

	private publish(
		registration: HostedLiveRegistration,
		grant: HostedMessagingGrant,
		operationId: string,
		recipientParticipantKey: string,
		body: string,
		inReplyToEventId?: string,
	): MessagingEventResult {
		this.participants.sendMessaging(registration, grant.namespaceId, { operationId, recipientParticipantKey, body, inReplyToEventId });
		const current = this.requireGrant(grant.namespaceId);
		const eventId = Object.hasOwn(current.operations, operationId) ? current.operations[operationId] : undefined;
		if (eventId === undefined) throw new RuntimeError("not_found", "Operation has no publication in this namespace.");
		this.onPublished();
		return { eventId };
	}

	private recipientKey(grant: HostedMessagingGrant, participantId: string): string {
		const sender = this.requireParticipant(grant.participantKey);
		return deriveParticipantKey(sender.projectRoot, sender.protocol, participantId);
	}

	private async verify(namespaceId: string, secret: string): Promise<VerifiedNamespace> {
		this.authorize(namespaceId, secret);
		const registration = await this.registrations.verifyTarget(this.requireGrant(namespaceId).targetKey);
		this.authorize(namespaceId, secret);
		this.registrations.authorize(registration.registrationId, registration.registrationKey);
		return { grant: this.requireGrant(namespaceId), registration };
	}

	private requireGrant(namespaceId: string): HostedMessagingGrant {
		const grant = this.store.read().messaging[namespaceId];
		if (!grant) throw new RuntimeError("registration_stale", "Messaging namespace is absent.");
		return grant;
	}

	private requireParticipant(participantKey: string): HostedParticipant {
		const participant = this.store.read().participants[participantKey];
		if (!participant) throw new RuntimeError("registration_stale", "Messaging participant is absent.");
		return participant;
	}

	private authorize(namespaceId: string, secret: string): void {
		const grants = this.store.read().messaging;
		const grant = Object.hasOwn(grants, namespaceId) ? grants[namespaceId] : undefined;
		if (!grant || !timingSafeEqual(Buffer.from(grant.secretDigest, "hex"), Buffer.from(digest(secret), "hex"))) {
			throw new RuntimeError("registration_stale", "Messaging credential is absent or invalid.");
		}
		if (this.now() >= grant.expiresAt) {
			this.store.apply({ type: "messaging.expire", namespaceId });
			const message = "Messaging namespace expired; do not republish an uncertain operation under a new namespace.";
			throw new RuntimeError("registration_stale", message);
		}
		if (!messagingGrantIsLive(this.store.read(), grant, this.now())) {
			throw new RuntimeError("registration_stale", "Messaging authority is expired or no longer bound to this holder.");
		}
	}

}

/** Mail is read by `messaging.read`, never claimed, so unread is the absence of a read time, oldest first. */
export function unreadMailEvents(state: HostedRuntimeState, participantKey: string): HostedMailboxMessageEvent[] {
	return Object.values(state.events)
		.filter((event) => event.recipientParticipantKey === participantKey && event.readAt === undefined)
		.sort((left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId));
}

function issuanceMismatch(): RuntimeError {
	const message = "Messaging issuance requires a held Pi controller in the exact project/protocol and target generation.";
	return new RuntimeError("identity_mismatch", message);
}

function issuanceScopeMatches(caller: HostedParticipant, participant: HostedParticipant, expectedGeneration: string): boolean {
	return caller.projectRoot === participant.projectRoot
		&& caller.protocol === participant.protocol
		&& isHeld(participant.state)
		&& participant.generation === expectedGeneration;
}

function stillHeldBy(participant: HostedParticipant | undefined, generation: string, targetKey: string): boolean {
	if (!participant || !isHeld(participant.state)) return false;
	return participant.generation === generation
		&& participant.holderTargetKey === targetKey;
}

function reusableGrant(
	state: HostedRuntimeState,
	grant: HostedMessagingGrant,
	target: HostedTarget,
	expectedGeneration: string,
	at: number,
): boolean {
	return grant.targetKey === target.targetKey
		&& grant.holderGeneration === expectedGeneration
		&& messagingGrantIsLive(state, grant, at);
}

function isPeerOf(sender: HostedParticipant, candidate: HostedParticipant): boolean {
	return candidate.projectRoot === sender.projectRoot
		&& candidate.protocol === sender.protocol
		&& candidate.participantKey !== sender.participantKey;
}

function messagingBinding(target: HostedTarget): MessagingBinding {
	if (!isPiTarget(target)) return { kind: "agent" };
	return {
		kind: "pi",
		sessionId: target.piSessionId,
		sessionFile: target.piSessionFile,
		cwd: target.worktreePath ?? target.projectRoot,
	};
}

export function messagingDescriptorPath(root: string, targetKey: string): string {
	return join(root, `messaging-${digest(targetKey)}.json`);
}

function liveTargetNamespace(
	state: HostedRuntimeState,
	registration: HostedLiveRegistration,
	at: number,
): HostedMessagingGrant | undefined {
	const eligible = Object.values(state.messaging)
		.filter(grant => grant.targetKey === registration.targetKey && messagingGrantIsLive(state, grant, at));
	return eligible.length === 1 ? eligible[0] : undefined;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function descriptorNames(descriptorPath: string, namespaceId: string): boolean {
	try {
		// SAFETY: The descriptor is this service's own file; only its namespace field is read, and never trusted beyond this check.
		const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as { namespaceId?: unknown };
		return descriptor.namespaceId === namespaceId;
	} catch {
		return false;
	}
}
