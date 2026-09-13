import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	HOSTED_ACK_RETENTION_MS,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
	HOSTED_STATE_MAX_BYTES,
	type HostedAgentBind,
	type HostedAgentSessionIdentity,
	type HostedAgentTarget,
	type HostedClaim,
	type HostedEvent,
	type HostedEventDelivery,
	type HostedFileObservation,
	type HostedFilesystemCreatedEvent,
	type HostedHerdrLocator,
	type HostedMailboxMessageEvent,
	type HostedMessagingGrant,
	type HostedMessagingSend,
	type HostedMonitor,
	type HostedParticipant,
	type HostedParticipantTransition,
	type HostedRuntimeInstance,
	type HostedRuntimeState,
	type HostedStateOperation,
	type HostedTarget,
	type HostedWake,
} from "../hosted-types.ts";

const MAX_ID_BYTES = 200;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024;
const MAX_STATE_RECORDS = 10_000;
const HASH = /^[0-9a-f]{64}$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const INSTANCE_MAX_BYTES = 4 * 1024;

type PersistedStateValue = null | boolean | number | string | PersistedStateValue[] | PersistedStateFields;

interface PersistedStateFields {
	[field: string]: PersistedStateValue | undefined;
}

export class HostedStateStorageError extends Error {
	readonly code = "storage_error" as const;

	readonly uncertain: boolean;

	constructor(message: string, uncertain = false) {
		super(message);
		this.uncertain = uncertain;
	}
}

export class HostedStateConflictError extends Error {
	readonly code: "conflict" | "claim_conflict";

	constructor(code: "conflict" | "claim_conflict", message: string) {
		super(message);
		this.code = code;
	}
}

export function emptyHostedRuntimeState(): HostedRuntimeState {
	return { version: 17, messaging: {}, targets: {}, monitors: {}, participants: {}, events: {}, dedupe: {}, claims: {}, wakes: {} };
}

export class HostedStateStore {
	readonly root: string;
	private state: HostedRuntimeState;
	private uncertain = false;

	constructor(root: string) {
		this.root = root;
		this.state = readHostedRuntimeState(root);
		// A process restart alone does not flush a previously uncertain rename.
		try {
			const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
			try { fsyncSync(directory); } finally { closeSync(directory); }
		} catch (error) { throw storageError("Cannot confirm recovered runtime storage", error, true); }
	}

	read(): HostedRuntimeState {
		if (this.uncertain) throw new HostedStateStorageError("Runtime storage outcome is uncertain; restart and recover before reading or mutating state.", true);
		return this.state;
	}

	apply(operation: HostedStateOperation): HostedRuntimeState {
		const next = reduceHostedState(this.read(), operation);
		if (next === this.state) return this.state;
		try { writeHostedRuntimeState(this.root, next); }
		catch (error) {
			if (error instanceof HostedStateStorageError && error.uncertain) this.uncertain = true;
			throw error;
		}
		this.state = next;
		return next;
	}
}

export function reduceHostedState(state: HostedRuntimeState, operation: HostedStateOperation): HostedRuntimeState {
	if (operation.type === "messaging.issue") {
		const grant = validateMessagingGrant(operation.grant, operation.grant.namespaceId);
		if (state.messaging[grant.namespaceId] || grant.status !== "active" || Object.keys(grant.operations).length) throw new HostedStateConflictError("conflict", "Messaging namespace must be newly issued.");
		assertMessagingHolder(state, grant, grant.createdAt);
		return { ...state, messaging: { ...state.messaging, [grant.namespaceId]: grant } };
	}
	if (operation.type === "messaging.close") {
		const grant = state.messaging[operation.namespaceId];
		if (!grant || grant.status === "expired" || grant.status === "revoked" && operation.status === "revoked") return state;
		// ponytail: terminal namespace IDs remain under the 10,000-record cap; prune tombstones if launch volume requires it.
		const closed = { ...grant, status: operation.status, operations: operation.status === "expired" ? {} : grant.operations };
		return { ...state, messaging: { ...state.messaging, [grant.namespaceId]: closed } };
	}
	if (operation.type === "messaging.invalidate_client") {
		let next = state;
		for (const grant of Object.values(state.messaging)) {
			if (grant.targetKey === operation.targetKey && (grant.clientGeneration !== operation.clientGeneration || grant.terminalId !== operation.terminalId)) next = reduceHostedState(next, { type: "messaging.close", namespaceId: grant.namespaceId, status: "revoked" });
		}
		return next;
	}
	if (operation.type === "messaging.read") {
		const grant = state.messaging[operation.namespaceId];
		if (!grant) throw new HostedStateConflictError("conflict", "Messaging namespace is absent.");
		assertMessagingHolder(state, grant, operation.at);
		const event = messagingInboxEvent(state, grant, operation.eventId);
		if (event.readAt !== undefined) return state;
		return { ...state, events: { ...state.events, [event.eventId]: { ...event, readAt: operation.at } } };
	}
	if (operation.type === "messaging.send") return publishMessagingEvent(state, operation);

	if (operation.type === "target.ensure") {
		const existing = state.targets[operation.target.targetKey];
		if (existing) {
			if (!sameTarget(existing, operation.target)) throw new HostedStateConflictError("conflict", "Target identity does not match its durable key.");
			return state;
		}
		return { ...state, targets: { ...state.targets, [operation.target.targetKey]: operation.target } };
	}

	if (operation.type === "agent.bind") return bindAgentTarget(state, operation.bind);

	if (operation.type === "monitor.create") {
		const monitor = operation.monitor;
		if (!state.targets[monitor.targetKey] || Object.keys(monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
		const existingId = state.monitors[monitor.monitorId];
		if (existingId && !sameMonitorIdentity(existingId, monitor)) throw new HostedStateConflictError("conflict", "Monitor ID already belongs to another monitor.");
		const existingTarget = Object.values(state.monitors).find((candidate) => candidate.targetKey === monitor.targetKey);
		if (existingTarget) {
			if (existingTarget.directory !== monitor.directory) throw new HostedStateConflictError("conflict", "Target already owns another monitor.");
			return state;
		}
		return { ...state, monitors: { ...state.monitors, [monitor.monitorId]: monitor } };
	}

	if (operation.type === "monitor.delete") {
		const monitor = state.monitors[operation.monitorId];
		if (!monitor || monitor.targetKey !== operation.targetKey) return state;
		const monitors = { ...state.monitors };
		delete monitors[operation.monitorId];
		return { ...state, monitors };
	}

	if (operation.type === "monitor.commit") {
		const current = state.monitors[operation.monitor.monitorId];
		if (!current || !sameMonitorIdentity(current, operation.monitor)) return state;
		if (operation.monitor.createdAt !== current.createdAt || operation.monitor.sequence < current.sequence || operation.monitor.updatedAt < current.updatedAt) return state;
		if (Object.keys(operation.monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
		if (operation.events.some((event) => !validMonitorEvent(operation.monitor, event) || event.source.sequence <= current.sequence || event.source.sequence > operation.monitor.sequence)) return state;
		let changed = current !== operation.monitor;
		const events = { ...state.events };
		const dedupe = { ...state.dedupe };
		for (const event of operation.events) {
			if (events[event.eventId] || dedupe[event.dedupeKey]) continue;
			events[event.eventId] = event;
			dedupe[event.dedupeKey] = event.eventId;
			changed = true;
		}
		if (!changed) return state;
		return {
			...state,
			monitors: { ...state.monitors, [operation.monitor.monitorId]: operation.monitor },
			events,
			dedupe,
		};
	}

	if (operation.type === "participant.acquire") {
		assertStateId(operation.generation, "Participant generation");
		assertStateTime(operation.at, "Participant acquisition time");
		const target = state.targets[operation.targetKey];
		if (!target || target.projectRoot !== operation.projectRoot || operation.participantKey !== deriveParticipantKey(operation.projectRoot, operation.protocol, operation.participantId)) {
			throw new HostedStateConflictError("conflict", "Participant identity does not match its target or durable key.");
		}
		assertParticipantName(operation.protocol, "protocol");
		assertParticipantName(operation.participantId, "participant ID");
		const current = state.participants[operation.participantKey];
		if (current?.state === "held") {
			if (current.holderTargetKey === operation.targetKey) return state;
			throw new HostedStateConflictError("conflict", "Participant is held by another target.");
		}
		assertTargetHasNoParticipant(state, operation.targetKey, operation.participantKey);
		if (!current) {
			const participant: HostedParticipant = {
				participantKey: operation.participantKey,
				projectRoot: operation.projectRoot,
				protocol: operation.protocol,
				participantId: operation.participantId,
				state: "held",
				generation: operation.generation,
				holderTargetKey: operation.targetKey,
				outSeq: {},
				transitions: [{ cause: "acquire", generation: operation.generation, holderTargetKey: operation.targetKey, at: operation.at }],
				createdAt: operation.at,
				updatedAt: operation.at,
			};
			if (target.worktreePath) participant.worktreePath = target.worktreePath;
			return { ...state, participants: { ...state.participants, [participant.participantKey]: participant } };
		}
		if (current.projectRoot !== operation.projectRoot || current.protocol !== operation.protocol || current.participantId !== operation.participantId || current.generation === operation.generation || operation.at < current.updatedAt) {
			throw new HostedStateConflictError("conflict", "Participant acquire does not match its durable identity or generation.");
		}
		const cause = current.state === "vacant" ? "reacquire" : "revive";
		return replaceParticipant(state, withTargetWorktree(transitionParticipant(current, {
			cause,
			generation: operation.generation,
			holderTargetKey: operation.targetKey,
			previousGeneration: current.generation,
			previousHolderTargetKey: latestHolderTargetKey(current),
			at: operation.at,
		}, "held", operation.targetKey), target));
	}

	if (operation.type === "participant.worktree.clear") {
		const current = state.participants[operation.participantKey];
		if (!current) throw new HostedStateConflictError("conflict", "Participant is absent.");
		if (current.state === "held") throw new HostedStateConflictError("conflict", "A held participant keeps its worktree until it stands down.");
		if (!current.worktreePath) return state;
		const { worktreePath: _cleared, ...participant } = current;
		return replaceParticipant(state, participant);
	}

	if (operation.type === "participant.stand_down" || operation.type === "participant.release") {
		assertStateId(operation.generation, "Participant generation");
		assertStateTime(operation.at, "Participant transition time");
		const current = state.participants[operation.participantKey];
		const cause = operation.type === "participant.stand_down" ? "stand_down" : "release";
		const nextState = operation.type === "participant.stand_down" ? "vacant" : "ended";
		if (!current) throw new HostedStateConflictError("conflict", "Participant is absent.");
		if (operation.type === "participant.stand_down" && operation.expectedGeneration !== undefined && current.generation !== operation.expectedGeneration) {
			const latest = current.transitions.at(-1);
			if (current.state === "vacant" && latest?.cause === "stand_down" && latest.previousGeneration === operation.expectedGeneration && latest.previousHolderTargetKey === operation.targetKey) return state;
			throw new HostedStateConflictError("conflict", "Participant generation changed before stand-down.");
		}
		if (current.state !== "held" || current.holderTargetKey !== operation.targetKey) {
			const latest = current.transitions.at(-1);
			if (current.state === nextState && latest?.cause === cause && latest.previousHolderTargetKey === operation.targetKey) return state;
			throw new HostedStateConflictError("conflict", "Only the current participant holder may change its state.");
		}
		if (current.generation === operation.generation || operation.at < current.updatedAt) throw new HostedStateConflictError("conflict", "Participant transition generation or time does not advance.");
		return replaceParticipant(state, transitionParticipant(current, {
			cause,
			generation: operation.generation,
			previousGeneration: current.generation,
			previousHolderTargetKey: current.holderTargetKey,
			at: operation.at,
		}, nextState));
	}

	if (operation.type === "participant.takeover") {
		assertStateId(operation.generation, "Participant generation");
		assertStateTime(operation.at, "Participant takeover time");
		const current = state.participants[operation.participantKey];
		const target = state.targets[operation.targetKey];
		if (!current || current.state !== "held" || !target || target.projectRoot !== current.projectRoot) throw new HostedStateConflictError("conflict", "Participant is not eligible for takeover.");
		if (current.holderTargetKey === operation.targetKey) return state;
		if (current.generation === operation.generation || operation.at < current.updatedAt || hasActiveParticipantClaim(state, current.participantKey)) throw new HostedStateConflictError("conflict", "Participant takeover is blocked by its current generation, time, or active claims.");
		assertTargetHasNoParticipant(state, operation.targetKey, current.participantKey);
		return replaceParticipant(state, transitionParticipant(current, {
			cause: "takeover",
			generation: operation.generation,
			holderTargetKey: operation.targetKey,
			previousGeneration: current.generation,
			previousHolderTargetKey: current.holderTargetKey,
			at: operation.at,
		}, "held", operation.targetKey));
	}

	if (operation.type === "mailbox.send") {
		assertStateId(operation.eventId, "Mailbox event ID");
		assertStateTime(operation.at, "Mailbox send time");
		const sender = state.participants[operation.senderParticipantKey];
		const recipient = state.participants[operation.recipientParticipantKey];
		if (!sender || sender.state !== "held" || sender.generation !== operation.expectedSenderGeneration || sender.holderTargetKey !== operation.senderTargetKey) throw new HostedStateConflictError("conflict", "Mailbox sender identity or generation changed before send.");
		if (!recipient || recipient.state === "ended") throw new HostedStateConflictError("conflict", "Mailbox recipient is unavailable.");
		if (sender.participantKey === recipient.participantKey || sender.projectRoot !== recipient.projectRoot || sender.protocol !== recipient.protocol) throw new HostedStateConflictError("conflict", "Mailbox participants must be distinct and share one project and protocol.");
		if (operation.at < sender.updatedAt) throw new HostedStateConflictError("conflict", "Mailbox send time precedes sender state.");
		if (!operation.body.trim() || Buffer.byteLength(operation.body) > HOSTED_MAILBOX_MAX_BODY_BYTES) throw new HostedStateConflictError("conflict", "Mailbox body is empty or exceeds its byte limit.");
		if (!operation.sendId.trim() || Buffer.byteLength(operation.sendId) > MAX_ID_BYTES) throw new HostedStateConflictError("conflict", "Mailbox send ID is invalid.");
		const dedupeKey = mailboxDedupeKey(sender.participantKey, operation.sendId);
		const existingId = state.dedupe[dedupeKey];
		if (existingId) {
			const existing = state.events[existingId];
			const sameSend = existing?.type === "mailbox.message"
				&& existing.source.id === sender.participantKey
				&& existing.recipientParticipantKey === recipient.participantKey
				&& existing.sendId === operation.sendId
				&& existing.body === operation.body;
			if (sameSend) return state;
			throw new HostedStateConflictError("conflict", "Mailbox send ID was already used with different input.");
		}
		if (state.events[operation.eventId]) throw new HostedStateConflictError("conflict", "Mailbox event ID already exists.");
		const sequence = (sender.outSeq[recipient.participantKey] ?? 0) + 1;
		const event: HostedMailboxMessageEvent = {
			version: 1,
			eventId: operation.eventId,
			dedupeKey,
			type: "mailbox.message",
			source: { kind: "participant", id: sender.participantKey, generation: sender.generation, sequence },
			recipientParticipantKey: recipient.participantKey,
			sendId: operation.sendId,
			body: operation.body,
			createdAt: operation.at,
			summary: `message from ${sender.participantId} to ${recipient.participantId}`,
			delivery: { status: "pending" },
		};
		const nextSender = { ...sender, outSeq: { ...sender.outSeq, [recipient.participantKey]: sequence }, updatedAt: operation.at };
		return {
			...state,
			participants: { ...state.participants, [sender.participantKey]: nextSender },
			events: { ...state.events, [event.eventId]: event },
			dedupe: { ...state.dedupe, [dedupeKey]: event.eventId },
		};
	}

	if (operation.type === "inbox.claim") return claimEvents(state, operation.claim);

	if (operation.type === "inbox.ack") {
		const claim = state.claims[operation.claimId];
		if (!claim || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds)) return state;
		if (claim.status === "acked") return state;
		const claimEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (!claimEvents.every((event): event is HostedEvent => event !== undefined && eventClaimTargetMatches(state, event, claim.targetKey) && deliveryBelongsToClaim(event.delivery, claim.claimId))) return state;
		const events = { ...state.events };
		for (const event of claimEvents) {
			if (event.delivery.status !== "acked") events[event.eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
		}
		return pruneAcknowledged({
			...state,
			claims: { ...state.claims, [claim.claimId]: { ...claim, status: "acked", settledAt: operation.at } },
			events,
		}, Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
	}

	if (operation.type === "inbox.reconcile_many") {
		if (operation.receipts.length > HOSTED_MAX_DELIVERY_BATCH || new Set(operation.receipts.map((receipt) => receipt.claimId)).size !== operation.receipts.length) throw new HostedStateConflictError("claim_conflict", "Admission reconciliation receipts are invalid.");
		let next = state;
		for (const receipt of operation.receipts) next = reduceHostedState(next, { type: "inbox.reconcile", targetKey: operation.targetKey, claimId: receipt.claimId, eventIds: receipt.eventIds, at: operation.at });
		return next;
	}

	if (operation.type === "inbox.reconcile") {
		const claim = state.claims[operation.claimId];
		if (!claim || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds) || claim.status === "acked") return state;
		const admittedEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (!admittedEvents.every((event): event is HostedEvent => event !== undefined && eventClaimTargetMatches(state, event, claim.targetKey))) return state;
		if (admittedEvents.some((event) => event.delivery.status === "acked" && event.delivery.claimId !== claim.claimId)) return state;
		let next = state;
		const competingClaims = new Set(admittedEvents.flatMap((event) => event?.delivery.status === "claimed" && event.delivery.claimId !== claim.claimId ? [event.delivery.claimId] : []));
		for (const competingClaimId of competingClaims) {
			const competing = next.claims[competingClaimId];
			if (competing?.status === "active") next = releaseClaim(next, competing.targetKey, competing.claimId, competing.eventIds, operation.at);
		}
		const events = { ...next.events };
		for (const event of admittedEvents) events[event.eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
		return pruneAcknowledged({
			...next,
			claims: { ...next.claims, [claim.claimId]: { ...claim, status: "acked", settledAt: operation.at } },
			events,
		}, Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
	}

	if (operation.type === "inbox.release") return releaseClaim(state, operation.targetKey, operation.claimId, operation.eventIds, operation.at);

	if (operation.type === "inbox.release_expired") {
		let next = state;
		for (const claim of Object.values(state.claims)) {
			if (claim.status === "active" && claim.leaseUntil <= operation.at) next = releaseClaim(next, claim.targetKey, claim.claimId, claim.eventIds, operation.at);
		}
		return next;
	}

	if (operation.type === "retention.prune") return pruneAcknowledged(state, operation.before);

	if (operation.type === "wake.set") {
		if (!state.targets[operation.wake.targetKey]) return state;
		const existing = state.wakes[operation.wake.targetKey];
		if (existing) {
			if (!sameWake(existing, operation.wake)) throw new HostedStateConflictError("conflict", "Target already has another outstanding wake.");
			return state;
		}
		return { ...state, wakes: { ...state.wakes, [operation.wake.targetKey]: operation.wake } };
	}

	if (operation.type === "wake.accept") {
		const wake = state.wakes[operation.claim.targetKey];
		const existingClaim = state.claims[operation.claim.claimId];
		if (!wake) {
			if (existingClaim && sameClaim(existingClaim, operation.claim)) return claimEvents(state, operation.claim);
			throw new HostedStateConflictError("claim_conflict", "Wake is absent or no longer current.");
		}
		if (wake.wakeId !== operation.wakeId || wake.registrationId !== operation.claim.registrationId) throw new HostedStateConflictError("claim_conflict", "Wake does not match this claim owner.");
		const expected = pendingHostedEvents(state, wake.targetKey).slice(0, HOSTED_MAX_DELIVERY_BATCH).map((event) => event.eventId);
		if (expected.length === 0 || !sameOrderedIds(expected, operation.claim.eventIds)) throw new HostedStateConflictError("claim_conflict", "Wake claim is not the current first delivery batch.");
		const claimed = claimEvents(state, operation.claim);
		const wakes = { ...claimed.wakes };
		delete wakes[wake.targetKey];
		return { ...claimed, wakes };
	}

	if (operation.type === "wake.clear") {
		const wake = state.wakes[operation.targetKey];
		if (!wake || wake.wakeId !== operation.wakeId) return state;
		const wakes = { ...state.wakes };
		delete wakes[operation.targetKey];
		return { ...state, wakes };
	}

	return state;
}

export function pendingHostedEvents(state: HostedRuntimeState, targetKey: string): HostedEvent[] {
	return Object.values(state.events)
		.filter((event) => event.delivery.status === "pending" && hostedEventRoutesToTarget(state, event, targetKey))
		.sort((a, b) => a.createdAt - b.createdAt || a.source.kind.localeCompare(b.source.kind) || a.source.id.localeCompare(b.source.id) || a.source.generation.localeCompare(b.source.generation) || a.source.sequence - b.source.sequence || a.eventId.localeCompare(b.eventId));
}

export function deriveParticipantKey(projectRoot: string, protocol: string, participantId: string): string {
	return `participant_${createHash("sha256").update(projectRoot).update("\0").update(protocol).update("\0").update(participantId).digest("hex")}`;
}

export function deriveAgentTargetKey(projectRoot: string, agentName: string): string {
	return `agent_${createHash("sha256").update(projectRoot).update("\0").update(agentName).digest("hex")}`;
}

export function runtimeStatePaths(root: string) {
	return { instance: join(root, "instance.json"), state: join(root, "state.v1.json") };
}

export function loadOrCreateRuntimeInstance(root: string, createId: () => string = () => `rt_${randomUUID()}`): HostedRuntimeInstance {
	prepareRoot(root);
	const path = runtimeStatePaths(root).instance;
	const existing = readJson(path, INSTANCE_MAX_BYTES);
	if (existing !== undefined) return validateInstance(existing);
	const instance: HostedRuntimeInstance = { version: 1, runtimeId: createId() };
	writeAtomicJson(root, path, instance, INSTANCE_MAX_BYTES);
	return instance;
}

export function readHostedRuntimeState(root: string): HostedRuntimeState {
	prepareRoot(root);
	const path = runtimeStatePaths(root).state;
	const value = readJson(path, HOSTED_STATE_MAX_BYTES);
	if (value === undefined) return emptyHostedRuntimeState();
	return validateHostedRuntimeState(value);
}

export function writeHostedRuntimeState(root: string, state: HostedRuntimeState): void {
	prepareRoot(root);
	writeAtomicJson(root, runtimeStatePaths(root).state, validateHostedRuntimeState(state), HOSTED_STATE_MAX_BYTES);
}

export function validateHostedRuntimeState<Source>(value: Source): HostedRuntimeState {
	try {
		const fields = ["version", "messaging", "targets", "monitors", "participants", "events", "dedupe", "claims", "wakes"];
		const state = strictObject(value, "runtime state", fields);
		if (state.version !== 17) throw new Error("unsupported runtime state version");
		const result: HostedRuntimeState = {
			version: 17,
			messaging: mapValues(state.messaging, "messaging namespaces", validateMessagingGrant),
			targets: mapValues(state.targets, "targets", validateTarget),
			monitors: mapValues(state.monitors, "monitors", validateMonitor),
			participants: mapValues(state.participants, "participants", validateParticipant),
			events: mapValues(state.events, "events", validateEvent),
			dedupe: mapStrings(state.dedupe, "dedupe"),
			claims: mapValues(state.claims, "claims", validateClaim),
			wakes: mapValues(state.wakes, "wakes", validateWake),
		};
		validateStateIntegrity(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state is malformed", error);
	}
}

function messagingSendId(namespaceId: string, operationId: string): string {
	return `mcp_${createHash("sha256").update(JSON.stringify([namespaceId, operationId])).digest("hex")}`;
}

export function messagingInboxEvent(state: HostedRuntimeState, grant: HostedMessagingGrant, eventId: string): HostedMailboxMessageEvent {
	const event = state.events[eventId];
	if (event?.type !== "mailbox.message") throw new HostedStateConflictError("conflict", "Event is not ordinary mail.");
	if (event.recipientParticipantKey !== grant.participantKey) throw new HostedStateConflictError("conflict", "Event is not addressed to this namespace's participant.");
	return event;
}

function publishMessagingEvent(state: HostedRuntimeState, operation: HostedMessagingSend): HostedRuntimeState {
	const grant = state.messaging[operation.namespaceId];
	if (!grant) throw new HostedStateConflictError("conflict", "Messaging namespace is absent.");
	assertMessagingHolder(state, grant, operation.at);
	assertStateId(operation.operationId, "Messaging operation ID");
	const publishedId = Object.hasOwn(grant.operations, operation.operationId) ? grant.operations[operation.operationId] : undefined;
	if (publishedId !== undefined) {
		const published = state.events[publishedId];
		const repeated = published?.type === "mailbox.message" && messagingSendMatches(published, operation);
		if (!repeated) throw new HostedStateConflictError("conflict", "Messaging operation ID was reused with different input.");
		return state;
	}
	let read = state;
	if (operation.inReplyToEventId !== undefined) {
		const inbound = messagingInboxEvent(state, grant, operation.inReplyToEventId);
		if (inbound.source.id !== operation.recipientParticipantKey) throw new HostedStateConflictError("conflict", "Reply recipient is not the original sender.");
		read = reduceHostedState(state, { type: "messaging.read", namespaceId: grant.namespaceId, eventId: inbound.eventId, at: operation.at });
	}
	const sendId = messagingSendId(grant.namespaceId, operation.operationId);
	const next = reduceHostedState(read, { type: "mailbox.send", senderParticipantKey: grant.participantKey, expectedSenderGeneration: grant.holderGeneration, senderTargetKey: grant.targetKey, recipientParticipantKey: operation.recipientParticipantKey, sendId, body: operation.body, eventId: operation.eventId, at: operation.at });
	const event = next.events[operation.eventId];
	if (event?.type !== "mailbox.message" || event.sendId !== sendId) throw new HostedStateConflictError("conflict", "Messaging publication collided with an existing event.");
	const publishedEvent = operation.inReplyToEventId === undefined ? event : { ...event, inReplyToEventId: operation.inReplyToEventId };
	const current = next.messaging[operation.namespaceId];
	if (!current) throw new HostedStateConflictError("conflict", "Messaging namespace disappeared during publication.");
	return {
		...next,
		events: { ...next.events, [event.eventId]: publishedEvent },
		messaging: { ...next.messaging, [grant.namespaceId]: { ...current, operations: { ...current.operations, [operation.operationId]: event.eventId } } },
	};
}

function messagingSendMatches(published: HostedMailboxMessageEvent, operation: HostedMessagingSend): boolean {
	return published.recipientParticipantKey === operation.recipientParticipantKey
		&& published.body === operation.body
		&& published.inReplyToEventId === operation.inReplyToEventId;
}

function assertMessagingHolder(state: HostedRuntimeState, grant: HostedMessagingGrant, at: number): void {
	const holder = state.participants[grant.participantKey];
	const target = state.targets[grant.targetKey];
	if (grant.status !== "active" || !Number.isFinite(at) || at < grant.createdAt || at >= grant.expiresAt || holder?.state !== "held" || holder.generation !== grant.holderGeneration || holder.holderTargetKey !== grant.targetKey || !target || messagingConfigurationHash(target) !== grant.configurationHash) throw new HostedStateConflictError("conflict", "Messaging authority is expired, revoked, or no longer bound to this holder.");
}

export function messagingConfigurationHash(target: HostedTarget): string {
	const identity = target.kind === "pi"
		? [target.projectRoot, target.piSessionId, target.piSessionFile, target.worktreePath ?? null]
		: [target.projectRoot, target.agentName, target.driver, target.clientGeneration, target.worktreePath ?? null];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function validateMessagingGrant<Source>(value: Source, key: string): HostedMessagingGrant {
	const item = strictObject(value, "messaging namespace", ["namespaceId", "secretDigest", "participantKey", "holderGeneration", "targetKey", "clientGeneration", "terminalId", "configurationHash", "createdAt", "expiresAt", "status", "operations"]);
	const grant: HostedMessagingGrant = {
		namespaceId: text(item.namespaceId, "messaging namespace", 200), secretDigest: hash(item.secretDigest, "messaging secret digest"),
		participantKey: text(item.participantKey, "messaging participant", 200), holderGeneration: text(item.holderGeneration, "messaging holder", 200),
		targetKey: text(item.targetKey, "messaging target", 200), clientGeneration: text(item.clientGeneration, "messaging client", 200),
		terminalId: text(item.terminalId, "messaging terminal", 200), configurationHash: hash(item.configurationHash, "messaging configuration"),
		createdAt: nonNegativeNumber(item.createdAt, "messaging creation"), expiresAt: nonNegativeNumber(item.expiresAt, "messaging expiry"),
		status: enumValue(item.status, ["active", "revoked", "expired"], "invalid messaging state"),
		operations: mapValues(item.operations, "messaging operations", (value, operationId) => {
			if (!operationId.trim() || Buffer.byteLength(operationId) > MAX_ID_BYTES) throw new Error("messaging operation ID is invalid");
			return text(value, "messaging operation event", 200);
		}),
	};
	if (grant.namespaceId !== key || !/^msg_[0-9a-f-]{36}$/.test(key) || grant.expiresAt !== grant.createdAt + HOSTED_ACK_RETENTION_MS) throw new Error("messaging namespace identity or lifetime is invalid");
	return grant;
}

function bindAgentTarget(state: HostedRuntimeState, bind: HostedAgentBind): HostedRuntimeState {
	const target = bind.target;
	assertStateTime(bind.at, "Agent bind time");
	assertStateId(target.agentName, "Herdr agent name");
	assertParticipantName(bind.protocol, "protocol");
	assertParticipantName(bind.participantId, "participant ID");
	assertAgentBindCaller(state, bind);
	if (target.targetKey !== deriveAgentTargetKey(target.projectRoot, target.agentName)) {
		throw new HostedStateConflictError("conflict", "Agent target key does not match its Herdr agent name.");
	}
	if (target.participantKey !== deriveParticipantKey(target.projectRoot, bind.protocol, bind.participantId)) {
		throw new HostedStateConflictError("conflict", "Agent bind participant key does not match its durable identity.");
	}
	if (target.participantKey === bind.callerParticipantKey) {
		throw new HostedStateConflictError("conflict", "An agent target may not hold its caller's participant identity.");
	}
	if (target.profile === "read-only" && target.worktreePath !== undefined) {
		throw new HostedStateConflictError("conflict", "Read-only agent targets never carry a worktree.");
	}
	const participant = state.participants[target.participantKey];
	const alreadyBound = participant?.state === "held"
		&& participant.holderTargetKey === target.targetKey
		&& participant.generation === target.holderGeneration;
	if (!alreadyBound && !reservedForBind(participant, bind.expectedParticipantGeneration)) {
		throw new HostedStateConflictError("conflict", "Agent bind participant generation is unavailable.");
	}
	const next = reduceHostedState(state, { type: "target.ensure", target });
	if (alreadyBound) return next;
	return reduceHostedState(next, {
		type: "participant.acquire",
		participantKey: target.participantKey,
		projectRoot: target.projectRoot,
		protocol: bind.protocol,
		participantId: bind.participantId,
		targetKey: target.targetKey,
		generation: target.holderGeneration,
		at: bind.at,
	});
}

function assertAgentBindCaller(state: HostedRuntimeState, bind: HostedAgentBind): void {
	const caller = state.participants[bind.callerParticipantKey];
	const callerTarget = state.targets[bind.callerTargetKey];
	const held = caller?.state === "held"
		&& caller.generation === bind.callerGeneration
		&& caller.holderTargetKey === bind.callerTargetKey;
	if (!held) throw new HostedStateConflictError("conflict", "Agent bind caller authority changed.");
	if (callerTarget?.kind !== "pi" || caller.projectRoot !== bind.target.projectRoot) {
		throw new HostedStateConflictError("conflict", "Agent bind caller is outside its Pi project.");
	}
}

function reservedForBind(participant: HostedParticipant | undefined, expectedGeneration: string | undefined): boolean {
	if (!participant) return expectedGeneration === undefined;
	return participant.state === "vacant" && participant.generation === expectedGeneration;
}

function claimEvents(state: HostedRuntimeState, claim: HostedClaim): HostedRuntimeState {
	if (claim.eventIds.some(eventId => state.events[eventId]?.type === "mailbox.message")) throw new HostedStateConflictError("claim_conflict", "Ordinary mail cannot enter native claims.");
	const existing = state.claims[claim.claimId];
	if (existing) {
		if (!sameClaim(existing, claim)) throw new HostedStateConflictError("claim_conflict", "Claim ID does not match its durable receipt.");
		return state;
	}
	if (claim.status !== "active" || claim.eventIds.length < 1 || claim.eventIds.length > HOSTED_MAX_DELIVERY_BATCH) return state;
	if (Object.values(state.claims).some((candidate) => candidate.status === "active" && candidate.targetKey === claim.targetKey)) throw new HostedStateConflictError("claim_conflict", "Target already has an active delivery claim.");
	if (new Set(claim.eventIds).size !== claim.eventIds.length || claim.leaseUntil <= claim.createdAt) return state;
	const claimedEvents = claim.eventIds.map((eventId) => state.events[eventId]);
	if (!claimedEvents.every((event): event is HostedEvent => event !== undefined && hostedEventRoutesToTarget(state, event, claim.targetKey) && event.delivery.status === "pending")) return state;
	const events = { ...state.events };
	for (const event of claimedEvents) events[event.eventId] = { ...event, delivery: { status: "claimed", claimId: claim.claimId } };
	return { ...state, claims: { ...state.claims, [claim.claimId]: claim }, events };
}

function releaseClaim(state: HostedRuntimeState, targetKey: string, claimId: string, eventIds: string[], at: number): HostedRuntimeState {
	const claim = state.claims[claimId];
	if (!claim || claim.targetKey !== targetKey || !sameIds(claim.eventIds, eventIds) || claim.status !== "active") return state;
	if (claim.eventIds.some(eventId => state.events[eventId]?.type === "mailbox.message")) throw new HostedStateConflictError("claim_conflict", "Ordinary mail cannot enter native claims.");
	const events = { ...state.events };
	for (const eventId of claim.eventIds) {
		const event = events[eventId];
		if (event?.delivery.status === "claimed" && event.delivery.claimId === claimId) events[eventId] = { ...event, delivery: { status: "pending", latestClaimId: claimId } };
	}
	return {
		...state,
		claims: { ...state.claims, [claimId]: { ...claim, status: "released", settledAt: at } },
		events,
	};
}

function pruneAcknowledged(state: HostedRuntimeState, before: number): HostedRuntimeState {
	for (const grant of Object.values(state.messaging)) if (grant.expiresAt <= before) state = reduceHostedState(state, { type: "messaging.close", namespaceId: grant.namespaceId, status: "expired" });
	const retainedMail = new Set(Object.values(state.messaging).flatMap(grant => Object.values(grant.operations)));
	const removable = new Set(Object.values(state.events)
		.filter((event) => event.type === "mailbox.message"
			? event.createdAt < before && !retainedMail.has(event.eventId)
			: event.delivery.status === "acked" && event.delivery.ackedAt < before)
		.map((event) => event.eventId));
	let changed = true;
	while (changed) {
		changed = false;
		for (const claim of Object.values(state.claims)) {
			const count = claim.eventIds.filter((eventId) => removable.has(eventId)).length;
			if (count === 0 || (count === claim.eventIds.length && claim.status !== "active")) continue;
			for (const eventId of claim.eventIds) if (removable.delete(eventId)) changed = true;
		}
	}
	if (removable.size === 0) return state;
	const events = { ...state.events };
	const dedupe = { ...state.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	const claims = { ...state.claims };
	for (const claim of Object.values(state.claims)) if (claim.eventIds.every((eventId) => removable.has(eventId))) delete claims[claim.claimId];
	return { ...state, events, dedupe, claims };
}

function validMonitorEvent(monitor: HostedMonitor, event: HostedFilesystemCreatedEvent): boolean {
	return event.version === 1
		&& event.targetKey === monitor.targetKey
		&& event.source.kind === "monitor"
		&& event.source.id === monitor.monitorId
		&& event.source.generation === monitor.generation
		&& event.delivery.status === "pending";
}

function prepareRoot(root: string): void {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const info = lstatSync(root);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("runtime root is not a real directory");
		chmodSync(root, 0o700);
	} catch (error) {
		throw storageError(`Cannot prepare runtime directory: ${root}`, error);
	}
}

function readJson(path: string, maxBytes: number): PersistedStateValue | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error("state path is not a regular file");
		if (info.size > maxBytes) throw new Error(`state exceeds ${maxBytes} bytes`);
		return JSON.parse(readFileSync(fd, "utf8"));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw storageError(`Cannot read runtime state: ${path}`, error);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeAtomicJson(root: string, path: string, value: HostedRuntimeState | HostedRuntimeInstance, maxBytes: number): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content) > maxBytes) throw new HostedStateStorageError(`Runtime state exceeds ${maxBytes} bytes.`);
	const temporary = join(root, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	let renamed = false;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		renamed = true;
		chmodSync(path, 0o600);
		const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { fsyncSync(directory); } finally { closeSync(directory); }
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch {}
		throw storageError(`Cannot persist runtime state: ${path}`, error, renamed);
	}
}

function validateInstance(value: PersistedStateValue): HostedRuntimeInstance {
	try {
		const instance = strictObject(value, "runtime instance", ["version", "runtimeId"]);
		if (instance.version !== 1) throw new Error("unsupported runtime instance version");
		return { version: 1, runtimeId: text(instance.runtimeId, "runtime id", MAX_ID_BYTES) };
	} catch (error) {
		throw storageError("Runtime instance is malformed", error);
	}
}

function validateTarget(value: PersistedStateValue | undefined, key: string): HostedTarget {
	const candidate = strictObject(value, "target");
	if (candidate.kind === "pi") {
		const target = strictObject(value, "Pi target", ["kind", "targetKey", "projectRoot", "piSessionId", "piSessionFile", "worktreePath", "createdAt"]);
		const result: HostedTarget = { kind: "pi", targetKey: text(target.targetKey, "target key", MAX_ID_BYTES), projectRoot: text(target.projectRoot, "project root", MAX_PATH_BYTES), piSessionId: text(target.piSessionId, "Pi session id", MAX_ID_BYTES), piSessionFile: text(target.piSessionFile, "Pi session file", MAX_PATH_BYTES), createdAt: nonNegativeNumber(target.createdAt, "target creation time") };
		if (target.worktreePath !== undefined) result.worktreePath = text(target.worktreePath, "worktree path", MAX_PATH_BYTES);
		if (result.targetKey !== key) throw new Error("target key does not match map key");
		return result;
	}
	if (candidate.kind === "agent") {
		const fields = [
			"kind", "targetKey", "projectRoot", "agentName", "driver", "agentSession",
			"participantKey", "holderGeneration", "profile", "clientGeneration", "herdr", "worktreePath", "createdAt",
		];
		const target = strictObject(value, "agent target", fields);
		if (target.profile !== "read-only" && target.profile !== "workspace-write") throw new Error("invalid agent target profile");
		if (target.profile === "read-only" && target.worktreePath !== undefined) {
			throw new Error("read-only agent targets never carry a worktree");
		}
		const result: HostedAgentTarget = {
			kind: "agent",
			targetKey: text(target.targetKey, "target key", MAX_ID_BYTES),
			projectRoot: text(target.projectRoot, "project root", MAX_PATH_BYTES),
			agentName: agentName(target.agentName),
			driver: nativeDriver(target.driver),
			agentSession: validateAgentSession(target.agentSession),
			participantKey: text(target.participantKey, "participant key", MAX_ID_BYTES),
			holderGeneration: text(target.holderGeneration, "holder generation", MAX_ID_BYTES),
			profile: target.profile,
			clientGeneration: text(target.clientGeneration, "client generation", MAX_ID_BYTES),
			herdr: validateHerdrLocator(target.herdr),
			createdAt: nonNegativeNumber(target.createdAt, "target creation time"),
		};
		if (target.worktreePath !== undefined) result.worktreePath = text(target.worktreePath, "worktree path", MAX_PATH_BYTES);
		if (result.targetKey !== key || result.targetKey !== deriveAgentTargetKey(result.projectRoot, result.agentName)) {
			throw new Error("agent target key does not match its identity");
		}
		return result;
	}
	throw new Error("invalid target kind");
}

function validateHerdrLocator(value: PersistedStateValue | undefined): HostedHerdrLocator {
	const herdr = strictObject(value, "Herdr locator", ["paneId", "terminalId", "tabId", "workspaceId"]);
	return {
		paneId: text(herdr.paneId, "Herdr pane ID", MAX_ID_BYTES),
		terminalId: text(herdr.terminalId, "Herdr terminal ID", MAX_ID_BYTES),
		tabId: text(herdr.tabId, "Herdr tab ID", MAX_ID_BYTES),
		workspaceId: text(herdr.workspaceId, "Herdr workspace ID", MAX_ID_BYTES),
	};
}

function agentName(value: PersistedStateValue | undefined): string {
	const result = text(value, "Herdr agent name", 64);
	if (!AGENT_NAME.test(result)) throw new Error("Herdr agent name has invalid syntax");
	return result;
}

function nativeDriver(value: PersistedStateValue | undefined): "claude-code" | "codex" {
	if (value !== "claude-code" && value !== "codex") throw new Error("interactive agent driver is invalid");
	return value;
}

function validateAgentSession(value: PersistedStateValue | undefined): HostedAgentSessionIdentity {
	const session = strictObject(value, "interactive agent session", ["source", "agent", "kind", "value"]);
	if (session.kind !== "id" && session.kind !== "path") throw new Error("interactive agent session kind is invalid");
	return { source: text(session.source, "agent session source", MAX_ID_BYTES), agent: text(session.agent, "agent session kind", 64), kind: session.kind, value: text(session.value, "agent session value", MAX_PATH_BYTES) };
}

function validateMonitor(value: PersistedStateValue | undefined, key: string): HostedMonitor {
	const monitor = strictObject(value, "monitor", ["monitorId", "targetKey", "generation", "directory", "settleMs", "status", "sequence", "entries", "createdAt", "updatedAt"]);
	const status = monitor.status;
	if (status !== "watching" && status !== "degraded") throw new Error("invalid monitor status");
	const result: HostedMonitor = {
		monitorId: text(monitor.monitorId, "monitor id", MAX_ID_BYTES),
		targetKey: text(monitor.targetKey, "target key", MAX_ID_BYTES),
		generation: text(monitor.generation, "monitor generation", MAX_ID_BYTES),
		directory: text(monitor.directory, "monitor directory", MAX_PATH_BYTES),
		settleMs: integer(monitor.settleMs, "settle milliseconds"),
		status,
		sequence: integer(monitor.sequence, "monitor sequence"),
		entries: mapValues(monitor.entries, "monitor entries", validateObservation, HOSTED_MONITOR_MAX_ENTRIES),
		createdAt: nonNegativeNumber(monitor.createdAt, "monitor creation time"),
		updatedAt: nonNegativeNumber(monitor.updatedAt, "monitor update time"),
	};
	if (result.monitorId !== key) throw new Error("monitor id does not match map key");
	return result;
}

function validateObservation(value: PersistedStateValue | undefined, key: string): HostedFileObservation {
	const entry = strictObject(value, "file observation", ["relativePath", "size", "mtimeMs", "stableSince", "present", "emitted"]);
	const result: HostedFileObservation = {
		relativePath: text(entry.relativePath, "relative path", MAX_PATH_BYTES),
		size: integer(entry.size, "file size"),
		mtimeMs: nonNegativeNumber(entry.mtimeMs, "file modification time"),
		stableSince: nonNegativeNumber(entry.stableSince, "stable since"),
		present: boolean(entry.present, "present"),
		emitted: boolean(entry.emitted, "emitted"),
	};
	if (result.relativePath !== key) throw new Error("relative path does not match map key");
	return result;
}

function validateParticipant(value: PersistedStateValue | undefined, key: string): HostedParticipant {
	const participant = strictObject(value, "participant", ["participantKey", "projectRoot", "protocol", "participantId", "state", "generation", "holderTargetKey", "worktreePath", "outSeq", "transitions", "createdAt", "updatedAt"]);
	if (participant.state !== "held" && participant.state !== "vacant" && participant.state !== "ended") throw new Error("invalid participant state");
	const protocol = participantName(participant.protocol, "participant protocol");
	const participantId = participantName(participant.participantId, "participant ID");
	const projectRoot = text(participant.projectRoot, "participant project root", MAX_PATH_BYTES);
	const outSeqRecord = strictObject(participant.outSeq, "participant output sequences");
	if (Object.keys(outSeqRecord).length > MAX_STATE_RECORDS) throw new Error("participant output sequences exceed their limit");
	const outSeq = Object.fromEntries(Object.entries(outSeqRecord).map(([recipient, sequence]) => [text(recipient, "recipient participant key", MAX_ID_BYTES), integer(sequence, "participant output sequence")]));
	if (!Array.isArray(participant.transitions) || participant.transitions.length < 1 || participant.transitions.length > HOSTED_PARTICIPANT_TRANSITION_LIMIT) throw new Error("participant transition history is invalid");
	const transitions = participant.transitions.map(validateParticipantTransition);
	const result: HostedParticipant = {
		participantKey: text(participant.participantKey, "participant key", MAX_ID_BYTES),
		projectRoot,
		protocol,
		participantId,
		state: participant.state,
		generation: text(participant.generation, "participant generation", MAX_ID_BYTES),
		outSeq,
		transitions,
		createdAt: nonNegativeNumber(participant.createdAt, "participant creation time"),
		updatedAt: nonNegativeNumber(participant.updatedAt, "participant update time"),
	};
	if (participant.holderTargetKey !== undefined) result.holderTargetKey = text(participant.holderTargetKey, "participant holder target key", MAX_ID_BYTES);
	if (participant.worktreePath !== undefined) result.worktreePath = text(participant.worktreePath, "participant worktree path", MAX_PATH_BYTES);
	if (result.participantKey !== key || result.participantKey !== deriveParticipantKey(projectRoot, protocol, participantId)) throw new Error("participant key does not match its identity");
	const latest = result.transitions.at(-1)!;
	if ((result.state === "held") !== Boolean(result.holderTargetKey) || latest.generation !== result.generation || result.updatedAt < latest.at || latest.at < result.createdAt) throw new Error("participant state, holder, generation, or time is inconsistent");
	if (result.state === "held" ? latest.holderTargetKey !== result.holderTargetKey : latest.holderTargetKey !== undefined) throw new Error("participant transition holder is inconsistent");
	if (result.state === "vacant" ? latest.cause !== "stand_down" : result.state === "ended" ? latest.cause !== "release" : latest.cause === "stand_down" || latest.cause === "release") throw new Error("participant transition cause is inconsistent with state");
	for (let index = 0; index < result.transitions.length; index++) {
		const transition = result.transitions[index]!;
		if (index > 0) {
			const previous = result.transitions[index - 1]!;
			if (transition.at < previous.at || transition.previousGeneration !== previous.generation) throw new Error("participant transition order is invalid");
		}
	}
	if (new Set(result.transitions.map((transition) => transition.generation)).size !== result.transitions.length || Object.values(result.outSeq).some((sequence) => sequence < 1)) throw new Error("participant generations or output sequences are invalid");
	return result;
}

function validateParticipantTransition(value: PersistedStateValue | undefined): HostedParticipantTransition {
	const transition = strictObject(value, "participant transition", ["cause", "generation", "holderTargetKey", "previousGeneration", "previousHolderTargetKey", "at"]);
	if (transition.cause !== "acquire" && transition.cause !== "reacquire" && transition.cause !== "stand_down" && transition.cause !== "release" && transition.cause !== "takeover" && transition.cause !== "revive") throw new Error("invalid participant transition cause");
	const result: HostedParticipantTransition = {
		cause: transition.cause,
		generation: text(transition.generation, "transition generation", MAX_ID_BYTES),
		at: nonNegativeNumber(transition.at, "participant transition time"),
	};
	if (transition.holderTargetKey !== undefined) result.holderTargetKey = text(transition.holderTargetKey, "transition holder target key", MAX_ID_BYTES);
	if (transition.previousGeneration !== undefined) result.previousGeneration = text(transition.previousGeneration, "previous transition generation", MAX_ID_BYTES);
	if (transition.previousHolderTargetKey !== undefined) result.previousHolderTargetKey = text(transition.previousHolderTargetKey, "previous holder target key", MAX_ID_BYTES);
	return result;
}

function validateEvent(value: PersistedStateValue | undefined, key: string): HostedEvent {
	const candidate = strictObject(value, "hosted event");
	if (candidate.type === "filesystem.created") return validateFilesystemEvent(value, key);
	if (candidate.type === "mailbox.message") return validateMailboxEvent(value, key);
	throw new Error("invalid hosted event type");
}

function validateFilesystemEvent(value: PersistedStateValue | undefined, key: string): HostedFilesystemCreatedEvent {
	const event = strictObject(value, "hosted filesystem event", ["version", "eventId", "dedupeKey", "source", "targetKey", "type", "createdAt", "summary", "payload", "delivery"]);
	if (event.version !== 1 || event.type !== "filesystem.created") throw new Error("invalid hosted filesystem event version or type");
	const source = strictObject(event.source, "event source", ["kind", "id", "generation", "sequence"]);
	if (source.kind !== "monitor") throw new Error("invalid event source kind");
	const payload = strictObject(event.payload, "event payload", ["relativePath", "path", "fileType", "size", "mtimeMs"]);
	if (payload.fileType !== "regular") throw new Error("invalid event file type");
	const result: HostedFilesystemCreatedEvent = {
		version: 1,
		eventId: text(event.eventId, "event id", MAX_ID_BYTES),
		dedupeKey: text(event.dedupeKey, "event dedupe key", MAX_PATH_BYTES),
		source: {
			kind: "monitor",
			id: text(source.id, "source id", MAX_ID_BYTES),
			generation: text(source.generation, "source generation", MAX_ID_BYTES),
			sequence: integer(source.sequence, "source sequence"),
		},
		targetKey: text(event.targetKey, "target key", MAX_ID_BYTES),
		type: "filesystem.created",
		createdAt: nonNegativeNumber(event.createdAt, "event creation time"),
		summary: stringValue(event.summary, "event summary", MAX_SUMMARY_BYTES),
		payload: {
			relativePath: text(payload.relativePath, "payload relative path", MAX_PATH_BYTES),
			path: text(payload.path, "payload path", MAX_PATH_BYTES),
			fileType: "regular",
			size: integer(payload.size, "payload size"),
			mtimeMs: nonNegativeNumber(payload.mtimeMs, "payload modification time"),
		},
		delivery: validateDelivery(event.delivery),
	};
	if (result.eventId !== key) throw new Error("event id does not match map key");
	return result;
}

function validateMailboxEvent(value: PersistedStateValue | undefined, key: string): HostedMailboxMessageEvent {
	const event = strictObject(value, "hosted mailbox event", ["version", "eventId", "dedupeKey", "source", "recipientParticipantKey", "sendId", "body", "type", "createdAt", "summary", "delivery", "inReplyToEventId", "readAt"]);
	if (event.version !== 1 || event.type !== "mailbox.message") throw new Error("invalid hosted mailbox event version or type");
	const source = strictObject(event.source, "mailbox source", ["kind", "id", "generation", "sequence"]);
	if (source.kind !== "participant") throw new Error("invalid mailbox source kind");
	const result: HostedMailboxMessageEvent = {
		version: 1,
		eventId: text(event.eventId, "event id", MAX_ID_BYTES),
		dedupeKey: text(event.dedupeKey, "event dedupe key", MAX_PATH_BYTES),
		type: "mailbox.message",
		source: {
			kind: "participant",
			id: text(source.id, "source participant key", MAX_ID_BYTES),
			generation: text(source.generation, "source generation", MAX_ID_BYTES),
			sequence: integer(source.sequence, "source sequence"),
		},
		recipientParticipantKey: text(event.recipientParticipantKey, "recipient participant key", MAX_ID_BYTES),
		sendId: text(event.sendId, "mailbox send id", MAX_ID_BYTES),
		body: text(event.body, "mailbox body", HOSTED_MAILBOX_MAX_BODY_BYTES),
		createdAt: nonNegativeNumber(event.createdAt, "event creation time"),
		summary: stringValue(event.summary, "event summary", MAX_SUMMARY_BYTES),
		delivery: validateDelivery(event.delivery),
	};
	if (result.delivery.status !== "pending" || result.delivery.latestClaimId !== undefined) throw new Error("ordinary mail cannot carry native delivery evidence");
	if (event.inReplyToEventId !== undefined) result.inReplyToEventId = text(event.inReplyToEventId, "reply event", 200);
	if (event.readAt !== undefined) result.readAt = nonNegativeNumber(event.readAt, "message read time");
	if (result.eventId !== key || result.source.sequence < 1) throw new Error("mailbox event identity is inconsistent");
	if (result.readAt !== undefined && result.readAt < result.createdAt) throw new Error("mailbox event read time precedes publication");
	if (result.dedupeKey !== mailboxDedupeKey(result.source.id, result.sendId)) throw new Error("mailbox event dedupe key is invalid");
	return result;
}

function validateDelivery(value: PersistedStateValue | undefined): HostedEventDelivery {
	const candidate = strictObject(value, "event delivery");
	if (candidate.status === "pending") {
		const delivery = strictObject(value, "pending delivery", ["status", "latestClaimId"]);
		return delivery.latestClaimId === undefined
			? { status: "pending" }
			: { status: "pending", latestClaimId: text(delivery.latestClaimId, "latest claim id", MAX_ID_BYTES) };
	}
	if (candidate.status === "claimed") {
		const delivery = strictObject(value, "claimed delivery", ["status", "claimId"]);
		return { status: "claimed", claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES) };
	}
	if (candidate.status === "acked") {
		const delivery = strictObject(value, "acknowledged delivery", ["status", "claimId", "ackedAt"]);
		return { status: "acked", claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES), ackedAt: nonNegativeNumber(delivery.ackedAt, "acknowledgement time") };
	}
	throw new Error("invalid delivery status");
}

function validateClaim(value: PersistedStateValue | undefined, key: string): HostedClaim {
	const claim = strictObject(value, "claim", ["claimId", "targetKey", "registrationId", "clientGeneration", "eventIds", "createdAt", "leaseUntil", "status", "settledAt"]);
	if (claim.status !== "active" && claim.status !== "released" && claim.status !== "acked") throw new Error("invalid claim status");
	const eventIds = stringArray(claim.eventIds, "claim event ids", HOSTED_MAX_DELIVERY_BATCH);
	if (eventIds.length < 1 || new Set(eventIds).size !== eventIds.length) throw new Error("invalid claim event ids");
	const result: HostedClaim = {
		claimId: text(claim.claimId, "claim id", MAX_ID_BYTES),
		targetKey: text(claim.targetKey, "target key", MAX_ID_BYTES),
		registrationId: text(claim.registrationId, "registration id", MAX_ID_BYTES),
		clientGeneration: text(claim.clientGeneration, "client generation", MAX_ID_BYTES),
		eventIds,
		createdAt: nonNegativeNumber(claim.createdAt, "claim creation time"),
		leaseUntil: nonNegativeNumber(claim.leaseUntil, "claim lease"),
		status: claim.status,
	};
	if (claim.settledAt !== undefined) result.settledAt = nonNegativeNumber(claim.settledAt, "claim settled time");
	if (result.claimId !== key || result.leaseUntil <= result.createdAt) throw new Error("invalid claim identity or lease");
	if (result.status === "active" ? result.settledAt !== undefined : result.settledAt === undefined) throw new Error("invalid claim settlement");
	return result;
}

function validateWake(value: PersistedStateValue | undefined, key: string): HostedWake {
	const wake = strictObject(value, "wake", ["wakeId", "targetKey", "registrationId", "createdAt"]);
	const result: HostedWake = {
		wakeId: text(wake.wakeId, "wake id", MAX_ID_BYTES),
		targetKey: text(wake.targetKey, "target key", MAX_ID_BYTES),
		registrationId: text(wake.registrationId, "registration id", MAX_ID_BYTES),
		createdAt: nonNegativeNumber(wake.createdAt, "wake creation time"),
	};
	if (result.targetKey !== key) throw new Error("wake target does not match map key");
	return result;
}

function validateStateIntegrity(state: HostedRuntimeState): void {
	let messagingRecords = Object.keys(state.messaging).length;
	for (const grant of Object.values(state.messaging)) {
		const sender = state.participants[grant.participantKey];
		const target = state.targets[grant.targetKey];
		if (!sender || !target || sender.projectRoot !== target.projectRoot) throw new Error("messaging authority reference is invalid");
		for (const [operationId, eventId] of Object.entries(grant.operations)) {
			messagingRecords++;
			validateMessagingOperation(state, grant, operationId, eventId);
		}
	}
	if (messagingRecords > MAX_STATE_RECORDS) throw new Error("messaging authority and operation records exceed capacity");
	for (const target of Object.values(state.targets)) {
		if (target.kind !== "agent") continue;
		const participant = state.participants[target.participantKey];
		if (!participant || participant.projectRoot !== target.projectRoot) throw new Error("agent target participant reference is invalid");
	}
	for (const monitor of Object.values(state.monitors)) if (!state.targets[monitor.targetKey]) throw new Error("monitor target is missing");
	const heldTargets = new Set<string>();
	for (const participant of Object.values(state.participants)) {
		if (participant.state === "held") {
			const target = state.targets[participant.holderTargetKey!];
			if (!target || target.projectRoot !== participant.projectRoot || heldTargets.has(target.targetKey)) throw new Error("participant holder is missing, outside its project, or already holds another identity");
			heldTargets.add(target.targetKey);
		}
		for (const recipientKey of Object.keys(participant.outSeq)) {
			const recipient = state.participants[recipientKey];
			if (!recipient || recipient.projectRoot !== participant.projectRoot || recipient.protocol !== participant.protocol) throw new Error("participant output sequence recipient is invalid");
		}
	}
	for (const [dedupeKey, eventId] of Object.entries(state.dedupe)) {
		const event = state.events[eventId];
		if (!event || event.dedupeKey !== dedupeKey) throw new Error("event dedupe reference is invalid");
	}
	for (const event of Object.values(state.events)) {
		if (state.dedupe[event.dedupeKey] !== event.eventId) throw new Error("event dedupe reference is invalid");
		if (event.type === "filesystem.created") {
			if (!state.targets[event.targetKey]) throw new Error("event target is missing");
		} else {
			const sender = state.participants[event.source.id];
			const recipient = state.participants[event.recipientParticipantKey];
			if (!sender || !recipient || sender.projectRoot !== recipient.projectRoot || sender.protocol !== recipient.protocol) throw new Error("mailbox event participant reference is invalid");
		}
		const claimId = event.delivery.status === "pending" ? event.delivery.latestClaimId : event.delivery.claimId;
		const claim = claimId ? state.claims[claimId] : undefined;
		if (claimId && (!claim || !eventClaimTargetMatches(state, event, claim.targetKey) || !claim.eventIds.includes(event.eventId))) throw new Error("event claim reference is invalid");
	}
	for (const claim of Object.values(state.claims)) {
		if (!state.targets[claim.targetKey]) throw new Error("claim target is missing");
		for (const eventId of claim.eventIds) {
			const event = state.events[eventId];
			if (!event || !eventClaimTargetMatches(state, event, claim.targetKey)) throw new Error("claim event reference is invalid");
		}
	}
	for (const wake of Object.values(state.wakes)) if (!state.targets[wake.targetKey]) throw new Error("wake target is missing");
}

function mapValues<T>(value: PersistedStateValue | undefined, name: string, validate: (item: PersistedStateValue | undefined, key: string) => T, max = MAX_STATE_RECORDS): Record<string, T> {
	const record = strictObject(value, name);
	const entries = Object.entries(record);
	if (entries.length > max) throw new Error(`${name} exceeds ${max} entries`);
	return Object.fromEntries(entries.map(([key, item]) => [key, validate(item, key)]));
}

function mapStrings(value: PersistedStateValue | undefined, name: string): Record<string, string> {
	const record = strictObject(value, name);
	if (Object.keys(record).length > MAX_STATE_RECORDS) throw new Error(`${name} exceeds ${MAX_STATE_RECORDS} entries`);
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [text(key, `${name} key`, MAX_PATH_BYTES), text(item, `${name} value`, MAX_ID_BYTES)]));
}

function strictObject<Source>(value: Source, name: string, allowed?: readonly string[]): PersistedStateFields {
	if (value === null || value === undefined || Array.isArray(value) || Object(value) !== value) throw new Error(`${name} must be an object`);
	const record: PersistedStateFields = Object.fromEntries(Object.entries(Object(value)));
	if (allowed) for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`);
	return record;
}

function enumValue<const Value extends string>(value: PersistedStateValue | undefined, allowed: readonly Value[], message: string): Value {
	const parsed = allowed.find((candidate) => candidate === value);
	if (parsed === undefined) throw new Error(message);
	return parsed;
}

function stringArray(value: PersistedStateValue | undefined, name: string, max: number): string[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must contain at most ${max} values`);
	return value.map((item) => text(item, name, MAX_ID_BYTES));
}

function text(value: PersistedStateValue | undefined, name: string, maxBytes: number): string {
	const result = stringValue(value, name, maxBytes);
	if (!result.trim()) throw new Error(`${name} must not be empty`);
	return result;
}

function stringValue(value: PersistedStateValue | undefined, name: string, maxBytes: number): string {
	if (!isPersistedString(value) || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a string of at most ${maxBytes} bytes`);
	return value;
}

function hash(value: PersistedStateValue | undefined, name: string): string {
	const result = text(value, name, 64);
	if (!HASH.test(result)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
	return result;
}

function integer(value: PersistedStateValue | undefined, name: string): number {
	if (!isPersistedNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function nonNegativeNumber(value: PersistedStateValue | undefined, name: string): number {
	if (!isPersistedNumber(value) || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
	return value;
}

function boolean(value: PersistedStateValue | undefined, name: string): boolean {
	if (value !== true && value !== false) throw new Error(`${name} must be a boolean`);
	return value;
}

function isPersistedString(value: PersistedStateValue | undefined): value is string {
	return value === String(value);
}

function isPersistedNumber(value: PersistedStateValue | undefined): value is number {
	return value === Number(value);
}

function replaceParticipant(state: HostedRuntimeState, participant: HostedParticipant): HostedRuntimeState {
	return { ...state, participants: { ...state.participants, [participant.participantKey]: participant } };
}

function transitionParticipant(
	participant: HostedParticipant,
	transition: HostedParticipantTransition,
	state: HostedParticipant["state"],
	holderTargetKey?: string,
): HostedParticipant {
	const result: HostedParticipant = {
		...participant,
		state,
		generation: transition.generation,
		transitions: [...participant.transitions, transition].slice(-HOSTED_PARTICIPANT_TRANSITION_LIMIT),
		updatedAt: transition.at,
	};
	if (holderTargetKey) result.holderTargetKey = holderTargetKey;
	else if (participant.holderTargetKey) result.holderTargetKey = undefined;
	return result;
}

function withTargetWorktree(participant: HostedParticipant, target: HostedTarget): HostedParticipant {
	if (participant.worktreePath === target.worktreePath) return participant;
	if (!target.worktreePath) {
		const { worktreePath: _cleared, ...cleared } = participant;
		return cleared;
	}
	return { ...participant, worktreePath: target.worktreePath };
}

function latestHolderTargetKey(participant: HostedParticipant): string | undefined {
	for (let index = participant.transitions.length - 1; index >= 0; index--) {
		const transition = participant.transitions[index]!;
		if (transition.holderTargetKey) return transition.holderTargetKey;
		if (transition.previousHolderTargetKey) return transition.previousHolderTargetKey;
	}
	return undefined;
}

function assertTargetHasNoParticipant(state: HostedRuntimeState, targetKey: string, exceptParticipantKey: string): void {
	if (Object.values(state.participants).some((participant) => participant.participantKey !== exceptParticipantKey && participant.state === "held" && participant.holderTargetKey === targetKey)) {
		throw new HostedStateConflictError("conflict", "Target already holds another participant identity.");
	}
}

function hasActiveParticipantClaim(state: HostedRuntimeState, participantKey: string): boolean {
	return Object.values(state.claims).some((claim) => claim.status === "active" && claim.eventIds.some((eventId) => {
		const event = state.events[eventId];
		return event !== undefined && event.type !== "filesystem.created" && event.recipientParticipantKey === participantKey;
	}));
}

export function hostedEventRoutesToTarget(_state: HostedRuntimeState, event: HostedEvent, targetKey: string): boolean {
	if (event.type === "mailbox.message") return false;
	return event.targetKey === targetKey;
}

function deliveryBelongsToClaim(delivery: HostedEventDelivery, claimId: string): boolean {
	if (delivery.status !== "pending") return delivery.claimId === claimId;
	return delivery.latestClaimId === claimId;
}

function eventClaimTargetMatches(_state: HostedRuntimeState, event: HostedEvent, targetKey: string): boolean {
	if (event.type === "mailbox.message") return false;
	return event.targetKey === targetKey;
}

function mailboxDedupeKey(senderParticipantKey: string, sendId: string): string {
	return `mailbox:${senderParticipantKey}:${sendId}`;
}

function validateMessagingOperation(state: HostedRuntimeState, grant: HostedMessagingGrant, operationId: string, eventId: string): void {
	const event = state.events[eventId];
	const recipient = event?.type === "mailbox.message" ? state.participants[event.recipientParticipantKey] : undefined;
	const sender = state.participants[grant.participantKey];
	if (!event || event.type !== "mailbox.message" || !recipient || !sender) throw new Error("messaging operation event is missing");
	if (event.source.id !== grant.participantKey || event.source.generation !== grant.holderGeneration) throw new Error("messaging operation event has another publisher");
	if (event.sendId !== messagingSendId(grant.namespaceId, operationId)) throw new Error("messaging operation event identity is invalid");
	if (event.createdAt < grant.createdAt || event.createdAt >= grant.expiresAt) throw new Error("messaging operation event lifetime is invalid");
	if (recipient.projectRoot !== sender.projectRoot || recipient.protocol !== sender.protocol) throw new Error("messaging operation recipient scope is invalid");
}

function assertParticipantName(value: string, name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new HostedStateConflictError("conflict", `${name} has invalid syntax.`);
}

function assertStateId(value: string, name: string): void {
	if (!value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES) throw new HostedStateConflictError("conflict", `${name} is invalid.`);
}

function assertStateTime(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new HostedStateConflictError("conflict", `${name} is invalid.`);
}

function participantName(value: PersistedStateValue | undefined, name: string): string {
	const result = text(value, name, 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${name} has invalid syntax`);
	return result;
}

function sameTarget(left: HostedTarget, right: HostedTarget): boolean {
	if (left.kind !== right.kind || left.targetKey !== right.targetKey || left.projectRoot !== right.projectRoot) return false;
	if (left.kind === "pi" && right.kind === "pi") return left.piSessionId === right.piSessionId && left.piSessionFile === right.piSessionFile && left.worktreePath === right.worktreePath;
	if (left.kind === "agent" && right.kind === "agent") {
		return left.agentName === right.agentName
			&& left.driver === right.driver
			&& JSON.stringify(left.agentSession) === JSON.stringify(right.agentSession)
			&& left.participantKey === right.participantKey
			&& left.holderGeneration === right.holderGeneration
			&& left.profile === right.profile
			&& left.clientGeneration === right.clientGeneration
			&& left.worktreePath === right.worktreePath
			&& JSON.stringify(left.herdr) === JSON.stringify(right.herdr);
	}
	return false;
}

function sameMonitorIdentity(left: HostedMonitor, right: HostedMonitor): boolean {
	return left.monitorId === right.monitorId
		&& left.targetKey === right.targetKey
		&& left.generation === right.generation
		&& left.directory === right.directory
		&& left.settleMs === right.settleMs;
}

function sameClaim(left: HostedClaim, right: HostedClaim): boolean {
	return left.claimId === right.claimId && left.targetKey === right.targetKey && left.registrationId === right.registrationId && left.clientGeneration === right.clientGeneration && sameIds(left.eventIds, right.eventIds);
}

function sameWake(left: HostedWake, right: HostedWake): boolean {
	return left.wakeId === right.wakeId && left.targetKey === right.targetKey && left.registrationId === right.registrationId && left.createdAt === right.createdAt;
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const leftSorted = [...left].sort();
	const rightSorted = [...right].sort();
	return leftSorted.every((value, index) => value === rightSorted[index]);
}

function storageError(message: string, cause: unknown, uncertain = false): HostedStateStorageError {
	if (cause instanceof HostedStateStorageError && !uncertain) return cause;
	return new HostedStateStorageError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, uncertain);
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause;
}
