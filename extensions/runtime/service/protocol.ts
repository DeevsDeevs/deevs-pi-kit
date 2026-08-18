import { HOSTED_MAX_DELIVERY_BATCH, HOSTED_MONITOR_MAX_ENTRIES, HOSTED_PROTOCOL_VERSION } from "../hosted-types.ts";

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
}

export type HostedResponse =
	| { v: 1; id: string | null; ok: true; result: unknown }
	| { v: 1; id: string | null; ok: false; error: { code: HostedErrorCode; message: string } };

export function dispatchHostedLine(line: string, context: HostedProtocolContext): HostedResponse {
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
		if (method !== "hello") return failure(id, "not_found", "Unknown runtime method.");
		const params = strictObject(request.params, "hello params", ["minVersion", "maxVersion"]);
		const minVersion = integer(params.minVersion, "minimum version");
		const maxVersion = integer(params.maxVersion, "maximum version");
		if (minVersion > HOSTED_PROTOCOL_VERSION || maxVersion < HOSTED_PROTOCOL_VERSION || minVersion > maxVersion) {
			return failure(id, "unsupported_version", "Requested version range does not include protocol v1.");
		}
		return {
			v: 1,
			id,
			ok: true,
			result: {
				version: 1,
				runtimeId: context.runtimeId,
				epoch: context.epoch,
				capabilities: {
					agentWake: context.agentWake,
					...(context.degradedReason ? { degradedReason: context.degradedReason } : {}),
					maxDeliveryBatch: HOSTED_MAX_DELIVERY_BATCH,
					monitor: { maxEntries: HOSTED_MONITOR_MAX_ENTRIES },
				},
			},
		};
	} catch (error) {
		return failure(candidateId, "invalid_request", error instanceof Error ? error.message : "Invalid request.");
	}
}

export function encodeHostedResponse(response: HostedResponse): string {
	return `${JSON.stringify(response)}\n`;
}

export function invalidFrame(message: string): HostedResponse {
	return failure(null, "invalid_request", message);
}

function failure(id: string | null, code: HostedErrorCode, message: string): HostedResponse {
	return { v: 1, id, ok: false, error: { code, message } };
}

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

function boundedText(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a non-empty string of at most ${maxBytes} bytes.`);
	return value;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
	return value;
}
