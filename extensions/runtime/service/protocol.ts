import { HOSTED_MAILBOX_MAX_BODY_BYTES, HOSTED_MAX_DELIVERY_BATCH, HOSTED_MONITOR_MAX_ENTRIES, HOSTED_PROTOCOL_VERSION, type HostedMonitor } from "../hosted-types.ts";
import { DirectoryMonitorManager } from "./monitor.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "./registration.ts";
import { HostedWakeCoordinator, type HostedClaimResult } from "./wake.ts";

export const HOSTED_MAX_REQUEST_BYTES = 64 * 1024;

export type HostedErrorCode =
	| "invalid_request"
	| "unsupported_version"
	| "capability_unavailable"
	| "not_found"
	| "conflict"
	| "registration_stale"
	| "identity_mismatch"
	| "claim_conflict"
	| "host_unavailable"
	| "busy"
	| "storage_error"
	| "internal";

export interface HostedProtocolContext {
	runtimeId: string;
	epoch: string;
	agentWake: "herdr_exact_agent" | "none";
	degradedReason?: "host_unavailable";
	registrations?: RuntimeRegistrationManager;
	monitors?: DirectoryMonitorManager;
	wakes?: HostedWakeCoordinator;
	participants?: HostedParticipantCoordinator;
}

export type HostedResponse =
	| { v: 1; id: string | null; ok: true; result: unknown }
	| { v: 1; id: string | null; ok: false; error: { code: HostedErrorCode; message: string } };

export async function dispatchHostedLine(line: string, context: HostedProtocolContext): Promise<HostedResponse> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return failure(null, "invalid_request", "Request is not valid JSON.");
	}
	const candidateId = requestId(value);
	try {
		const envelope = strictObject(value, "request");
		const id = boundedText(envelope.id, "request id", 200);
		if (typeof envelope.v !== "number" || !Number.isSafeInteger(envelope.v)) throw new Error("request version must be an integer.");
		if (envelope.v !== HOSTED_PROTOCOL_VERSION) return failure(id, "unsupported_version", "Unsupported protocol envelope version.");
		const request = strictObject(value, "request", ["v", "id", "method", "params"]);
		const method = boundedText(request.method, "method", 100);
		const params = request.params;
		if (method === "hello") return hello(id, params, context);
		if (!HOSTED_METHODS.has(method)) return failure(id, "not_found", "Unknown runtime method.");
		const registrations = context.registrations;
		const monitors = context.monitors;
		const wakes = context.wakes;
		const participants = context.participants;
		if (!registrations || !monitors || !wakes) return failure(id, "capability_unavailable", "Hosted runtime methods are unavailable in this process.");

		if (method === "pi.register") {
			const registration = await registrations.register(registerParams(params));
			return success(id, registrationResult(registration));
		}
		if (method === "pi.heartbeat") {
			const auth = authParams(params);
			const registration = await registrations.heartbeat(auth.registrationId, auth.registrationKey);
			return success(id, registrationResult(registration));
		}
		if (method === "pi.unregister") {
			const auth = authParams(params);
			registrations.unregister(auth.registrationId, auth.registrationKey);
			return success(id, { unregistered: true });
		}
		if (method === "monitor.create") {
			const input = strictObject(params, "monitor.create params", ["registrationId", "registrationKey", "directory", "settleMs"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			const monitor = monitors.create(registration.targetKey, boundedText(input.directory, "monitor directory", 8 * 1024), integer(input.settleMs, "settleMs"));
			return success(id, monitorResult(monitor));
		}
		if (method === "monitor.get") {
			const auth = authParams(params);
			const registration = registrations.authorize(auth.registrationId, auth.registrationKey);
			const monitor = monitors.get(registration.targetKey);
			return success(id, { monitor: monitor ? monitorResult(monitor) : null });
		}
		if (method === "monitor.delete") {
			const input = strictObject(params, "monitor.delete params", ["registrationId", "registrationKey", "monitorId"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			monitors.delete(registration.targetKey, boundedText(input.monitorId, "monitor ID", 200));
			return success(id, { deleted: true });
		}
		if (method === "wake.accept") {
			const input = strictObject(params, "wake.accept params", ["registrationId", "registrationKey", "wakeId"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			return success(id, claimResult(wakes.accept(registration, boundedText(input.wakeId, "wake ID", 200))));
		}
		if (method === "inbox.claim") {
			const auth = authParams(params);
			return success(id, claimResult(wakes.claim(registrations.authorize(auth.registrationId, auth.registrationKey))));
		}
		if (method === "inbox.ack" || method === "inbox.release") {
			const input = claimReceiptParams(params, method);
			const registration = registrations.authorize(input.registrationId, input.registrationKey);
			if (method === "inbox.ack") wakes.ack(registration, input.claimId, input.eventIds);
			else wakes.release(registration, input.claimId, input.eventIds);
			return success(id, { settled: true });
		}
		if (method === "inbox.status") {
			const auth = authParams(params);
			return success(id, wakes.status(registrations.authorize(auth.registrationId, auth.registrationKey)));
		}
		if (method.startsWith("participant.") || method === "mailbox.send") {
			if (!participants) return failure(id, "capability_unavailable", "Collaborator mailbox methods are unavailable in this process.");
			if (method === "participant.acquire") {
				const input = strictObject(params, "participant.acquire params", ["registrationId", "registrationKey", "protocol", "participantId"]);
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.acquire(registration, participantName(input.protocol, "protocol"), participantName(input.participantId, "participant ID")));
			}
			if (method === "participant.list") {
				const auth = authParams(params);
				return success(id, { participants: participants.list(registrations.authorize(auth.registrationId, auth.registrationKey)) });
			}
			if (method === "participant.get" || method === "participant.stand_down" || method === "participant.release") {
				const input = participantAuthParams(params, method);
				const registration = registrations.authorize(input.registrationId, input.registrationKey);
				if (method === "participant.get") return success(id, participants.get(registration, input.participantKey));
				if (method === "participant.stand_down") return success(id, participants.standDown(registration, input.participantKey));
				return success(id, participants.release(registration, input.participantKey));
			}
			if (method === "participant.takeover") {
				const input = strictObject(params, "participant.takeover params", ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"]);
				if (input.confirmed !== true) throw new Error("participant takeover requires explicit confirmation");
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.takeover(registration, boundedText(input.participantKey, "participant key", 200), boundedText(input.expectedGeneration, "expected participant generation", 200)));
			}
			const input = strictObject(params, "mailbox.send params", ["registrationId", "registrationKey", "recipientParticipantKey", "sendId", "body"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			const event = participants.send(registration, boundedText(input.recipientParticipantKey, "recipient participant key", 200), boundedText(input.sendId, "send ID", 200), boundedText(input.body, "mailbox body", HOSTED_MAILBOX_MAX_BODY_BYTES));
			return success(id, { eventId: event.eventId, sequence: event.source.sequence });
		}
		return failure(id, "not_found", "Unknown runtime method.");
	} catch (error) {
		return failure(candidateId, errorCode(error), error instanceof Error ? error.message : "Invalid request.");
	}
}

export function encodeHostedResponse(response: HostedResponse): string {
	return `${JSON.stringify(response)}\n`;
}

export function invalidFrame(message: string): HostedResponse {
	return failure(null, "invalid_request", message);
}

function hello(id: string, value: unknown, context: HostedProtocolContext): HostedResponse {
	const params = strictObject(value, "hello params", ["minVersion", "maxVersion"]);
	const minVersion = integer(params.minVersion, "minimum version");
	const maxVersion = integer(params.maxVersion, "maximum version");
	if (minVersion > HOSTED_PROTOCOL_VERSION || maxVersion < HOSTED_PROTOCOL_VERSION || minVersion > maxVersion) {
		return failure(id, "unsupported_version", "Requested version range does not include protocol v1.");
	}
	return success(id, {
		version: 1,
		runtimeId: context.runtimeId,
		epoch: context.epoch,
		capabilities: {
			agentWake: context.agentWake,
			...(context.degradedReason ? { degradedReason: context.degradedReason } : {}),
			maxDeliveryBatch: HOSTED_MAX_DELIVERY_BATCH,
			monitor: { maxEntries: HOSTED_MONITOR_MAX_ENTRIES },
			...(context.participants ? { mailbox: { maxBodyBytes: HOSTED_MAILBOX_MAX_BODY_BYTES } } : {}),
		},
	});
}

function registerParams(value: unknown): RegisterPiInput {
	const params = strictObject(value, "pi.register params", ["projectRoot", "piSessionId", "piSessionFile", "clientGeneration", "admittedClaims", "herdr"]);
	const admitted = boundedArray(params.admittedClaims, "admittedClaims", 12).map((value, index) => {
		const receipt = strictObject(value, `admittedClaims[${index}]`, ["claimId", "eventIds"]);
		const eventIds = boundedArray(receipt.eventIds, `admittedClaims[${index}].eventIds`, HOSTED_MAX_DELIVERY_BATCH).map((eventId) => boundedText(eventId, "event ID", 200));
		if (new Set(eventIds).size !== eventIds.length) throw new Error("Admitted claim event IDs must be unique.");
		return { claimId: boundedText(receipt.claimId, "claim ID", 200), eventIds };
	});
	const host = strictObject(params.herdr, "pi.register herdr", ["paneId", "terminalId", "agentName"]);
	return {
		projectRoot: boundedText(params.projectRoot, "project root", 8 * 1024),
		piSessionId: boundedText(params.piSessionId, "Pi session ID", 200),
		piSessionFile: boundedText(params.piSessionFile, "Pi session file", 8 * 1024),
		clientGeneration: boundedText(params.clientGeneration, "client generation", 200),
		admittedClaims: admitted,
		herdr: {
			paneId: boundedText(host.paneId, "Herdr pane ID", 200),
			terminalId: boundedText(host.terminalId, "Herdr terminal ID", 200),
			...(host.agentName === undefined ? {} : { agentName: boundedText(host.agentName, "Herdr agent name", 200) }),
		},
	};
}

function authParams(value: unknown): { registrationId: string; registrationKey: string } {
	const params = strictObject(value, "registration params", ["registrationId", "registrationKey"]);
	return {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
	};
}

function participantAuthParams(value: unknown, name: string): { registrationId: string; registrationKey: string; participantKey: string } {
	const params = strictObject(value, `${name} params`, ["registrationId", "registrationKey", "participantKey"]);
	return {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
		participantKey: boundedText(params.participantKey, "participant key", 200),
	};
}

function participantName(value: unknown, name: string): string {
	const result = boundedText(value, name, 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${name} has invalid syntax.`);
	return result;
}

function claimReceiptParams(value: unknown, name: string): { registrationId: string; registrationKey: string; claimId: string; eventIds: string[] } {
	const params = strictObject(value, `${name} params`, ["registrationId", "registrationKey", "claimId", "eventIds"]);
	const eventIds = boundedArray(params.eventIds, "eventIds", HOSTED_MAX_DELIVERY_BATCH).map((eventId) => boundedText(eventId, "event ID", 200));
	if (eventIds.length === 0 || new Set(eventIds).size !== eventIds.length) throw new Error("Claim event IDs must be non-empty and unique.");
	return {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
		claimId: boundedText(params.claimId, "claim ID", 200),
		eventIds,
	};
}

function registrationResult(registration: Awaited<ReturnType<RuntimeRegistrationManager["register"]>>): Record<string, unknown> {
	return {
		targetKey: registration.targetKey,
		registrationId: registration.registrationId,
		registrationKey: registration.registrationKey,
		leaseUntil: registration.leaseUntil,
		hostStateChangeSeq: registration.host.stateChangeSeq,
		paneId: registration.host.paneId,
	};
}

function monitorResult(monitor: HostedMonitor): Record<string, unknown> {
	return { monitorId: monitor.monitorId, generation: monitor.generation, directory: monitor.directory, status: monitor.status, settleMs: monitor.settleMs };
}

function claimResult(result: HostedClaimResult): Record<string, unknown> {
	return {
		claimId: result.claim.claimId,
		leaseUntil: result.claim.leaseUntil,
		status: result.claim.status,
		events: result.events,
	};
}

function success(id: string, result: unknown): HostedResponse {
	return { v: 1, id, ok: true, result };
}

function failure(id: string | null, code: HostedErrorCode, message: string): HostedResponse {
	return { v: 1, id, ok: false, error: { code, message } };
}

function errorCode(error: unknown): HostedErrorCode {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && ERROR_CODES.has(error.code as HostedErrorCode)) return error.code as HostedErrorCode;
	return error instanceof Error ? "invalid_request" : "internal";
}

const HOSTED_METHODS = new Set(["pi.register", "pi.heartbeat", "pi.unregister", "monitor.create", "monitor.get", "monitor.delete", "wake.accept", "inbox.claim", "inbox.ack", "inbox.release", "inbox.status", "participant.acquire", "participant.get", "participant.list", "participant.stand_down", "participant.release", "participant.takeover", "mailbox.send"]);

const ERROR_CODES = new Set<HostedErrorCode>([
	"invalid_request", "unsupported_version", "capability_unavailable", "not_found", "conflict", "registration_stale", "identity_mismatch", "claim_conflict", "host_unavailable", "busy", "storage_error", "internal",
]);

function requestId(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const id = (value as Record<string, unknown>).id;
	return typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 200 ? id : null;
}

function strictObject(value: unknown, name: string, allowed?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	const record = value as Record<string, unknown>;
	if (allowed) for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}.`);
	return record;
}

function boundedArray(value: unknown, name: string, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} items.`);
	return value;
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a non-empty string of at most ${maxBytes} bytes.`);
	return value;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
	return value;
}
