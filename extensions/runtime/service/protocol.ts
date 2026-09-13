import {
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PROTOCOL_VERSION,
	type HostedMonitor,
} from "../hosted-types.ts";
import { RuntimeAgentBinder, type BindAgentInput, type BoundAgentResult } from "./bridge.ts";
import { DirectoryMonitorManager } from "./monitor.ts";
import { RuntimeMessaging, type MessagingInput } from "./messaging.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "./registration.ts";
import { HostedWakeCoordinator, type HostedClaimResult } from "./wake.ts";
import { RuntimeWorktrees, type EnsureWorktreeInput, type RemoveWorktreeInput } from "./worktree.ts";

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

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

interface JsonObject {
	[key: string]: JsonValue | undefined;
}

export interface HostedProtocolContext {
	runtimeId: string;
	epoch: string;
	agentWake: "herdr_exact_agent" | "none";
	degradedReason?: "host_unavailable";
	registrations?: RuntimeRegistrationManager;
	messaging?: RuntimeMessaging;
	monitors?: DirectoryMonitorManager;
	wakes?: HostedWakeCoordinator;
	participants?: HostedParticipantCoordinator;
	bridges?: RuntimeAgentBinder;
	worktrees?: RuntimeWorktrees;
}

export type HostedResponse =
	| { v: 1; id: string | null; ok: true; result: unknown }
	| { v: 1; id: string | null; ok: false; error: { code: HostedErrorCode; message: string } };

export async function dispatchHostedLine(line: string, context: HostedProtocolContext): Promise<HostedResponse> {
	let value: JsonValue;
	try {
		value = JSON.parse(line);
	} catch {
		return failure(null, "invalid_request", "Request is not valid JSON.");
	}
	const candidateId = requestId(value);
	try {
		const envelope = strictObject(value, "request");
		const id = boundedText(envelope.id, "request id", 200);
		const version = envelopeVersion(envelope.v);
		if (version !== HOSTED_PROTOCOL_VERSION) return failure(id, "unsupported_version", "Unsupported protocol envelope version.");
		const request = strictObject(value, "request", ["v", "id", "method", "params"]);
		const method = boundedText(request.method, "method", 100);
		const params = request.params;
		if (method === "hello") return hello(id, params, context);
		if (!HOSTED_METHODS.has(method)) return failure(id, "not_found", "Unknown runtime method.");
		const registrations = context.registrations;
		const monitors = context.monitors;
		const wakes = context.wakes;
		const participants = context.participants;
		const bridges = context.bridges;
		const worktrees = context.worktrees;
		if (!registrations || !monitors || !wakes) return failure(id, "capability_unavailable", "Hosted runtime methods are unavailable in this process.");

		if (method === "messaging.issue") {
			if (!context.messaging) return failure(id, "capability_unavailable", "Messaging authority is unavailable.");
			const input = strictObject(params, "messaging.issue params", ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"]);
			if (input.confirmed !== true) throw new Error("Messaging issuance requires explicit controller confirmation.");
			const caller = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			return success(id, await context.messaging.issue(caller, boundedText(input.participantKey, "participant key", 200), boundedText(input.expectedGeneration, "holder generation", 200)));
		}
		if (MESSAGING_CALL_FIELDS.has(method)) {
			if (!context.messaging) return failure(id, "capability_unavailable", "Messaging authority is unavailable.");
			const input = strictObject(params, `${method} params`, ["namespaceId", "secret", ...MESSAGING_CALL_FIELDS.get(method) ?? []]);
			const result = success(id, await context.messaging.call(boundedText(input.namespaceId, "namespace ID", 200), boundedText(input.secret, "messaging secret", 200), messagingCallInput(input, method)));
			if (Buffer.byteLength(encodeHostedResponse(result)) > 128 * 1024) return failure(id, "conflict", "Messaging response exceeds its byte limit.");
			return result;
		}

		if (method.startsWith("worktree.")) {
			if (!worktrees) return failure(id, "capability_unavailable", "Runtime worktree authority is unavailable in this process.");
			const parsed = worktreeParams(params, method);
			const caller = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			if (parsed.method === "worktree.list") return success(id, { worktrees: await worktrees.list(caller) });
			if (parsed.method === "worktree.ensure") return success(id, await worktrees.ensure(caller, parsed.input));
			return success(id, await worktrees.remove(caller, parsed.input));
		}
		if (method === "bridge.bind") {
			if (!bridges) return failure(id, "capability_unavailable", "Runtime Herdr agent binding is unavailable in this process.");
			const parsed = bindAgentParams(params);
			const caller = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			return success(id, boundAgentResult(await bridges.bind(caller, parsed.input)));
		}
		if (method === "bridge.heartbeat") {
			const auth = authParams(params);
			const registration = await registrations.heartbeat(auth.registrationId, auth.registrationKey);
			return success(id, { ...registrationResult(registration), inboxReady: wakes.status(registration).pending > 0 });
		}
		if (method === "bridge.unregister") {
			const auth = authParams(params);
			registrations.unregister(auth.registrationId, auth.registrationKey);
			return success(id, { unregistered: true });
		}
		if (method === "pi.register") {
			const registration = await registrations.register(registerParams(params));
			return success(id, registrationResult(registration));
		}
		if (method === "pi.heartbeat") {
			const auth = authParams(params);
			const registration = await registrations.heartbeat(auth.registrationId, auth.registrationKey);
			const mail = context.messaging?.unread(registration);
			const heartbeat: JsonObject = { ...registrationResult(registration), inboxReady: wakes.status(registration).pending > 0 };
			if (mail) heartbeat.mail = { namespaceId: mail.namespaceId, eventId: mail.eventId };
			return success(id, heartbeat);
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
			const input = strictObject(params, "inbox.claim params", ["registrationId", "registrationKey", "maxEvents"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			const maxEvents = input.maxEvents === undefined ? HOSTED_MAX_DELIVERY_BATCH : integer(input.maxEvents, "claim batch limit");
			if (maxEvents < 1 || maxEvents > HOSTED_MAX_DELIVERY_BATCH) throw new Error(`claim batch limit must be between 1 and ${HOSTED_MAX_DELIVERY_BATCH}`);
			return success(id, claimResult(wakes.claim(registration, maxEvents)));
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
		if (method === "mailbox.status") {
			if (!participants) return failure(id, "capability_unavailable", "Collaborator mailbox methods are unavailable in this process.");
			const input = strictObject(params, "mailbox.status params", ["registrationId", "registrationKey", "senderParticipantKey", "expectedSenderGeneration", "eventIds"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			const eventIds = boundedArray(input.eventIds, "event IDs", 12).map((eventId) => boundedText(eventId, "event ID", 200));
			if (eventIds.length < 1 || new Set(eventIds).size !== eventIds.length) throw new Error("message status event IDs must contain 1 to 12 unique items");
			return success(id, { messages: eventIds.map((eventId) => participants.messageStatus(registration, boundedText(input.senderParticipantKey, "sender participant key", 200), boundedText(input.expectedSenderGeneration, "sender generation", 200), eventId)) });
		}
		if (method.startsWith("participant.") || method === "mailbox.send") {
			if (!participants) return failure(id, "capability_unavailable", "Collaborator mailbox methods are unavailable in this process.");
			if (method === "participant.acquire") {
				const input = strictObject(params, "participant.acquire params", ["registrationId", "registrationKey", "protocol", "participantId", "revive"]);
				const revive = input.revive === undefined ? false : booleanValue(input.revive, "participant revive must be a boolean");
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.acquire(registration, participantName(input.protocol, "protocol"), participantName(input.participantId, "participant ID"), revive));
			}
			if (method === "participant.list") {
				const auth = authParams(params);
				return success(id, { participants: participants.list(registrations.authorize(auth.registrationId, auth.registrationKey)) });
			}
			if (method === "participant.stand_down") {
				const input = strictObject(params, "participant.stand_down params", ["registrationId", "registrationKey", "participantKey", "expectedGeneration"]);
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.standDown(registration, boundedText(input.participantKey, "participant key", 200), input.expectedGeneration === undefined ? undefined : boundedText(input.expectedGeneration, "expected participant generation", 200)));
			}
			if (method === "participant.stand_down_confirmed") {
				const input = strictObject(params, "participant.stand_down_confirmed params", ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"]);
				if (input.confirmed !== true) throw new Error("participant confirmed stand-down requires explicit confirmation");
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.standDownConfirmed(registration, boundedText(input.participantKey, "participant key", 200), boundedText(input.expectedGeneration, "expected participant generation", 200)));
			}
			if (method === "participant.stop_confirmed") {
				const input = strictObject(params, "participant.stop_confirmed params", ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"]);
				if (input.confirmed !== true) throw new Error("participant stop requires explicit confirmation");
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, await participants.stopConfirmed(registration, boundedText(input.participantKey, "participant key", 200), boundedText(input.expectedGeneration, "expected participant generation", 200)));
			}
			if (method === "participant.get" || method === "participant.release") {
				const input = participantAuthParams(params, method);
				const registration = registrations.authorize(input.registrationId, input.registrationKey);
				if (method === "participant.get") return success(id, participants.get(registration, input.participantKey));
				return success(id, participants.release(registration, input.participantKey));
			}
			if (method === "participant.takeover") {
				const input = strictObject(params, "participant.takeover params", ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"]);
				if (input.confirmed !== true) throw new Error("participant takeover requires explicit confirmation");
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.takeover(registration, boundedText(input.participantKey, "participant key", 200), boundedText(input.expectedGeneration, "expected participant generation", 200)));
			}
			const input = strictObject(params, "mailbox.send params", ["registrationId", "registrationKey", "senderParticipantKey", "expectedSenderGeneration", "recipientParticipantKey", "sendId", "body"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			const event = participants.send(registration, boundedText(input.senderParticipantKey, "sender participant key", 200), boundedText(input.expectedSenderGeneration, "expected sender generation", 200), boundedText(input.recipientParticipantKey, "recipient participant key", 200), boundedText(input.sendId, "send ID", 200), boundedText(input.body, "mailbox body", HOSTED_MAILBOX_MAX_BODY_BYTES));
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

function hello(id: string, value: JsonValue | undefined, context: HostedProtocolContext): HostedResponse {
	const params = strictObject(value, "hello params", ["minVersion", "maxVersion"]);
	const minVersion = integer(params.minVersion, "minimum version");
	const maxVersion = integer(params.maxVersion, "maximum version");
	if (minVersion > HOSTED_PROTOCOL_VERSION || maxVersion < HOSTED_PROTOCOL_VERSION || minVersion > maxVersion) {
		return failure(id, "unsupported_version", "Requested version range does not include protocol v1.");
	}
	const capabilities = {
		agentWake: context.agentWake,
		maxDeliveryBatch: HOSTED_MAX_DELIVERY_BATCH,
		targets: ["pi", "claude-code", "codex"],
		monitor: { maxEntries: HOSTED_MONITOR_MAX_ENTRIES },
	};
	if (context.degradedReason) Object.assign(capabilities, { degradedReason: context.degradedReason });
	if (context.participants) Object.assign(capabilities, { mailbox: { maxBodyBytes: HOSTED_MAILBOX_MAX_BODY_BYTES } });
	if (context.bridges) Object.assign(capabilities, { interactiveAgent: { bind: "herdr_agent_name" } });
	if (context.worktrees) Object.assign(capabilities, { worktree: { isolatedWrite: true } });
	return success(id, { version: 1, runtimeId: context.runtimeId, epoch: context.epoch, capabilities });
}

function registerParams(value: JsonValue | undefined): RegisterPiInput {
	const params = strictObject(value, "pi.register params", ["projectRoot", "piSessionId", "piSessionFile", "clientGeneration", "admittedClaims", "herdr"]);
	const admitted = boundedArray(params.admittedClaims, "admittedClaims", 12).map((value, index) => {
		const receipt = strictObject(value, `admittedClaims[${index}]`, ["claimId", "eventIds"]);
		const eventIds = boundedArray(receipt.eventIds, `admittedClaims[${index}].eventIds`, HOSTED_MAX_DELIVERY_BATCH).map((eventId) => boundedText(eventId, "event ID", 200));
		if (new Set(eventIds).size !== eventIds.length) throw new Error("Admitted claim event IDs must be unique.");
		return { claimId: boundedText(receipt.claimId, "claim ID", 200), eventIds };
	});
	const host = strictObject(params.herdr, "pi.register herdr", ["paneId", "terminalId", "agentName"]);
	const herdr: RegisterPiInput["herdr"] = { paneId: boundedText(host.paneId, "Herdr pane ID", 200), terminalId: boundedText(host.terminalId, "Herdr terminal ID", 200) };
	if (host.agentName !== undefined) herdr.agentName = boundedText(host.agentName, "Herdr agent name", 200);
	return {
		projectRoot: boundedText(params.projectRoot, "project root", 8 * 1024),
		piSessionId: boundedText(params.piSessionId, "Pi session ID", 200),
		piSessionFile: boundedText(params.piSessionFile, "Pi session file", 8 * 1024),
		clientGeneration: boundedText(params.clientGeneration, "client generation", 200),
		admittedClaims: admitted,
		herdr,
	};
}

interface RegistrationAuth {
	registrationId: string;
	registrationKey: string;
}

interface ParticipantAuth extends RegistrationAuth {
	participantKey: string;
}

interface ClaimReceiptParams extends RegistrationAuth {
	claimId: string;
	eventIds: string[];
}

interface AuthorizedParams<T> extends RegistrationAuth {
	input: T;
}

type WorktreeParams =
	| { method: "worktree.list" }
	| ({ method: "worktree.ensure" } & AuthorizedParams<EnsureWorktreeInput>)
	| ({ method: "worktree.remove" } & AuthorizedParams<RemoveWorktreeInput>);

function worktreeParams(value: JsonValue | undefined, method: string): WorktreeParams & RegistrationAuth {
	if (method === "worktree.list") {
		const params = strictObject(value, "worktree.list params", ["registrationId", "registrationKey"]);
		return { method, registrationId: boundedText(params.registrationId, "registration ID", 200), registrationKey: boundedText(params.registrationKey, "registration key", 200) };
	}
	if (method !== "worktree.ensure" && method !== "worktree.remove") throw new Error("unsupported worktree method");
	const allowed = ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "protocol", "participantId", ...(method === "worktree.remove" ? ["discardConfirmed"] : [])];
	const params = strictObject(value, `${method} params`, allowed);
	const input: EnsureWorktreeInput = {
		callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200),
		expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200),
		protocol: participantName(params.protocol, "protocol"),
		participantId: participantName(params.participantId, "participant ID"),
	};
	const registrationId = boundedText(params.registrationId, "registration ID", 200);
	const registrationKey = boundedText(params.registrationKey, "registration key", 200);
	if (method === "worktree.ensure") return { method, registrationId, registrationKey, input };
	if (params.discardConfirmed !== true && params.discardConfirmed !== false) throw new Error("worktree discard confirmation must be boolean");
	return { method, registrationId, registrationKey, input: { ...input, discardConfirmed: params.discardConfirmed } };
}

function bindAgentParams(value: JsonValue | undefined): AuthorizedParams<BindAgentInput> {
	const allowed = [
		"registrationId", "registrationKey", "agentName", "driver", "profile", "clientGeneration",
		"protocol", "participantId", "callerParticipantKey", "expectedCallerGeneration", "expectedParticipantGeneration",
	];
	const params = strictObject(value, "bridge.bind params", allowed);
	if (params.profile !== "read-only" && params.profile !== "workspace-write") {
		throw new Error("collaborator profile must be read-only or workspace-write");
	}
	const input: BindAgentInput = {
		agentName: boundedText(params.agentName, "Herdr agent name", 64),
		driver: nativeDriver(params.driver),
		profile: params.profile,
		clientGeneration: boundedText(params.clientGeneration, "client generation", 200),
		protocol: participantName(params.protocol, "protocol"),
		participantId: participantName(params.participantId, "participant ID"),
		callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200),
		expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200),
	};
	if (params.expectedParticipantGeneration !== undefined) {
		input.expectedParticipantGeneration = boundedText(params.expectedParticipantGeneration, "expected participant generation", 200);
	}
	return { registrationId: boundedText(params.registrationId, "registration ID", 200), registrationKey: boundedText(params.registrationKey, "registration key", 200), input };
}

function nativeDriver(value: JsonValue | undefined): "claude-code" | "codex" {
	if (value !== "claude-code" && value !== "codex") throw new Error("native collaborator driver must be claude-code or codex");
	return value;
}

function authParams(value: JsonValue | undefined): RegistrationAuth {
	const params = strictObject(value, "registration params", ["registrationId", "registrationKey"]);
	return {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
	};
}

function participantAuthParams(value: JsonValue | undefined, name: string): ParticipantAuth {
	const params = strictObject(value, `${name} params`, ["registrationId", "registrationKey", "participantKey"]);
	return {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
		participantKey: boundedText(params.participantKey, "participant key", 200),
	};
}

function participantName(value: JsonValue | undefined, name: string): string {
	const result = boundedText(value, name, 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${name} has invalid syntax.`);
	return result;
}

function claimReceiptParams(value: JsonValue | undefined, name: string): ClaimReceiptParams {
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

function registrationResult(registration: Awaited<ReturnType<RuntimeRegistrationManager["register"]>>) {
	return {
		targetKey: registration.targetKey,
		registrationId: registration.registrationId,
		registrationKey: registration.registrationKey,
		leaseUntil: registration.leaseUntil,
		hostStateChangeSeq: registration.host.stateChangeSeq,
		paneId: registration.host.paneId,
	};
}

function boundAgentResult(result: BoundAgentResult) {
	return {
		...registrationResult(result.registration),
		participantKey: result.participantKey,
		holderGeneration: result.holderGeneration,
		driver: result.driver,
		profile: result.profile,
		agentSession: result.agentSession,
		projectRoot: result.projectRoot,
		cwd: result.cwd,
	};
}

function monitorResult(monitor: HostedMonitor) {
	return { monitorId: monitor.monitorId, generation: monitor.generation, directory: monitor.directory, status: monitor.status, settleMs: monitor.settleMs };
}

function claimResult(result: HostedClaimResult) {
	return {
		claimId: result.claim.claimId,
		leaseUntil: result.claim.leaseUntil,
		status: result.claim.status,
		events: result.events,
	};
}

function success<Result>(id: string, result: Result): HostedResponse {
	return { v: 1, id, ok: true, result };
}

function failure(id: string | null, code: HostedErrorCode, message: string): HostedResponse {
	return { v: 1, id, ok: false, error: { code, message } };
}

function errorCode(cause: unknown): HostedErrorCode {
	if (cause instanceof Error) {
		const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
		const code: JsonValue | undefined = descriptor?.value;
		if (isText(code) && isHostedErrorCode(code)) return code;
		return "invalid_request";
	}
	return "internal";
}

const MESSAGING_CALL_FIELDS = new Map<string, readonly string[]>([
	["messaging.peers", ["cursor"]],
	["messaging.send", ["operationId", "participantId", "bodyBase64"]],
	["messaging.status", ["operationId"]],
	["messaging.receive", ["eventId"]],
	["messaging.received", ["eventId"]],
	["messaging.reply", ["operationId", "eventId", "bodyBase64"]],
]);

function messagingCallInput(input: JsonObject, method: string): MessagingInput {
	if (method === "messaging.peers") return input.cursor === undefined ? { method: "peers" } : { method: "peers", cursor: boundedText(input.cursor, "cursor", 512) };
	if (method === "messaging.status") return { method: "status", operationId: boundedText(input.operationId, "operation ID", 200) };
	if (method === "messaging.receive") return { method: "receive", eventId: boundedText(input.eventId, "event ID", 200) };
	if (method === "messaging.received") return { method: "received", eventId: boundedText(input.eventId, "event ID", 200) };
	// Base64 avoids expanding a 16 KiB body past the unchanged 64 KiB RPC request cap.
	const encoded = boundedText(input.bodyBase64, "encoded body", 24 * 1024);
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded || bytes.length > HOSTED_MAILBOX_MAX_BODY_BYTES) throw new Error("Messaging body encoding or byte limit is invalid.");
	const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const operationId = boundedText(input.operationId, "operation ID", 200);
	if (method === "messaging.reply") return { method: "reply", operationId, eventId: boundedText(input.eventId, "event ID", 200), body };
	return { method: "send", operationId, participantId: participantName(input.participantId, "recipient participant ID"), body };
}

const HOSTED_METHODS = new Set([
	"messaging.issue", "messaging.peers", "messaging.send", "messaging.status",
	"messaging.receive", "messaging.received", "messaging.reply",
	"pi.register", "pi.heartbeat", "pi.unregister",
	"bridge.bind", "bridge.heartbeat", "bridge.unregister",
	"worktree.ensure", "worktree.list", "worktree.remove",
	"monitor.create", "monitor.get", "monitor.delete",
	"wake.accept", "inbox.claim", "inbox.ack", "inbox.release", "inbox.status",
	"participant.acquire", "participant.get", "participant.list", "participant.stand_down",
	"participant.stand_down_confirmed", "participant.stop_confirmed", "participant.release", "participant.takeover",
	"mailbox.send", "mailbox.status",
]);

const ERROR_CODES: ReadonlySet<string> = new Set([
	"invalid_request", "unsupported_version", "capability_unavailable", "not_found", "conflict", "registration_stale", "identity_mismatch", "claim_conflict", "host_unavailable", "busy", "storage_error", "internal",
]);

function isHostedErrorCode(value: string): value is HostedErrorCode {
	return ERROR_CODES.has(value);
}

function requestId(value: JsonValue): string | null {
	if (!isJsonObject(value)) return null;
	const id = value.id;
	return isText(id) && id.length > 0 && Buffer.byteLength(id) <= 200 ? id : null;
}

function strictObject(value: JsonValue | undefined, name: string, allowed?: readonly string[]): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${name} must be an object.`);
	if (allowed) for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}.`);
	return value;
}

function boundedArray(value: JsonValue | undefined, name: string, max: number): JsonValue[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} items.`);
	return value;
}

function boundedText(value: JsonValue | undefined, name: string, maxBytes: number): string {
	if (!isText(value) || value.length === 0 || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a non-empty string of at most ${maxBytes} bytes.`);
	return value;
}

function integer(value: JsonValue | undefined, name: string): number {
	if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
	return value;
}

function envelopeVersion(value: JsonValue | undefined): number {
	if (!isNumber(value) || !Number.isSafeInteger(value)) throw new Error("request version must be an integer.");
	return value;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isText(value: JsonValue | undefined): value is string {
	return value !== undefined && value !== null && value.constructor === String;
}

function isNumber(value: JsonValue | undefined): value is number {
	return value !== undefined && value !== null && value.constructor === Number;
}

function booleanValue(value: JsonValue | undefined, message: string): boolean {
	if (!isBoolean(value)) throw new Error(message);
	return value;
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return value !== undefined && value !== null && value.constructor === Boolean;
}
