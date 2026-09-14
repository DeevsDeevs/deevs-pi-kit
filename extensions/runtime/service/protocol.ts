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
import { RuntimeRegistrationManager, type HostedLiveRegistration, type RegisterPiInput } from "./registration.ts";
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

/** One authorized call: the envelope fields plus the runtime services every hosted method needs. */
interface HostedMethodCall {
	id: string;
	params: JsonValue | undefined;
	context: HostedProtocolContext;
	registrations: RuntimeRegistrationManager;
	monitors: DirectoryMonitorManager;
	wakes: HostedWakeCoordinator;
}

type HostedMethodHandler = (call: HostedMethodCall) => HostedResponse | Promise<HostedResponse>;

class HostedCapabilityError extends Error {
	readonly code = "capability_unavailable" as const;
}

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
		if (method === "hello") return hello(id, request.params, context);
		const handle = HOSTED_METHODS.get(method);
		if (!handle) return failure(id, "not_found", "Unknown runtime method.");
		return await handle(authorizedCall(id, request.params, context));
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

function authorizedCall(id: string, params: JsonValue | undefined, context: HostedProtocolContext): HostedMethodCall {
	const registrations = context.registrations;
	const monitors = context.monitors;
	const wakes = context.wakes;
	if (!registrations || !monitors || !wakes) throw new HostedCapabilityError("Hosted runtime methods are unavailable in this process.");
	return { id, params, context, registrations, monitors, wakes };
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

async function issueMessaging(call: HostedMethodCall): Promise<HostedResponse> {
	const messaging = requireMessaging(call);
	const fields = ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"];
	const input = strictObject(call.params, "messaging.issue params", fields);
	if (input.confirmed !== true) throw new Error("Messaging issuance requires explicit controller confirmation.");
	const caller = authorize(call, input);
	const participantKey = boundedText(input.participantKey, "participant key", 200);
	const expectedGeneration = boundedText(input.expectedGeneration, "holder generation", 200);
	return success(call.id, await messaging.issue(caller, participantKey, expectedGeneration));
}

async function callMessaging(call: HostedMethodCall, method: string): Promise<HostedResponse> {
	const messaging = requireMessaging(call);
	const input = strictObject(call.params, `${method} params`, ["namespaceId", "secret", ...MESSAGING_CALL_FIELDS.get(method) ?? []]);
	const namespaceId = boundedText(input.namespaceId, "namespace ID", 200);
	const secret = boundedText(input.secret, "messaging secret", 200);
	const result = success(call.id, await messaging.call(namespaceId, secret, messagingCallInput(input, method)));
	if (Buffer.byteLength(encodeHostedResponse(result)) > 128 * 1024) {
		return failure(call.id, "conflict", "Messaging response exceeds its byte limit.");
	}
	return result;
}

async function listWorktrees(call: HostedMethodCall): Promise<HostedResponse> {
	const worktrees = requireWorktrees(call);
	const auth = authParams(call.params, "worktree.list");
	return success(call.id, { worktrees: await worktrees.list(call.registrations.authorize(auth.registrationId, auth.registrationKey)) });
}

async function ensureWorktree(call: HostedMethodCall): Promise<HostedResponse> {
	const worktrees = requireWorktrees(call);
	const parsed = worktreeEnsureParams(call.params);
	const caller = call.registrations.authorize(parsed.registrationId, parsed.registrationKey);
	return success(call.id, await worktrees.ensure(caller, parsed.input));
}

async function removeWorktree(call: HostedMethodCall): Promise<HostedResponse> {
	const worktrees = requireWorktrees(call);
	const parsed = worktreeRemoveParams(call.params);
	const caller = call.registrations.authorize(parsed.registrationId, parsed.registrationKey);
	return success(call.id, await worktrees.remove(caller, parsed.input));
}

async function bindAgent(call: HostedMethodCall): Promise<HostedResponse> {
	const bridges = call.context.bridges;
	if (!bridges) throw new HostedCapabilityError("Runtime Herdr agent binding is unavailable in this process.");
	const parsed = bindAgentParams(call.params);
	const caller = call.registrations.authorize(parsed.registrationId, parsed.registrationKey);
	return success(call.id, boundAgentResult(await bridges.bind(caller, parsed.input)));
}

async function registerPi(call: HostedMethodCall): Promise<HostedResponse> {
	return success(call.id, registrationResult(await call.registrations.register(registerParams(call.params))));
}

async function heartbeatAgent(call: HostedMethodCall): Promise<HostedResponse> {
	const auth = authParams(call.params, "registration");
	const registration = await call.registrations.heartbeat(auth.registrationId, auth.registrationKey);
	return success(call.id, { ...registrationResult(registration), inboxReady: call.wakes.status(registration).pending > 0 });
}

async function heartbeatPi(call: HostedMethodCall): Promise<HostedResponse> {
	const auth = authParams(call.params, "registration");
	const registration = await call.registrations.heartbeat(auth.registrationId, auth.registrationKey);
	const mail = call.context.messaging?.unread(registration);
	const heartbeat: JsonObject = { ...registrationResult(registration), inboxReady: call.wakes.status(registration).pending > 0 };
	if (mail) heartbeat.mail = { namespaceId: mail.namespaceId, eventId: mail.eventId };
	return success(call.id, heartbeat);
}

function unregister(call: HostedMethodCall): HostedResponse {
	const auth = authParams(call.params, "registration");
	call.registrations.unregister(auth.registrationId, auth.registrationKey);
	return success(call.id, { unregistered: true });
}

function createMonitor(call: HostedMethodCall): HostedResponse {
	const input = strictObject(call.params, "monitor.create params", ["registrationId", "registrationKey", "directory", "settleMs"]);
	const registration = authorize(call, input);
	const directory = boundedText(input.directory, "monitor directory", 8 * 1024);
	const monitor = call.monitors.create(registration.targetKey, directory, integer(input.settleMs, "settleMs"));
	return success(call.id, monitorResult(monitor));
}

function getMonitor(call: HostedMethodCall): HostedResponse {
	const auth = authParams(call.params, "registration");
	const registration = call.registrations.authorize(auth.registrationId, auth.registrationKey);
	const monitor = call.monitors.get(registration.targetKey);
	return success(call.id, { monitor: monitor ? monitorResult(monitor) : null });
}

function deleteMonitor(call: HostedMethodCall): HostedResponse {
	const input = strictObject(call.params, "monitor.delete params", ["registrationId", "registrationKey", "monitorId"]);
	const registration = authorize(call, input);
	call.monitors.delete(registration.targetKey, boundedText(input.monitorId, "monitor ID", 200));
	return success(call.id, { deleted: true });
}

function acceptWake(call: HostedMethodCall): HostedResponse {
	const input = strictObject(call.params, "wake.accept params", ["registrationId", "registrationKey", "wakeId"]);
	const registration = authorize(call, input);
	return success(call.id, claimResult(call.wakes.accept(registration, boundedText(input.wakeId, "wake ID", 200))));
}

function claimInbox(call: HostedMethodCall): HostedResponse {
	const input = strictObject(call.params, "inbox.claim params", ["registrationId", "registrationKey", "maxEvents"]);
	const registration = authorize(call, input);
	const maxEvents = input.maxEvents === undefined ? HOSTED_MAX_DELIVERY_BATCH : integer(input.maxEvents, "claim batch limit");
	if (maxEvents < 1 || maxEvents > HOSTED_MAX_DELIVERY_BATCH) {
		throw new Error(`claim batch limit must be between 1 and ${HOSTED_MAX_DELIVERY_BATCH}`);
	}
	return success(call.id, claimResult(call.wakes.claim(registration, maxEvents)));
}

function ackInbox(call: HostedMethodCall): HostedResponse {
	const input = claimReceiptParams(call.params, "inbox.ack");
	const registration = call.registrations.authorize(input.registrationId, input.registrationKey);
	call.wakes.ack(registration, input.claimId, input.eventIds);
	return success(call.id, { settled: true });
}

function releaseInbox(call: HostedMethodCall): HostedResponse {
	const input = claimReceiptParams(call.params, "inbox.release");
	const registration = call.registrations.authorize(input.registrationId, input.registrationKey);
	call.wakes.release(registration, input.claimId, input.eventIds);
	return success(call.id, { settled: true });
}

function inboxStatus(call: HostedMethodCall): HostedResponse {
	const auth = authParams(call.params, "registration");
	return success(call.id, call.wakes.status(call.registrations.authorize(auth.registrationId, auth.registrationKey)));
}

function sendMailbox(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const fields = [
		"registrationId", "registrationKey", "senderParticipantKey", "expectedSenderGeneration",
		"recipientParticipantKey", "sendId", "body",
	];
	const input = strictObject(call.params, "mailbox.send params", fields);
	const registration = authorize(call, input);
	const event = participants.send(
		registration,
		boundedText(input.senderParticipantKey, "sender participant key", 200),
		boundedText(input.expectedSenderGeneration, "expected sender generation", 200),
		boundedText(input.recipientParticipantKey, "recipient participant key", 200),
		boundedText(input.sendId, "send ID", 200),
		boundedText(input.body, "mailbox body", HOSTED_MAILBOX_MAX_BODY_BYTES),
	);
	return success(call.id, { eventId: event.eventId, sequence: event.source.sequence });
}

function acquireParticipant(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const fields = ["registrationId", "registrationKey", "protocol", "participantId", "revive"];
	const input = strictObject(call.params, "participant.acquire params", fields);
	const revive = input.revive === undefined ? false : booleanValue(input.revive, "participant revive must be a boolean");
	const registration = authorize(call, input);
	const protocol = participantName(input.protocol, "protocol");
	const participantId = participantName(input.participantId, "participant ID");
	return success(call.id, participants.acquire(registration, protocol, participantId, revive));
}

function listParticipants(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const auth = authParams(call.params, "registration");
	const registration = call.registrations.authorize(auth.registrationId, auth.registrationKey);
	return success(call.id, { participants: participants.list(registration) });
}

function getParticipant(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const input = participantAuthParams(call.params, "participant.get");
	const registration = call.registrations.authorize(input.registrationId, input.registrationKey);
	return success(call.id, participants.get(registration, input.participantKey));
}

function releaseParticipant(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const input = participantAuthParams(call.params, "participant.release");
	const registration = call.registrations.authorize(input.registrationId, input.registrationKey);
	return success(call.id, participants.release(registration, input.participantKey));
}

function standDownParticipant(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const fields = ["registrationId", "registrationKey", "participantKey", "expectedGeneration"];
	const input = strictObject(call.params, "participant.stand_down params", fields);
	const registration = authorize(call, input);
	const participantKey = boundedText(input.participantKey, "participant key", 200);
	const expectedGeneration = input.expectedGeneration === undefined
		? undefined
		: boundedText(input.expectedGeneration, "expected participant generation", 200);
	return success(call.id, participants.standDown(registration, participantKey, expectedGeneration));
}

function standDownParticipantConfirmed(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const message = "participant confirmed stand-down requires explicit confirmation";
	const params = confirmedParams(call.params, "participant.stand_down_confirmed", message);
	const registration = authorize(call, params);
	const participantKey = boundedText(params.participantKey, "participant key", 200);
	const expectedGeneration = boundedText(params.expectedGeneration, "expected participant generation", 200);
	return success(call.id, participants.standDownConfirmed(registration, participantKey, expectedGeneration));
}

async function stopParticipantConfirmed(call: HostedMethodCall): Promise<HostedResponse> {
	const participants = requireParticipants(call);
	const params = confirmedParams(call.params, "participant.stop_confirmed", "participant stop requires explicit confirmation");
	const registration = authorize(call, params);
	const participantKey = boundedText(params.participantKey, "participant key", 200);
	const expectedGeneration = boundedText(params.expectedGeneration, "expected participant generation", 200);
	return success(call.id, await participants.stopConfirmed(registration, participantKey, expectedGeneration));
}

function takeoverParticipant(call: HostedMethodCall): HostedResponse {
	const participants = requireParticipants(call);
	const params = confirmedParams(call.params, "participant.takeover", "participant takeover requires explicit confirmation");
	const registration = authorize(call, params);
	const participantKey = boundedText(params.participantKey, "participant key", 200);
	const expectedGeneration = boundedText(params.expectedGeneration, "expected participant generation", 200);
	return success(call.id, participants.takeover(registration, participantKey, expectedGeneration));
}

const HOSTED_METHODS = new Map<string, HostedMethodHandler>([
	["messaging.issue", issueMessaging],
	["messaging.peers", (call) => callMessaging(call, "messaging.peers")],
	["messaging.send", (call) => callMessaging(call, "messaging.send")],
	["messaging.status", (call) => callMessaging(call, "messaging.status")],
	["messaging.receive", (call) => callMessaging(call, "messaging.receive")],
	["messaging.received", (call) => callMessaging(call, "messaging.received")],
	["messaging.reply", (call) => callMessaging(call, "messaging.reply")],
	["pi.register", registerPi],
	["pi.heartbeat", heartbeatPi],
	["pi.unregister", unregister],
	["bridge.bind", bindAgent],
	["bridge.heartbeat", heartbeatAgent],
	["bridge.unregister", unregister],
	["worktree.list", listWorktrees],
	["worktree.ensure", ensureWorktree],
	["worktree.remove", removeWorktree],
	["monitor.create", createMonitor],
	["monitor.get", getMonitor],
	["monitor.delete", deleteMonitor],
	["wake.accept", acceptWake],
	["inbox.claim", claimInbox],
	["inbox.ack", ackInbox],
	["inbox.release", releaseInbox],
	["inbox.status", inboxStatus],
	["participant.acquire", acquireParticipant],
	["participant.get", getParticipant],
	["participant.list", listParticipants],
	["participant.stand_down", standDownParticipant],
	["participant.stand_down_confirmed", standDownParticipantConfirmed],
	["participant.stop_confirmed", stopParticipantConfirmed],
	["participant.release", releaseParticipant],
	["participant.takeover", takeoverParticipant],
	["mailbox.send", sendMailbox],
]);

function requireMessaging(call: HostedMethodCall): RuntimeMessaging {
	const messaging = call.context.messaging;
	if (!messaging) throw new HostedCapabilityError("Messaging authority is unavailable.");
	return messaging;
}

function requireParticipants(call: HostedMethodCall): HostedParticipantCoordinator {
	const participants = call.context.participants;
	if (!participants) throw new HostedCapabilityError("Collaborator mailbox methods are unavailable in this process.");
	return participants;
}

function requireWorktrees(call: HostedMethodCall): RuntimeWorktrees {
	const worktrees = call.context.worktrees;
	if (!worktrees) throw new HostedCapabilityError("Runtime worktree authority is unavailable in this process.");
	return worktrees;
}

function authorize(call: HostedMethodCall, params: JsonObject): HostedLiveRegistration {
	const registrationId = boundedText(params.registrationId, "registration ID", 200);
	const registrationKey = boundedText(params.registrationKey, "registration key", 200);
	return call.registrations.authorize(registrationId, registrationKey);
}

function registerParams(value: JsonValue | undefined): RegisterPiInput {
	const fields = ["projectRoot", "piSessionId", "piSessionFile", "clientGeneration", "admittedClaims", "herdr"];
	const params = strictObject(value, "pi.register params", fields);
	const admitted = boundedArray(params.admittedClaims, "admittedClaims", 12).map((value, index) => {
		const receipt = strictObject(value, `admittedClaims[${index}]`, ["claimId", "eventIds"]);
		const eventIds = boundedArray(receipt.eventIds, `admittedClaims[${index}].eventIds`, HOSTED_MAX_DELIVERY_BATCH)
			.map((eventId) => boundedText(eventId, "event ID", 200));
		if (new Set(eventIds).size !== eventIds.length) throw new Error("Admitted claim event IDs must be unique.");
		return { claimId: boundedText(receipt.claimId, "claim ID", 200), eventIds };
	});
	const host = strictObject(params.herdr, "pi.register herdr", ["paneId", "terminalId", "agentName"]);
	const herdr: RegisterPiInput["herdr"] = {
		paneId: boundedText(host.paneId, "Herdr pane ID", 200),
		terminalId: boundedText(host.terminalId, "Herdr terminal ID", 200),
	};
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

interface AuthorizedParams<Input> extends RegistrationAuth {
	input: Input;
}

const WORKTREE_FIELDS = [
	"registrationId", "registrationKey", "callerParticipantKey",
	"expectedCallerGeneration", "protocol", "participantId",
];

function worktreeEnsureParams(value: JsonValue | undefined): AuthorizedParams<EnsureWorktreeInput> {
	const params = strictObject(value, "worktree.ensure params", WORKTREE_FIELDS);
	const input = worktreeInput(params);
	return { ...registrationAuth(params), input };
}

function worktreeRemoveParams(value: JsonValue | undefined): AuthorizedParams<RemoveWorktreeInput> {
	const params = strictObject(value, "worktree.remove params", [...WORKTREE_FIELDS, "discardConfirmed"]);
	const input = worktreeInput(params);
	const auth = registrationAuth(params);
	if (params.discardConfirmed !== true && params.discardConfirmed !== false) {
		throw new Error("worktree discard confirmation must be boolean");
	}
	return { ...auth, input: { ...input, discardConfirmed: params.discardConfirmed } };
}

function registrationAuth(params: JsonObject): RegistrationAuth {
	return {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
	};
}

function worktreeInput(params: JsonObject): EnsureWorktreeInput {
	return {
		callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200),
		expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200),
		protocol: participantName(params.protocol, "protocol"),
		participantId: participantName(params.participantId, "participant ID"),
	};
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
	return { ...registrationAuth(params), input };
}

function nativeDriver(value: JsonValue | undefined): "claude-code" | "codex" {
	if (value !== "claude-code" && value !== "codex") throw new Error("native collaborator driver must be claude-code or codex");
	return value;
}

function authParams(value: JsonValue | undefined, name: string): RegistrationAuth {
	return registrationAuth(strictObject(value, `${name} params`, ["registrationId", "registrationKey"]));
}

function participantAuthParams(value: JsonValue | undefined, name: string): ParticipantAuth {
	const params = strictObject(value, `${name} params`, ["registrationId", "registrationKey", "participantKey"]);
	return { ...registrationAuth(params), participantKey: boundedText(params.participantKey, "participant key", 200) };
}

function confirmedParams(value: JsonValue | undefined, name: string, message: string): JsonObject {
	const fields = ["registrationId", "registrationKey", "participantKey", "expectedGeneration", "confirmed"];
	const params = strictObject(value, `${name} params`, fields);
	if (params.confirmed !== true) throw new Error(message);
	return params;
}

function participantName(value: JsonValue | undefined, name: string): string {
	const result = boundedText(value, name, 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${name} has invalid syntax.`);
	return result;
}

function claimReceiptParams(value: JsonValue | undefined, name: string): ClaimReceiptParams {
	const params = strictObject(value, `${name} params`, ["registrationId", "registrationKey", "claimId", "eventIds"]);
	const eventIds = boundedArray(params.eventIds, "eventIds", HOSTED_MAX_DELIVERY_BATCH)
		.map((eventId) => boundedText(eventId, "event ID", 200));
	if (eventIds.length === 0 || new Set(eventIds).size !== eventIds.length) throw new Error("Claim event IDs must be non-empty and unique.");
	return { ...registrationAuth(params), claimId: boundedText(params.claimId, "claim ID", 200), eventIds };
}

function registrationResult(registration: HostedLiveRegistration) {
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
	return {
		monitorId: monitor.monitorId,
		generation: monitor.generation,
		directory: monitor.directory,
		status: monitor.status,
		settleMs: monitor.settleMs,
	};
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
	if (method === "messaging.peers") {
		return input.cursor === undefined ? { method: "peers" } : { method: "peers", cursor: boundedText(input.cursor, "cursor", 512) };
	}
	if (method === "messaging.status") return { method: "status", operationId: boundedText(input.operationId, "operation ID", 200) };
	if (method === "messaging.receive") return { method: "receive", eventId: boundedText(input.eventId, "event ID", 200) };
	if (method === "messaging.received") return { method: "received", eventId: boundedText(input.eventId, "event ID", 200) };
	// Base64 avoids expanding a 16 KiB body past the unchanged 64 KiB RPC request cap.
	const encoded = boundedText(input.bodyBase64, "encoded body", 24 * 1024);
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded || bytes.length > HOSTED_MAILBOX_MAX_BODY_BYTES) {
		throw new Error("Messaging body encoding or byte limit is invalid.");
	}
	const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const operationId = boundedText(input.operationId, "operation ID", 200);
	if (method === "messaging.reply") return { method: "reply", operationId, eventId: boundedText(input.eventId, "event ID", 200), body };
	return { method: "send", operationId, participantId: participantName(input.participantId, "recipient participant ID"), body };
}

const ERROR_CODES: ReadonlySet<string> = new Set([
	"invalid_request", "unsupported_version", "capability_unavailable", "not_found", "conflict", "registration_stale",
	"identity_mismatch", "claim_conflict", "host_unavailable", "busy", "storage_error", "internal",
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
	if (!isText(value) || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
		throw new Error(`${name} must be a non-empty string of at most ${maxBytes} bytes.`);
	}
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
