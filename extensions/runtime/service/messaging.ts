import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTED_ACK_RETENTION_MS, type HostedMessagingGrant } from "../hosted-types.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RegistrationError, RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore, messagingConfigurationHash } from "./state.ts";

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

	async issue(caller: HostedLiveRegistration, participantKey: string, expectedGeneration: string) {
		const callerParticipant = Object.values(this.store.read().participants).find((p) => p.state === "held" && p.holderTargetKey === caller.targetKey);
		const participant = this.store.read().participants[participantKey];
		if (this.store.read().targets[caller.targetKey]?.kind !== "pi" || !callerParticipant || !participant || callerParticipant.projectRoot !== participant.projectRoot || callerParticipant.protocol !== participant.protocol || participant.state !== "held" || participant.generation !== expectedGeneration) throw new RegistrationError("identity_mismatch", "Messaging issuance requires a held Pi controller in the exact project/protocol and target generation.");
		const registration = await this.registrations.verifyTarget(participant.holderTargetKey!);
		this.registrations.authorize(caller.registrationId, caller.registrationKey);
		this.registrations.authorize(registration.registrationId, registration.registrationKey);
		const currentCaller = this.store.read().participants[callerParticipant.participantKey];
		if (currentCaller?.state !== "held" || currentCaller.generation !== callerParticipant.generation || currentCaller.holderTargetKey !== caller.targetKey) throw new RegistrationError("registration_stale", "Messaging controller changed during verification.");
		const target = this.store.read().targets[registration.targetKey]!;
		const currentParticipant = this.store.read().participants[participantKey];
		if (currentParticipant?.state !== "held" || currentParticipant.generation !== expectedGeneration || currentParticipant.holderTargetKey !== registration.targetKey) throw new RegistrationError("registration_stale", "Messaging recipient authority changed during issuance.");
		const createdAt = this.now();
		const descriptorPath = messagingDescriptorPath(this.store.root, target.targetKey, registration.clientGeneration);
		const existing = Object.values(this.store.read().messaging).find(grant => grant.targetKey === target.targetKey && grant.clientGeneration === registration.clientGeneration && grant.terminalId === registration.host.terminalId && grant.holderGeneration === expectedGeneration && grant.configurationHash === messagingConfigurationHash(target) && grant.status === "active" && createdAt >= grant.createdAt && createdAt < grant.expiresAt);
		if (existing) return { namespaceId: existing.namespaceId, descriptorPath, expiresAt: existing.expiresAt };
		const namespaceId = `msg_${randomUUID()}`;
		const secret = randomBytes(32).toString("base64url");
		const grant: HostedMessagingGrant = { namespaceId, secretDigest: digest(secret), participantKey, holderGeneration: expectedGeneration, targetKey: target.targetKey, clientGeneration: registration.clientGeneration, terminalId: registration.host.terminalId, configurationHash: messagingConfigurationHash(target), createdAt, expiresAt: createdAt + HOSTED_ACK_RETENTION_MS, status: "active", receipts: {} };
		const fd = openSync(descriptorPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify({ version: 1, socketPath: this.socketPath, namespaceId, secret })}\n`);
			fsyncSync(fd);
			this.store.apply({ type: "messaging.issue", grant });
		} catch (error) {
			unlinkSync(descriptorPath);
			throw error;
		} finally {
			closeSync(fd);
		}
		return { namespaceId, descriptorPath, expiresAt: grant.expiresAt };
	}

	async call(namespaceId: string, secret: string, input: MessagingInput) {
		if (this.inFlight >= 12) throw new RegistrationError("conflict", "Messaging request capacity is exhausted; retry the same operation ID.");
		this.inFlight++;
		try {
			this.authorize(namespaceId, secret);
			const grant = this.store.read().messaging[namespaceId]!;
			const registration = await this.registrations.verifyTarget(grant.targetKey);
			this.authorize(namespaceId, secret);
			this.registrations.authorize(registration.registrationId, registration.registrationKey);
			if (registration.clientGeneration !== grant.clientGeneration || registration.host.terminalId !== grant.terminalId) {
				this.store.apply({ type: "messaging.close", namespaceId, status: "revoked" });
				throw new RegistrationError("registration_stale", "Messaging client binding changed.");
			}
			const sender = this.store.read().participants[grant.participantKey]!;
			if (input.method === "peers") {
				const peers = Object.values(this.store.read().participants).filter((p) => p.projectRoot === sender.projectRoot && p.protocol === sender.protocol && p.participantKey !== sender.participantKey).sort((a, b) => a.participantId.localeCompare(b.participantId));
				let offset = 0;
				if (input.cursor !== undefined) {
					const decoded = Buffer.from(input.cursor, "base64url").toString("utf8");
					const prefix = `${namespaceId}:`;
					const index = peers.findIndex((p) => decoded === `${prefix}${p.participantKey}`);
					if (index < 0 || Buffer.from(decoded).toString("base64url") !== input.cursor) throw new RegistrationError("invalid_request", "Messaging cursor is absent or outside this namespace.");
					offset = index + 1;
				}
				const page = peers.slice(offset, offset + 12).map((p) => ({ participantId: p.participantId, state: p.state, holderLive: p.state === "held" && this.registrations.hasLiveTarget(p.holderTargetKey!) }));
				const last = peers[offset + page.length - 1];
				return { caller: sender.participantId, protocol: sender.protocol, namespaceId, expiresAt: grant.expiresAt, peers: page, nextCursor: offset + page.length < peers.length && last ? Buffer.from(`${namespaceId}:${last.participantKey}`).toString("base64url") : null };
			}
			if (input.method === "send") {
				const recipientParticipantKey = deriveParticipantKey(sender.projectRoot, sender.protocol, input.participantId);
				this.participants.sendMessaging(registration, namespaceId, input.operationId, recipientParticipantKey, input.body);
			}
			const current = this.store.read().messaging[namespaceId]!;
			const receipt = Object.hasOwn(current.receipts, input.operationId) ? current.receipts[input.operationId] : undefined;
			if (!receipt) throw new RegistrationError("not_found", "Operation has no publication receipt in this namespace.");
			const { fingerprint: _fingerprint, ...publication } = receipt;
			if (input.method === "send") return { namespaceId, publication };
			const event = this.store.read().events[receipt.eventId];
			return { namespaceId, publication, event: event ?? null, history: event ? "retained" : "pruned" };
		} finally {
			this.inFlight--;
		}
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

export type MessagingInput =
	| { method: "peers"; cursor?: string }
	| { method: "send"; participantId: string; operationId: string; body: string }
	| { method: "status"; operationId: string };

export function messagingDescriptorPath(root: string, targetKey: string, clientGeneration: string): string {
	return join(root, `messaging-${digest(JSON.stringify([targetKey, clientGeneration]))}.json`);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
