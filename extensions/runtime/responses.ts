import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { HostedRuntimeClient } from "./client.ts";
import { HostedRuntimeClientError } from "./client.ts";
import { schemaError } from "./schemas/common.ts";
import { isJsonBoolean, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./schemas/json.ts";
import {
	HeartbeatResult,
	LiveRegistrationResult,
	ParticipantAcquireResult,
	ParticipantStatusResult,
	WorktreeListResult,
	WorktreeRemoveResult,
	type ClientParticipantStatus,
	type ClientWorktreeList,
	type ClientWorktreeRemoval,
	type LiveClientRegistration,
	type MailHint,
} from "./schemas/rpc.ts";

export type {
	ClientParticipantStatus,
	ClientWorktreeList,
	ClientWorktreeRemoval,
	LiveClientRegistration,
	MailHint,
} from "./schemas/rpc.ts";

export type RuntimeResponse = Awaited<ReturnType<HostedRuntimeClient["call"]>>;
export type RestoredSessionData = CustomEntry["data"];

interface RegistrationAuth {
	registrationId: string;
	registrationKey: string;
}

export interface HostedHeartbeat {
	registration: LiveClientRegistration;
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
	const heartbeat: HostedHeartbeat = { registration: result };
	if (result.mail) heartbeat.mail = result.mail;
	return heartbeat;
}

export function parseAcquireResult(value: RuntimeResponse): Static<typeof ParticipantAcquireResult> {
	return decode(ParticipantAcquireResult, value, "Participant acquire result");
}

export function parseParticipant(value: RuntimeResponse): ClientParticipantStatus {
	return decode(ParticipantStatusResult, value, "Runtime participant");
}

export function parseWorktreeList(value: RuntimeResponse): ClientWorktreeList {
	return decode(WorktreeListResult, value, "Worktree listing");
}

export function parseWorktreeRemoval(value: RuntimeResponse): ClientWorktreeRemoval {
	return decode(WorktreeRemoveResult, value, "Worktree removal");
}

export function findParticipant(
	participants: ClientParticipantStatus[],
	protocol: string,
	participantId: string,
): ClientParticipantStatus | undefined {
	return participants.find((participant) => participant.protocol === protocol && participant.participantId === participantId);
}

export function errorCode(cause: unknown): string {
	return cause instanceof HostedRuntimeClientError ? cause.code : "internal";
}

export function strictObject(value: RuntimeResponse, name: string): JsonObject {
	if (!isJsonObject(value)) throw new HostedRuntimeClientError("invalid_response", `${name} must be an object.`);
	return value;
}

export function asRecord(value: RestoredSessionData): JsonObject | undefined {
	// SAFETY: A persisted session entry is untrusted JSON; every field it carries is schema-checked before it is read.
	const json = value as JsonValue | undefined;
	return isJsonObject(json) ? json : undefined;
}

export function text(value: JsonValue | undefined): string {
	if (!isJsonString(value) || value.length === 0) throw new HostedRuntimeClientError("invalid_response", "Expected non-empty text.");
	return value;
}

export function booleanValue(value: JsonValue | undefined): boolean {
	if (!isJsonBoolean(value)) throw new HostedRuntimeClientError("invalid_response", "Expected a boolean.");
	return value;
}

