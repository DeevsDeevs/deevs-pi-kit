import {
	HOSTED_ACK_RETENTION_MS,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
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
	type HostedMonitor,
	type HostedParticipant,
	type HostedParticipantTransition,
	type HostedRuntimeInstance,
	type HostedRuntimeState,
	type HostedTarget,
	type HostedWake,
} from "../../hosted-types.ts";
import { hostedEventRoutesToTarget } from "./events.ts";
import { storageError } from "./errors.ts";
import { PARTICIPANT_NAME } from "./guards.ts";
import { deriveAgentTargetKey, deriveParticipantKey, mailboxDedupeKey, messagingSendId } from "./keys.ts";
import {
	MAX_ID_BYTES,
	MAX_PATH_BYTES,
	MAX_STATE_RECORDS,
	MAX_SUMMARY_BYTES,
	type PersistedStateValue,
	boolean,
	enumValue,
	hash,
	integer,
	mapStrings,
	mapValues,
	nonNegativeNumber,
	stringArray,
	stringValue,
	strictObject,
	text,
} from "./parse.ts";

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function emptyHostedRuntimeState(): HostedRuntimeState {
	return { version: 17, messaging: {}, targets: {}, monitors: {}, participants: {}, events: {}, dedupe: {}, claims: {}, wakes: {} };
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

export function validateInstance(value: PersistedStateValue): HostedRuntimeInstance {
	try {
		const instance = strictObject(value, "runtime instance", ["version", "runtimeId"]);
		if (instance.version !== 1) throw new Error("unsupported runtime instance version");
		return { version: 1, runtimeId: text(instance.runtimeId, "runtime id", MAX_ID_BYTES) };
	} catch (error) {
		throw storageError("Runtime instance is malformed", error);
	}
}

export function validateMessagingGrant<Source>(value: Source, key: string): HostedMessagingGrant {
	const fields = [
		"namespaceId", "secretDigest", "participantKey", "holderGeneration", "targetKey", "clientGeneration",
		"terminalId", "configurationHash", "createdAt", "expiresAt", "status", "operations",
	];
	const item = strictObject(value, "messaging namespace", fields);
	const grant: HostedMessagingGrant = {
		namespaceId: text(item.namespaceId, "messaging namespace", 200),
		secretDigest: hash(item.secretDigest, "messaging secret digest"),
		participantKey: text(item.participantKey, "messaging participant", 200),
		holderGeneration: text(item.holderGeneration, "messaging holder", 200),
		targetKey: text(item.targetKey, "messaging target", 200),
		clientGeneration: text(item.clientGeneration, "messaging client", 200),
		terminalId: text(item.terminalId, "messaging terminal", 200),
		configurationHash: hash(item.configurationHash, "messaging configuration"),
		createdAt: nonNegativeNumber(item.createdAt, "messaging creation"),
		expiresAt: nonNegativeNumber(item.expiresAt, "messaging expiry"),
		status: enumValue(item.status, ["active", "revoked", "expired"], "invalid messaging state"),
		operations: mapValues(item.operations, "messaging operations", validateMessagingOperationEvent),
	};
	if (grant.namespaceId !== key || !/^msg_[0-9a-f-]{36}$/.test(key) || grant.expiresAt !== grant.createdAt + HOSTED_ACK_RETENTION_MS) {
		throw new Error("messaging namespace identity or lifetime is invalid");
	}
	return grant;
}

function validateMessagingOperationEvent(value: PersistedStateValue | undefined, operationId: string): string {
	if (!operationId.trim() || Buffer.byteLength(operationId) > MAX_ID_BYTES) throw new Error("messaging operation ID is invalid");
	return text(value, "messaging operation event", 200);
}

function validateTarget(value: PersistedStateValue | undefined, key: string): HostedTarget {
	const candidate = strictObject(value, "target");
	if (candidate.kind === "pi") return validatePiTarget(value, key);
	if (candidate.kind === "agent") return validateAgentTarget(value, key);
	throw new Error("invalid target kind");
}

function validatePiTarget(value: PersistedStateValue | undefined, key: string): HostedTarget {
	const fields = ["kind", "targetKey", "projectRoot", "piSessionId", "piSessionFile", "worktreePath", "createdAt"];
	const target = strictObject(value, "Pi target", fields);
	const result: HostedTarget = {
		kind: "pi",
		targetKey: text(target.targetKey, "target key", MAX_ID_BYTES),
		projectRoot: text(target.projectRoot, "project root", MAX_PATH_BYTES),
		piSessionId: text(target.piSessionId, "Pi session id", MAX_ID_BYTES),
		piSessionFile: text(target.piSessionFile, "Pi session file", MAX_PATH_BYTES),
		createdAt: nonNegativeNumber(target.createdAt, "target creation time"),
	};
	if (target.worktreePath !== undefined) result.worktreePath = text(target.worktreePath, "worktree path", MAX_PATH_BYTES);
	if (result.targetKey !== key) throw new Error("target key does not match map key");
	return result;
}

function validateAgentTarget(value: PersistedStateValue | undefined, key: string): HostedAgentTarget {
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
	return {
		source: text(session.source, "agent session source", MAX_ID_BYTES),
		agent: text(session.agent, "agent session kind", 64),
		kind: session.kind,
		value: text(session.value, "agent session value", MAX_PATH_BYTES),
	};
}

function validateMonitor(value: PersistedStateValue | undefined, key: string): HostedMonitor {
	const fields = [
		"monitorId", "targetKey", "generation", "directory", "settleMs",
		"status", "sequence", "entries", "createdAt", "updatedAt",
	];
	const monitor = strictObject(value, "monitor", fields);
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
	const fields = [
		"participantKey", "projectRoot", "protocol", "participantId", "state", "generation",
		"holderTargetKey", "worktreePath", "outSeq", "transitions", "createdAt", "updatedAt",
	];
	const participant = strictObject(value, "participant", fields);
	const state = enumValue(participant.state, ["held", "vacant", "ended"], "invalid participant state");
	const protocol = participantName(participant.protocol, "participant protocol");
	const participantId = participantName(participant.participantId, "participant ID");
	const projectRoot = text(participant.projectRoot, "participant project root", MAX_PATH_BYTES);
	if (!Array.isArray(participant.transitions)
		|| participant.transitions.length < 1
		|| participant.transitions.length > HOSTED_PARTICIPANT_TRANSITION_LIMIT) throw new Error("participant transition history is invalid");
	const result: HostedParticipant = {
		participantKey: text(participant.participantKey, "participant key", MAX_ID_BYTES),
		projectRoot,
		protocol,
		participantId,
		state,
		generation: text(participant.generation, "participant generation", MAX_ID_BYTES),
		outSeq: validateOutputSequences(participant.outSeq),
		transitions: participant.transitions.map(validateParticipantTransition),
		createdAt: nonNegativeNumber(participant.createdAt, "participant creation time"),
		updatedAt: nonNegativeNumber(participant.updatedAt, "participant update time"),
	};
	if (participant.holderTargetKey !== undefined) {
		result.holderTargetKey = text(participant.holderTargetKey, "participant holder target key", MAX_ID_BYTES);
	}
	if (participant.worktreePath !== undefined) {
		result.worktreePath = text(participant.worktreePath, "participant worktree path", MAX_PATH_BYTES);
	}
	if (result.participantKey !== key || result.participantKey !== deriveParticipantKey(projectRoot, protocol, participantId)) {
		throw new Error("participant key does not match its identity");
	}
	assertParticipantConsistency(result);
	return result;
}

function validateOutputSequences(value: PersistedStateValue | undefined): Record<string, number> {
	const record = strictObject(value, "participant output sequences");
	if (Object.keys(record).length > MAX_STATE_RECORDS) throw new Error("participant output sequences exceed their limit");
	const entries = Object.entries(record).map(([recipient, sequence]) => [
		text(recipient, "recipient participant key", MAX_ID_BYTES),
		integer(sequence, "participant output sequence"),
	]);
	return Object.fromEntries(entries);
}

function assertParticipantConsistency(participant: HostedParticipant): void {
	const latest = participant.transitions.at(-1);
	if (!latest) throw new Error("participant transition history is invalid");
	if ((participant.state === "held") !== Boolean(participant.holderTargetKey)
		|| latest.generation !== participant.generation
		|| participant.updatedAt < latest.at
		|| latest.at < participant.createdAt) throw new Error("participant state, holder, generation, or time is inconsistent");
	if (participant.state === "held" ? latest.holderTargetKey !== participant.holderTargetKey : latest.holderTargetKey !== undefined) {
		throw new Error("participant transition holder is inconsistent");
	}
	assertTransitionCause(participant.state, latest.cause);
	let previous: HostedParticipantTransition | undefined;
	for (const transition of participant.transitions) {
		if (previous && (transition.at < previous.at || transition.previousGeneration !== previous.generation)) {
			throw new Error("participant transition order is invalid");
		}
		previous = transition;
	}
	const generations = new Set(participant.transitions.map((transition) => transition.generation));
	if (generations.size !== participant.transitions.length || Object.values(participant.outSeq).some((sequence) => sequence < 1)) {
		throw new Error("participant generations or output sequences are invalid");
	}
}

function assertTransitionCause(state: HostedParticipant["state"], cause: HostedParticipantTransition["cause"]): void {
	const consistent = state === "vacant"
		? cause === "stand_down"
		: state === "ended" ? cause === "release" : cause !== "stand_down" && cause !== "release";
	if (!consistent) throw new Error("participant transition cause is inconsistent with state");
}

function validateParticipantTransition(value: PersistedStateValue | undefined): HostedParticipantTransition {
	const fields = ["cause", "generation", "holderTargetKey", "previousGeneration", "previousHolderTargetKey", "at"];
	const transition = strictObject(value, "participant transition", fields);
	const causes = ["acquire", "reacquire", "stand_down", "release", "takeover", "revive"] as const;
	const result: HostedParticipantTransition = {
		cause: enumValue(transition.cause, causes, "invalid participant transition cause"),
		generation: text(transition.generation, "transition generation", MAX_ID_BYTES),
		at: nonNegativeNumber(transition.at, "participant transition time"),
	};
	if (transition.holderTargetKey !== undefined) {
		result.holderTargetKey = text(transition.holderTargetKey, "transition holder target key", MAX_ID_BYTES);
	}
	if (transition.previousGeneration !== undefined) {
		result.previousGeneration = text(transition.previousGeneration, "previous transition generation", MAX_ID_BYTES);
	}
	if (transition.previousHolderTargetKey !== undefined) {
		result.previousHolderTargetKey = text(transition.previousHolderTargetKey, "previous holder target key", MAX_ID_BYTES);
	}
	return result;
}

function validateEvent(value: PersistedStateValue | undefined, key: string): HostedEvent {
	const candidate = strictObject(value, "hosted event");
	if (candidate.type === "filesystem.created") return validateFilesystemEvent(value, key);
	if (candidate.type === "mailbox.message") return validateMailboxEvent(value, key);
	throw new Error("invalid hosted event type");
}

function validateFilesystemEvent(value: PersistedStateValue | undefined, key: string): HostedFilesystemCreatedEvent {
	const fields = ["version", "eventId", "dedupeKey", "source", "targetKey", "type", "createdAt", "summary", "payload", "delivery"];
	const event = strictObject(value, "hosted filesystem event", fields);
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
	const fields = [
		"version", "eventId", "dedupeKey", "source", "recipientParticipantKey", "sendId",
		"body", "type", "createdAt", "summary", "delivery", "inReplyToEventId", "readAt",
	];
	const event = strictObject(value, "hosted mailbox event", fields);
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
	if (result.delivery.status !== "pending" || result.delivery.latestClaimId !== undefined) {
		throw new Error("ordinary mail cannot carry native delivery evidence");
	}
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
		return {
			status: "acked",
			claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES),
			ackedAt: nonNegativeNumber(delivery.ackedAt, "acknowledgement time"),
		};
	}
	throw new Error("invalid delivery status");
}

function validateClaim(value: PersistedStateValue | undefined, key: string): HostedClaim {
	const fields = [
		"claimId", "targetKey", "registrationId", "clientGeneration",
		"eventIds", "createdAt", "leaseUntil", "status", "settledAt",
	];
	const claim = strictObject(value, "claim", fields);
	const status = enumValue(claim.status, ["active", "released", "acked"], "invalid claim status");
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
		status,
	};
	if (claim.settledAt !== undefined) result.settledAt = nonNegativeNumber(claim.settledAt, "claim settled time");
	if (result.claimId !== key || result.leaseUntil <= result.createdAt) throw new Error("invalid claim identity or lease");
	if (result.status === "active" ? result.settledAt !== undefined : result.settledAt === undefined) {
		throw new Error("invalid claim settlement");
	}
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
	validateMessagingIntegrity(state);
	validateTargetIntegrity(state);
	validateParticipantIntegrity(state);
	validateEventIntegrity(state);
	validateClaimIntegrity(state);
	for (const wake of Object.values(state.wakes)) if (!state.targets[wake.targetKey]) throw new Error("wake target is missing");
}

function validateMessagingIntegrity(state: HostedRuntimeState): void {
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
}

function validateMessagingOperation(state: HostedRuntimeState, grant: HostedMessagingGrant, operationId: string, eventId: string): void {
	const event = state.events[eventId];
	const recipient = event?.type === "mailbox.message" ? state.participants[event.recipientParticipantKey] : undefined;
	const sender = state.participants[grant.participantKey];
	if (!event || event.type !== "mailbox.message" || !recipient || !sender) throw new Error("messaging operation event is missing");
	if (event.source.id !== grant.participantKey || event.source.generation !== grant.holderGeneration) {
		throw new Error("messaging operation event has another publisher");
	}
	if (event.sendId !== messagingSendId(grant.namespaceId, operationId)) throw new Error("messaging operation event identity is invalid");
	if (event.createdAt < grant.createdAt || event.createdAt >= grant.expiresAt) {
		throw new Error("messaging operation event lifetime is invalid");
	}
	if (recipient.projectRoot !== sender.projectRoot || recipient.protocol !== sender.protocol) {
		throw new Error("messaging operation recipient scope is invalid");
	}
}

function validateTargetIntegrity(state: HostedRuntimeState): void {
	for (const target of Object.values(state.targets)) {
		if (target.kind !== "agent") continue;
		const participant = state.participants[target.participantKey];
		if (!participant || participant.projectRoot !== target.projectRoot) throw new Error("agent target participant reference is invalid");
	}
	for (const monitor of Object.values(state.monitors)) if (!state.targets[monitor.targetKey]) throw new Error("monitor target is missing");
}

function validateParticipantIntegrity(state: HostedRuntimeState): void {
	const heldTargets = new Set<string>();
	for (const participant of Object.values(state.participants)) {
		if (participant.state === "held") {
			const holderTargetKey = participant.holderTargetKey;
			const target = holderTargetKey === undefined ? undefined : state.targets[holderTargetKey];
			if (!target || target.projectRoot !== participant.projectRoot || heldTargets.has(target.targetKey)) {
				throw new Error("participant holder is missing, outside its project, or already holds another identity");
			}
			heldTargets.add(target.targetKey);
		}
		for (const recipientKey of Object.keys(participant.outSeq)) {
			const recipient = state.participants[recipientKey];
			if (!recipient || recipient.projectRoot !== participant.projectRoot || recipient.protocol !== participant.protocol) {
				throw new Error("participant output sequence recipient is invalid");
			}
		}
	}
}

function validateEventIntegrity(state: HostedRuntimeState): void {
	for (const [dedupeKey, eventId] of Object.entries(state.dedupe)) {
		const event = state.events[eventId];
		if (!event || event.dedupeKey !== dedupeKey) throw new Error("event dedupe reference is invalid");
	}
	for (const event of Object.values(state.events)) {
		if (state.dedupe[event.dedupeKey] !== event.eventId) throw new Error("event dedupe reference is invalid");
		validateEventParticipants(state, event);
		const claimId = event.delivery.status === "pending" ? event.delivery.latestClaimId : event.delivery.claimId;
		const claim = claimId ? state.claims[claimId] : undefined;
		if (claimId && (!claim || !hostedEventRoutesToTarget(event, claim.targetKey) || !claim.eventIds.includes(event.eventId))) {
			throw new Error("event claim reference is invalid");
		}
	}
}

function validateEventParticipants(state: HostedRuntimeState, event: HostedEvent): void {
	if (event.type === "filesystem.created") {
		if (!state.targets[event.targetKey]) throw new Error("event target is missing");
		return;
	}
	const sender = state.participants[event.source.id];
	const recipient = state.participants[event.recipientParticipantKey];
	if (!sender || !recipient || sender.projectRoot !== recipient.projectRoot || sender.protocol !== recipient.protocol) {
		throw new Error("mailbox event participant reference is invalid");
	}
}

function validateClaimIntegrity(state: HostedRuntimeState): void {
	for (const claim of Object.values(state.claims)) {
		if (!state.targets[claim.targetKey]) throw new Error("claim target is missing");
		for (const eventId of claim.eventIds) {
			const event = state.events[eventId];
			if (!event || !hostedEventRoutesToTarget(event, claim.targetKey)) throw new Error("claim event reference is invalid");
		}
	}
}

function participantName(value: PersistedStateValue | undefined, name: string): string {
	const result = text(value, name, 64);
	if (!PARTICIPANT_NAME.test(result)) throw new Error(`${name} has invalid syntax`);
	return result;
}
