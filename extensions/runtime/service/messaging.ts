import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type HostedMailboxMessageEvent,
	type HostedMessagingGrant,
	type HostedParticipant,
	type HostedRuntimeState,
	type HostedTarget,
	holds, isHeld,
	isPiTarget,
} from "../schemas/state.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RuntimeError } from "../errors.ts";
import { LiveTargets, type HostedCaller } from "./live.ts";
import type { MessagingInboxMessageView, MessagingInboxView } from "../schemas/rpc.ts";
import {
	deriveParticipantKey,
	HostedStateStorageError,
	HostedStateStore,
	messagingConfigurationHash,
	messagingGrantIsLive,
} from "./state.ts";

const MAX_IN_FLIGHT = 12;
const INBOX_PAGE = 50;
const INBOX_PAGE_BYTES = 96 * 1024;

export type MessagingInput =
	| { method: "inbox"; peek: boolean }
	| { method: "read"; eventIds: string[] }
	| { method: "send"; participantId: string; operationId: string; body: string };

interface VerifiedNamespace {
	grant: HostedMessagingGrant;
	registration: HostedCaller;
}

interface MessagingMailHint {
	namespaceId: string;
	eventId: string;
}

interface MessagingIssued {
	namespaceId: string;
	descriptorPath: string;
}

interface MessagingEventResult {
	eventId: string;
}

interface MessagingReadResult {
	read: number;
}

type MessagingResult = MessagingInboxView | MessagingEventResult | MessagingReadResult;

export class RuntimeMessaging {
	private inFlight = 0;
	private readonly store: HostedStateStore;
	private readonly live: LiveTargets;
	private readonly participants: HostedParticipantCoordinator;
	private readonly socketPath: string;
	private readonly now: () => number;
	private readonly onPublished: () => void;

	constructor(
		store: HostedStateStore,
		live: LiveTargets,
		participants: HostedParticipantCoordinator,
		socketPath: string,
		now: () => number = Date.now,
		onPublished: () => void = () => {},
	) {
		this.store = store;
		this.live = live;
		this.participants = participants;
		this.socketPath = socketPath;
		this.now = now;
		this.onPublished = onPublished;
	}

	async issue(caller: HostedCaller, participantKey: string, expectedGeneration: string): Promise<MessagingIssued> {
		const state = this.store.read();
		const callerParticipant = Object.values(state.participants).find((candidate) => holds(candidate, caller.targetKey));
		const participant = state.participants[participantKey];
		if (!isPiTarget(state.targets[caller.targetKey]) || !callerParticipant || !participant) throw issuanceMismatch();
		if (!issuanceScopeMatches(callerParticipant, participant, expectedGeneration)) throw issuanceMismatch();
		const holderTargetKey = participant.holderTargetKey;
		if (!holderTargetKey) throw issuanceMismatch();
		const registration = await this.live.verify(holderTargetKey);
		const currentCaller = this.store.read().participants[callerParticipant.participantKey];
		if (!holds(currentCaller, caller.targetKey, callerParticipant.generation)) {
			throw new RuntimeError("registration_stale", "Messaging controller changed during verification.");
		}
		const target = this.store.read().targets[registration.targetKey];
		const currentParticipant = this.store.read().participants[participantKey];
		if (!target || !holds(currentParticipant, registration.targetKey, expectedGeneration)) {
			throw new RuntimeError("registration_stale", "Messaging recipient authority changed during issuance.");
		}
		const descriptorPath = messagingDescriptorPath(this.store.root, target.targetKey);
		const current = this.store.read();
		const existing = Object.values(current.messaging)
			.find((grant) => reusableGrant(current, grant, target, expectedGeneration));
		// The reused secret only exists on disk, so a descriptor that names another namespace forces a fresh grant.
		if (existing && descriptorNames(descriptorPath, existing.namespaceId)) {
			return { namespaceId: existing.namespaceId, descriptorPath };
		}
		const secret = randomBytes(32).toString("base64url");
		const grant: HostedMessagingGrant = {
			namespaceId: `msg_${randomUUID()}`,
			secretDigest: digest(secret),
			participantKey,
			holderGeneration: expectedGeneration,
			targetKey: target.targetKey,
			configurationHash: messagingConfigurationHash(target),
			createdAt: this.now(),
			status: "active",
			operations: {},
		};
		this.writeDescriptor(descriptorPath, grant, secret);
		return { namespaceId: grant.namespaceId, descriptorPath };
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
	unread(registration: HostedCaller): MessagingMailHint | undefined {
		const state = this.store.read();
		const grant = liveTargetNamespace(state, registration);
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
				case "inbox": return this.inbox(grant, input.peek);
				case "read": return this.read(grant, input.eventIds);
				case "send": return this.publish(registration, grant, input.operationId, this.recipientKey(grant, input.participantId), input.body);
			}
		} finally {
			this.inFlight--;
		}
	}

	/** Unless peeked, delivery is the read: whatever this page returns is marked read in the same state write. */
	private inbox(grant: HostedMessagingGrant, peek: boolean): MessagingInboxView {
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
		if (!peek && messages.length > 0) this.read(grant, messages.map((message) => message.eventId));
		return { messages, truncated: unread.length > messages.length };
	}

	/** A peeking reader marks what it has delivered: a Pi once its session holds the message. */
	private read(grant: HostedMessagingGrant, eventIds: string[]): MessagingReadResult {
		this.store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventIds, at: this.now() });
		return { read: eventIds.length };
	}

	private publish(
		registration: HostedCaller,
		grant: HostedMessagingGrant,
		operationId: string,
		recipientParticipantKey: string,
		body: string,
	): MessagingEventResult {
		this.participants.sendMessaging(registration, grant.namespaceId, { operationId, recipientParticipantKey, body });
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
		const registration = await this.live.verify(this.requireGrant(namespaceId).targetKey);
		this.authorize(namespaceId, secret);
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
		if (!messagingGrantIsLive(this.store.read(), grant)) {
			throw new RuntimeError("registration_stale", "Messaging authority is superseded or no longer bound to this holder.");
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

function reusableGrant(
	state: HostedRuntimeState,
	grant: HostedMessagingGrant,
	target: HostedTarget,
	expectedGeneration: string,
): boolean {
	return grant.targetKey === target.targetKey
		&& grant.holderGeneration === expectedGeneration
		&& messagingGrantIsLive(state, grant);
}

export function messagingDescriptorPath(root: string, targetKey: string): string {
	return join(root, `messaging-${digest(targetKey)}.json`);
}

function liveTargetNamespace(state: HostedRuntimeState, registration: HostedCaller): HostedMessagingGrant | undefined {
	const eligible = Object.values(state.messaging)
		.filter(grant => grant.targetKey === registration.targetKey && messagingGrantIsLive(state, grant));
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
