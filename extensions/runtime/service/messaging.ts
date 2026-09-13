import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	HOSTED_ACK_RETENTION_MS,
	type HostedMailboxMessageEvent,
	type HostedMessagingGrant,
	type HostedParticipant,
	type HostedParticipantState,
	type HostedRuntimeState,
} from "../hosted-types.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RegistrationError, RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStorageError, HostedStateStore, messagingConfigurationHash, messagingInboxEvent } from "./state.ts";

const MAX_IN_FLIGHT = 12;
const PEER_PAGE = 12;

export type MessagingInput =
	| { method: "peers"; cursor?: string }
	| { method: "send"; participantId: string; operationId: string; body: string }
	| { method: "status"; operationId: string }
	| { method: "receive"; eventId: string }
	| { method: "received"; eventId: string }
	| { method: "reply"; operationId: string; eventId: string; body: string };

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
	state: HostedParticipantState;
	holderLive: boolean;
}

interface MessagingPeersResult {
	namespaceId: string;
	caller: string;
	protocol: string;
	binding: { kind: "pi"; sessionId: string; sessionFile: string; cwd: string } | { kind: "agent" };
	expiresAt: number;
	peers: MessagingPeer[];
	nextCursor: string | null;
}

interface MessagingMessage {
	eventId: string;
	from: string;
	body: string;
	createdAt: number;
	inReplyToEventId?: string;
	readAt?: number;
}

interface MessagingMessageResult {
	namespaceId: string;
	message: MessagingMessage;
}

interface MessagingReadResult {
	namespaceId: string;
	eventId: string;
	readAt: number;
}

interface MessagingPublishedResult {
	namespaceId: string;
	eventId: string;
}

interface MessagingStatusResult {
	namespaceId: string;
	event: HostedMailboxMessageEvent;
}

type MessagingResult = MessagingPeersResult | MessagingMessageResult | MessagingReadResult | MessagingPublishedResult | MessagingStatusResult;

export class RuntimeMessaging {
	private inFlight = 0;
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly participants: HostedParticipantCoordinator;
	private readonly socketPath: string;
	private readonly now: () => number;

	constructor(store: HostedStateStore, registrations: RuntimeRegistrationManager, participants: HostedParticipantCoordinator, socketPath: string, now: () => number = Date.now) {
		this.store = store;
		this.registrations = registrations;
		this.participants = participants;
		this.socketPath = socketPath;
		this.now = now;
	}

	async issue(caller: HostedLiveRegistration, participantKey: string, expectedGeneration: string): Promise<MessagingIssued> {
		const callerParticipant = Object.values(this.store.read().participants).find((p) => p.state === "held" && p.holderTargetKey === caller.targetKey);
		const participant = this.store.read().participants[participantKey];
		if (this.store.read().targets[caller.targetKey]?.kind !== "pi" || !callerParticipant || !participant || callerParticipant.projectRoot !== participant.projectRoot || callerParticipant.protocol !== participant.protocol || participant.state !== "held" || participant.generation !== expectedGeneration || !participant.holderTargetKey) throw new RegistrationError("identity_mismatch", "Messaging issuance requires a held Pi controller in the exact project/protocol and target generation.");
		const registration = await this.registrations.verifyTarget(participant.holderTargetKey);
		this.registrations.authorize(caller.registrationId, caller.registrationKey);
		this.registrations.authorize(registration.registrationId, registration.registrationKey);
		const currentCaller = this.store.read().participants[callerParticipant.participantKey];
		if (currentCaller?.state !== "held" || currentCaller.generation !== callerParticipant.generation || currentCaller.holderTargetKey !== caller.targetKey) throw new RegistrationError("registration_stale", "Messaging controller changed during verification.");
		const target = this.store.read().targets[registration.targetKey];
		const currentParticipant = this.store.read().participants[participantKey];
		if (!target || currentParticipant?.state !== "held" || currentParticipant.generation !== expectedGeneration || currentParticipant.holderTargetKey !== registration.targetKey) throw new RegistrationError("registration_stale", "Messaging recipient authority changed during issuance.");
		const createdAt = this.now();
		const descriptorPath = messagingDescriptorPath(this.store.root, target.targetKey, registration.clientGeneration);
		const existing = Object.values(this.store.read().messaging).find(grant => grant.targetKey === target.targetKey && grant.clientGeneration === registration.clientGeneration && grant.terminalId === registration.host.terminalId && grant.holderGeneration === expectedGeneration && grant.configurationHash === messagingConfigurationHash(target) && grant.status === "active" && createdAt >= grant.createdAt && createdAt < grant.expiresAt);
		if (existing) return { namespaceId: existing.namespaceId, descriptorPath, expiresAt: existing.expiresAt };
		const namespaceId = `msg_${randomUUID()}`;
		const secret = randomBytes(32).toString("base64url");
		const grant: HostedMessagingGrant = { namespaceId, secretDigest: digest(secret), participantKey, holderGeneration: expectedGeneration, targetKey: target.targetKey, clientGeneration: registration.clientGeneration, terminalId: registration.host.terminalId, configurationHash: messagingConfigurationHash(target), createdAt, expiresAt: createdAt + HOSTED_ACK_RETENTION_MS, status: "active", operations: {} };
		const fd = openSync(descriptorPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify({ version: 1, socketPath: this.socketPath, namespaceId, secret })}\n`);
			fsyncSync(fd);
			this.store.apply({ type: "messaging.issue", grant });
		} catch (error) {
			if (!(error instanceof HostedStateStorageError && error.uncertain)) unlinkSync(descriptorPath);
			throw error;
		} finally {
			closeSync(fd);
		}
		return { namespaceId, descriptorPath, expiresAt: grant.expiresAt };
	}

	/** Best-effort idle hint for a Pi holder: the oldest unread message in its sole live namespace. */
	unread(registration: HostedLiveRegistration): MessagingMailHint | undefined {
		const state = this.store.read();
		const grant = liveTargetNamespace(state, registration, this.now());
		if (!grant) return undefined;
		const [event] = Object.values(state.events)
			.filter((candidate): candidate is HostedMailboxMessageEvent => candidate.type === "mailbox.message" && candidate.recipientParticipantKey === grant.participantKey && candidate.readAt === undefined)
			.sort((left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId));
		return event ? { namespaceId: grant.namespaceId, eventId: event.eventId } : undefined;
	}

	async call(namespaceId: string, secret: string, input: MessagingInput): Promise<MessagingResult> {
		if (this.inFlight >= MAX_IN_FLIGHT) throw new RegistrationError("conflict", "Messaging request capacity is exhausted; retry the same operation ID.");
		this.inFlight++;
		try {
			const { grant, registration } = await this.verify(namespaceId, secret);
			switch (input.method) {
				case "peers": return this.peers(grant, input.cursor);
				case "receive": return this.receive(grant, input.eventId);
				case "received": return this.markRead(grant, input.eventId);
				case "status": return this.status(grant, input.operationId);
				case "send": return this.publish(registration, grant, input.operationId, this.recipientKey(grant, input.participantId), input.body);
				case "reply": return this.publishReply(registration, grant, input.operationId, input.eventId, input.body);
				default: {
					const unsupported: never = input;
					throw new RegistrationError("invalid_request", `Unsupported messaging method ${JSON.stringify(unsupported)}.`);
				}
			}
		} finally {
			this.inFlight--;
		}
	}

	private peers(grant: HostedMessagingGrant, cursor?: string): MessagingPeersResult {
		const state = this.store.read();
		const sender = this.requireParticipant(grant.participantKey);
		const peers = Object.values(state.participants).filter((p) => p.projectRoot === sender.projectRoot && p.protocol === sender.protocol && p.participantKey !== sender.participantKey).sort((a, b) => a.participantId.localeCompare(b.participantId));
		const offset = cursor === undefined ? 0 : peerCursorOffset(peers, grant.namespaceId, cursor);
		const page = peers.slice(offset, offset + PEER_PAGE).map((p) => ({ participantId: p.participantId, state: p.state, holderLive: p.state === "held" && p.holderTargetKey !== undefined && this.registrations.hasLiveTarget(p.holderTargetKey) }));
		const last = peers[offset + page.length - 1];
		const target = state.targets[grant.targetKey];
		if (!target) throw new RegistrationError("registration_stale", "Messaging target is absent.");
		const binding = target.kind === "pi" ? { kind: target.kind, sessionId: target.piSessionId, sessionFile: target.piSessionFile, cwd: target.worktreePath ?? target.projectRoot } : { kind: target.kind };
		const more = offset + page.length < peers.length && last !== undefined;
		return { namespaceId: grant.namespaceId, caller: sender.participantId, protocol: sender.protocol, binding, expiresAt: grant.expiresAt, peers: page, nextCursor: more && last ? Buffer.from(`${grant.namespaceId}:${last.participantKey}`).toString("base64url") : null };
	}

	private receive(grant: HostedMessagingGrant, eventId: string): MessagingMessageResult {
		const state = this.store.read();
		const event = messagingInboxEvent(state, grant, eventId);
		const sender = this.requireParticipant(event.source.id);
		const message: MessagingMessage = { eventId, from: sender.participantId, body: event.body, createdAt: event.createdAt };
		if (event.inReplyToEventId !== undefined) message.inReplyToEventId = event.inReplyToEventId;
		if (event.readAt !== undefined) message.readAt = event.readAt;
		return { namespaceId: grant.namespaceId, message };
	}

	private markRead(grant: HostedMessagingGrant, eventId: string): MessagingReadResult {
		this.store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventId, at: this.now() });
		const event = messagingInboxEvent(this.store.read(), grant, eventId);
		if (event.readAt === undefined) throw new RegistrationError("conflict", "Message read time was not recorded.");
		return { namespaceId: grant.namespaceId, eventId, readAt: event.readAt };
	}

	private status(grant: HostedMessagingGrant, operationId: string): MessagingStatusResult {
		const eventId = Object.hasOwn(grant.operations, operationId) ? grant.operations[operationId] : undefined;
		const event = eventId === undefined ? undefined : this.store.read().events[eventId];
		if (!event || event.type !== "mailbox.message") throw new RegistrationError("not_found", "Operation has no publication in this namespace.");
		return { namespaceId: grant.namespaceId, event };
	}

	private publishReply(registration: HostedLiveRegistration, grant: HostedMessagingGrant, operationId: string, eventId: string, body: string): MessagingPublishedResult {
		const inbound = messagingInboxEvent(this.store.read(), grant, eventId);
		return this.publish(registration, grant, operationId, inbound.source.id, body, eventId);
	}

	private publish(registration: HostedLiveRegistration, grant: HostedMessagingGrant, operationId: string, recipientParticipantKey: string, body: string, inReplyToEventId?: string): MessagingPublishedResult {
		this.participants.sendMessaging(registration, grant.namespaceId, { operationId, recipientParticipantKey, body, inReplyToEventId });
		const current = this.requireGrant(grant.namespaceId);
		const eventId = Object.hasOwn(current.operations, operationId) ? current.operations[operationId] : undefined;
		if (eventId === undefined) throw new RegistrationError("not_found", "Operation has no publication in this namespace.");
		return { namespaceId: grant.namespaceId, eventId };
	}

	private recipientKey(grant: HostedMessagingGrant, participantId: string): string {
		const sender = this.requireParticipant(grant.participantKey);
		return deriveParticipantKey(sender.projectRoot, sender.protocol, participantId);
	}

	private async verify(namespaceId: string, secret: string): Promise<{ grant: HostedMessagingGrant; registration: HostedLiveRegistration }> {
		this.authorize(namespaceId, secret);
		const registration = await this.registrations.verifyTarget(this.requireGrant(namespaceId).targetKey);
		this.authorize(namespaceId, secret);
		this.registrations.authorize(registration.registrationId, registration.registrationKey);
		const grant = this.requireGrant(namespaceId);
		if (registration.clientGeneration !== grant.clientGeneration || registration.host.terminalId !== grant.terminalId) {
			this.store.apply({ type: "messaging.close", namespaceId, status: "revoked" });
			throw new RegistrationError("registration_stale", "Messaging client binding changed.");
		}
		return { grant, registration };
	}

	private requireGrant(namespaceId: string): HostedMessagingGrant {
		const grant = this.store.read().messaging[namespaceId];
		if (!grant) throw new RegistrationError("registration_stale", "Messaging namespace is absent.");
		return grant;
	}

	private requireParticipant(participantKey: string): HostedParticipant {
		const participant = this.store.read().participants[participantKey];
		if (!participant) throw new RegistrationError("registration_stale", "Messaging participant is absent.");
		return participant;
	}

	private authorize(namespaceId: string, secret: string): void {
		const grants = this.store.read().messaging;
		const grant = Object.hasOwn(grants, namespaceId) ? grants[namespaceId] : undefined;
		if (!grant || !timingSafeEqual(Buffer.from(grant.secretDigest, "hex"), Buffer.from(digest(secret), "hex"))) throw new RegistrationError("registration_stale", "Messaging credential is absent or invalid.");
		if (this.now() >= grant.expiresAt) {
			this.store.apply({ type: "messaging.close", namespaceId, status: "expired" });
			throw new RegistrationError("registration_stale", "Messaging namespace expired; do not republish an uncertain operation under a new namespace.");
		}
		const sender = this.store.read().participants[grant.participantKey];
		const target = this.store.read().targets[grant.targetKey];
		if (grant.status !== "active" || this.now() < grant.createdAt || sender?.state !== "held" || sender.generation !== grant.holderGeneration || sender.holderTargetKey !== grant.targetKey || !target || messagingConfigurationHash(target) !== grant.configurationHash) throw new RegistrationError("registration_stale", "Messaging authority is revoked or no longer bound to this holder.");
	}
}

export function messagingDescriptorPath(root: string, targetKey: string, clientGeneration: string): string {
	return join(root, `messaging-${digest(JSON.stringify([targetKey, clientGeneration]))}.json`);
}

function liveTargetNamespace(state: HostedRuntimeState, registration: HostedLiveRegistration, at: number): HostedMessagingGrant | undefined {
	const target = state.targets[registration.targetKey];
	if (!target) return undefined;
	const eligible = Object.values(state.messaging).filter(grant => {
		const holder = state.participants[grant.participantKey];
		return grant.targetKey === registration.targetKey
			&& grant.status === "active"
			&& grant.clientGeneration === registration.clientGeneration
			&& grant.terminalId === registration.host.terminalId
			&& grant.configurationHash === messagingConfigurationHash(target)
			&& holder?.state === "held"
			&& holder.holderTargetKey === grant.targetKey
			&& holder.generation === grant.holderGeneration
			&& grant.createdAt <= at
			&& at < grant.expiresAt;
	});
	return eligible.length === 1 ? eligible[0] : undefined;
}

function peerCursorOffset(peers: HostedParticipant[], namespaceId: string, cursor: string): number {
	const decoded = Buffer.from(cursor, "base64url").toString("utf8");
	const index = peers.findIndex((peer) => decoded === `${namespaceId}:${peer.participantKey}`);
	if (index < 0 || Buffer.from(decoded).toString("base64url") !== cursor) throw new RegistrationError("invalid_request", "Messaging cursor is absent or outside this namespace.");
	return index + 1;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
