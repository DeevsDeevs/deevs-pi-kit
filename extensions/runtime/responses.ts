import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { CustomEntry, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import type { HostedRuntimeClient } from "./client.ts";
import { HostedRuntimeClientError } from "./client.ts";
import { schemaError } from "./schemas/common.ts";
import {
	HeartbeatResult,
	LiveRegistrationResult,
	ParticipantAcquireResult,
	ParticipantStatusResult,
	type ClientParticipantStatus,
	type InboxEvent,
	type LiveClientRegistration,
	type MailHint,
} from "./schemas/rpc.ts";

export type { ClientParticipantStatus, InboxEvent, LiveClientRegistration, MailHint } from "./schemas/rpc.ts";

export type RuntimeResponse = Awaited<ReturnType<HostedRuntimeClient["call"]>>;
export type RestoredSessionData = CustomEntry["data"];

export interface SerializedObject {
	[key: string]: SerializedValue | undefined;
}

export type SerializedValue = string | number | boolean | null | SerializedObject | SerializedValue[];

interface RegistrationAuth {
	registrationId: string;
	registrationKey: string;
}

export interface HostedHeartbeat {
	registration: LiveClientRegistration;
	events: InboxEvent[];
	mail?: MailHint;
}

export function auth(registration: LiveClientRegistration): RegistrationAuth {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

/** One RPC result decode: the same schema the service answered with, checked before any field is read. */
function decode<Schema extends TSchema>(schema: Schema, value: RuntimeResponse, name: string): Static<Schema> {
	if (!Value.Check(schema, value)) throw new HostedRuntimeClientError("invalid_response", schemaError(schema, value, name).message);
	return value;
}

export function parseRegistration(value: RuntimeResponse): LiveClientRegistration {
	return decode(LiveRegistrationResult, value, "Runtime registration");
}

export function parseHeartbeat(value: RuntimeResponse): HostedHeartbeat {
	const result = decode(HeartbeatResult, value, "Runtime heartbeat");
	const heartbeat: HostedHeartbeat = { registration: result, events: result.events ?? [] };
	if (result.mail) heartbeat.mail = result.mail;
	return heartbeat;
}

export function parseAcquireResult(value: RuntimeResponse): Static<typeof ParticipantAcquireResult> {
	return decode(ParticipantAcquireResult, value, "Participant acquire result");
}

export function parseParticipant(value: RuntimeResponse): ClientParticipantStatus {
	return decode(ParticipantStatusResult, value, "Runtime participant");
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
