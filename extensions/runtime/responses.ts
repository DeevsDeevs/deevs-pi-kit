import type { CustomEntry, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import type { HostedRuntimeClient } from "./client.ts";
import { HostedRuntimeClientError } from "./client.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile } from "./hosted-types.ts";

export type RuntimeResponse = Awaited<ReturnType<HostedRuntimeClient["call"]>>;
export type RestoredSessionData = CustomEntry["data"];

export interface SerializedObject {
	[key: string]: SerializedValue | undefined;
}

export type SerializedValue = string | number | boolean | null | SerializedObject | SerializedValue[];

export interface LiveClientRegistration {
	targetKey: string;
	registrationId: string;
	registrationKey: string;
	leaseUntil: number;
	hostStateChangeSeq: number;
	paneId: string;
}

export interface RegistrationAuth {
	registrationId: string;
	registrationKey: string;
}

export interface ClientParticipantStatus {
	participantKey: string;
	protocol: string;
	participantId: string;
	state: "held" | "vacant" | "ended";
	generation: string;
	holderTargetKey?: string;
	holderLive: boolean;
	driver?: HostedCollaboratorDriver;
	profile?: HostedCollaboratorProfile;
	queued?: { pending: number; claimed: number };
	lastTransition: { cause: string };
}

interface ParticipantAcquireResult {
	participant: ClientParticipantStatus;
	revived: boolean;
	transitioned: boolean;
}

export interface MailHint {
	namespaceId: string;
	eventId: string;
}

export interface HostedHeartbeat {
	registration: LiveClientRegistration;
	inboxReady: boolean;
	mail?: MailHint;
}

export function auth(registration: LiveClientRegistration): RegistrationAuth {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

export function parseRegistration(value: RuntimeResponse): LiveClientRegistration {
	const result = strictObject(value, "Runtime registration");
	return {
		targetKey: text(result.targetKey),
		registrationId: text(result.registrationId),
		registrationKey: text(result.registrationKey),
		leaseUntil: integer(result.leaseUntil),
		hostStateChangeSeq: integer(result.hostStateChangeSeq),
		paneId: text(result.paneId),
	};
}

export function parseHeartbeat(value: RuntimeResponse): HostedHeartbeat {
	const result = strictObject(value, "Runtime heartbeat");
	if (result.inboxReady !== undefined && !isBooleanValue(result.inboxReady)) {
		throw new HostedRuntimeClientError("invalid_response", "Runtime heartbeat inbox readiness is invalid.");
	}
	const heartbeat: HostedHeartbeat = { registration: parseRegistration(result), inboxReady: result.inboxReady === true };
	const mail = parseMailHint(result.mail);
	if (mail) heartbeat.mail = mail;
	return heartbeat;
}

function parseMailHint(value: SerializedValue | undefined): MailHint | undefined {
	if (value === undefined) return undefined;
	const hint = strictObject(value, "Runtime mail hint");
	return { namespaceId: text(hint.namespaceId), eventId: text(hint.eventId) };
}

export function parseAcquireResult(value: RuntimeResponse): ParticipantAcquireResult {
	const result = strictObject(value, "Participant acquire result");
	return {
		participant: parseParticipant(result.participant),
		revived: booleanValue(result.revived),
		transitioned: booleanValue(result.transitioned),
	};
}

export function parseParticipant(value: RuntimeResponse): ClientParticipantStatus {
	const participant = strictObject(value, "Runtime participant");
	if (participant.state !== "held" && participant.state !== "vacant" && participant.state !== "ended") {
		throw new HostedRuntimeClientError("invalid_response", "Participant state is invalid.");
	}
	const queued = asRecord(participant.queued);
	const result: ClientParticipantStatus = {
		participantKey: text(participant.participantKey),
		protocol: text(participant.protocol),
		participantId: text(participant.participantId),
		state: participant.state,
		generation: text(participant.generation),
		holderLive: booleanValue(participant.holderLive),
		lastTransition: { cause: text(strictObject(participant.lastTransition, "Participant transition").cause) },
	};
	if (participant.holderTargetKey !== undefined) result.holderTargetKey = text(participant.holderTargetKey);
	if (participant.driver === "pi" || participant.driver === "claude-code" || participant.driver === "codex") {
		result.driver = participant.driver;
	}
	if (participant.profile === "read-only" || participant.profile === "workspace-write") result.profile = participant.profile;
	if (queued) result.queued = { pending: integer(queued.pending), claimed: integer(queued.claimed) };
	return result;
}

export function errorCode(cause: unknown): string {
	if (cause instanceof HostedRuntimeClientError) return cause.code;
	return cause instanceof Error && "code" in cause && isStringValue(cause.code) ? cause.code : "internal";
}

export function strictObject(value: RuntimeResponse, name: string): SerializedObject {
	if (!isSerializedObject(value)) throw new HostedRuntimeClientError("invalid_response", `${name} must be an object.`);
	return value;
}

export function parseSerializedResponse(value: RuntimeResponse, name: string): SerializedValue {
	if (value === null || isStringValue(value) || isBooleanValue(value)) return value;
	if (isNumberValue(value)) {
		if (!Number.isFinite(value)) throw new HostedRuntimeClientError("invalid_response", `${name} contains a non-finite number.`);
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => parseSerializedResponse(item, name));
	const source = strictObject(value, name);
	const result: SerializedObject = {};
	for (const [key, item] of Object.entries(source)) {
		if (item === undefined) throw new HostedRuntimeClientError("invalid_response", `${name} contains an unserializable field.`);
		result[key] = parseSerializedResponse(item, name);
	}
	return result;
}

export function asRecord(value: RestoredSessionData | MessageStartEvent["message"] | SerializedValue): SerializedObject | undefined {
	return isSerializedObject(value) ? value : undefined;
}

export function text(value: SerializedValue | undefined): string {
	if (!isStringValue(value) || value.length === 0) throw new HostedRuntimeClientError("invalid_response", "Expected non-empty text.");
	return value;
}

export function optionalText(value: SerializedValue | undefined): string | undefined {
	return isStringValue(value) ? value : undefined;
}

export function integer(value: SerializedValue | undefined): number {
	if (!isNumberValue(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new HostedRuntimeClientError("invalid_response", "Expected a non-negative integer.");
	}
	return value;
}

export function booleanValue(value: SerializedValue | undefined): boolean {
	if (!isBooleanValue(value)) throw new HostedRuntimeClientError("invalid_response", "Expected a boolean.");
	return value;
}

function isSerializedObject(value: RuntimeResponse): value is SerializedObject {
	if (value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

export function isStringValue(value: RuntimeResponse): value is string {
	try { return String.prototype.valueOf.call(value) === value; } catch { return false; }
}

function isNumberValue(value: RuntimeResponse): value is number {
	try { return Number.prototype.valueOf.call(value) === value; } catch { return false; }
}

function isBooleanValue(value: RuntimeResponse): value is boolean {
	try { return Boolean.prototype.valueOf.call(value) === value; } catch { return false; }
}
