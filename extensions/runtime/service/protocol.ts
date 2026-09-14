import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PROTOCOL_VERSION,
	type HostedFilesystemCreatedEvent,
	type HostedMonitor,
} from "../hosted-types.ts";
import { schemaError } from "../schemas/common.ts";
import {
	BridgeBindParams,
	HelloParams,
	HostedRequestIdSchema,
	HostedRequestSchema,
	HostedRequestVersionSchema,
	InboxAckParams,
	MailboxSendParams,
	MessagingEventParams,
	MessagingIssueParams,
	MessagingPeersParams,
	MessagingReplyParams,
	MessagingSendParams,
	MessagingStatusParams,
	MonitorCreateParams,
	MonitorDeleteParams,
	ParticipantAcquireParams,
	ParticipantAuthParams,
	ParticipantConfirmedParams,
	ParticipantStandDownParams,
	PiHeartbeatParams,
	PiRegisterParams,
	RegistrationAuthParams,
	WorktreeEnsureParams,
	WorktreeRemoveParams,
	type JsonObject,
	type JsonValue,
	type MessagingNamespaceAuth,
} from "../schemas/rpc.ts";
import { RuntimeAgentBinder, type BoundAgentResult } from "./bridge.ts";
import { DirectoryMonitorManager } from "./monitor.ts";
import { RuntimeMessaging, type MessagingInput } from "./messaging.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RuntimeRegistrationManager, type HostedLiveRegistration } from "./registration.ts";
import { RuntimeInbox } from "./delivery.ts";
import { RuntimeWorktrees } from "./worktree.ts";

export const HOSTED_MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MESSAGING_RESPONSE_BYTES = 128 * 1024;

export type HostedErrorCode =
	| "invalid_request"
	| "unsupported_version"
	| "capability_unavailable"
	| "not_found"
	| "conflict"
	| "registration_stale"
	| "identity_mismatch"
	| "host_unavailable"
	| "busy"
	| "storage_error"
	| "internal";

export interface HostedProtocolContext {
	runtimeId: string;
	agentWake: "herdr_exact_agent" | "none";
	degradedReason?: "host_unavailable";
	registrations?: RuntimeRegistrationManager;
	messaging?: RuntimeMessaging;
	monitors?: DirectoryMonitorManager;
	inbox?: RuntimeInbox;
	participants?: HostedParticipantCoordinator;
	bridges?: RuntimeAgentBinder;
	worktrees?: RuntimeWorktrees;
}

export type HostedResponse =
	| { v: 1; id: string | null; ok: true; result: unknown }
	| { v: 1; id: string | null; ok: false; error: { code: HostedErrorCode; message: string } };

/** One authorized call: the request id plus the runtime services every hosted method needs. */
interface HostedMethodCall {
	id: string;
	context: HostedProtocolContext;
	registrations: RuntimeRegistrationManager;
	monitors: DirectoryMonitorManager;
	inbox: RuntimeInbox;
}

type HostedMethodHandler = (
	id: string,
	params: JsonValue | undefined,
	context: HostedProtocolContext,
) => HostedResponse | Promise<HostedResponse>;

class HostedCapabilityError extends Error {
	readonly code = "capability_unavailable" as const;
}

/** Validates this method's params once, then hands the handler a typed object it never re-checks. */
function method<Schema extends TSchema>(
	schema: Schema,
	handle: (call: HostedMethodCall, params: Static<Schema>) => HostedResponse | Promise<HostedResponse>,
): HostedMethodHandler {
	return (id, params, context) => {
		if (!Value.Check(schema, params)) throw schemaError(schema, params, "Request params");
		return handle(authorizedCall(id, context), params);
	};
}

export async function dispatchHostedLine(line: string, context: HostedProtocolContext): Promise<HostedResponse> {
	let value: JsonValue;
	try {
		value = JSON.parse(line);
	} catch {
		return failure(null, "invalid_request", "Request is not valid JSON.");
	}
	const candidateId = Value.Check(HostedRequestIdSchema, value) ? value.id : null;
	try {
		if (!Value.Check(HostedRequestVersionSchema, value)) throw schemaError(HostedRequestVersionSchema, value, "Request envelope");
		if (value.v !== HOSTED_PROTOCOL_VERSION) return failure(value.id, "unsupported_version", "Unsupported protocol envelope version.");
		if (!Value.Check(HostedRequestSchema, value)) throw schemaError(HostedRequestSchema, value, "Request envelope");
		if (value.method === "hello") return hello(value.id, value.params, context);
		const handle = HOSTED_METHODS.get(value.method);
		if (!handle) return failure(value.id, "not_found", "Unknown runtime method.");
		return await handle(value.id, value.params, context);
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

function authorizedCall(id: string, context: HostedProtocolContext): HostedMethodCall {
	const registrations = context.registrations;
	const monitors = context.monitors;
	const inbox = context.inbox;
	if (!registrations || !monitors || !inbox) throw new HostedCapabilityError("Hosted runtime methods are unavailable in this process.");
	return { id, context, registrations, monitors, inbox };
}

function hello(id: string, value: JsonValue | undefined, context: HostedProtocolContext): HostedResponse {
	if (!Value.Check(HelloParams, value)) return failure(id, "invalid_request", schemaError(HelloParams, value, "hello params").message);
	const { minVersion, maxVersion } = value;
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
	return success(id, { version: 1, runtimeId: context.runtimeId, capabilities });
}

async function issueMessaging(call: HostedMethodCall, params: Static<typeof MessagingIssueParams>): Promise<HostedResponse> {
	const messaging = requireMessaging(call);
	const caller = authorize(call, params);
	return success(call.id, await messaging.issue(caller, params.participantKey, params.expectedGeneration));
}

async function callMessaging(
	call: HostedMethodCall,
	namespace: MessagingNamespaceAuth,
	input: MessagingInput,
): Promise<HostedResponse> {
	const messaging = requireMessaging(call);
	const result = success(call.id, await messaging.call(namespace.namespaceId, namespace.secret, input));
	if (Buffer.byteLength(encodeHostedResponse(result)) > MAX_MESSAGING_RESPONSE_BYTES) {
		return failure(call.id, "conflict", "Messaging response exceeds its byte limit.");
	}
	return result;
}

function listMessagingPeers(call: HostedMethodCall, params: Static<typeof MessagingPeersParams>): Promise<HostedResponse> {
	const cursor = params.cursor;
	return callMessaging(call, params, cursor === undefined ? { method: "peers" } : { method: "peers", cursor });
}

function sendMessaging(call: HostedMethodCall, params: Static<typeof MessagingSendParams>): Promise<HostedResponse> {
	const { operationId, participantId, bodyBase64 } = params;
	return callMessaging(call, params, { method: "send", operationId, participantId, body: decodeMessagingBody(bodyBase64) });
}

function replyMessaging(call: HostedMethodCall, params: Static<typeof MessagingReplyParams>): Promise<HostedResponse> {
	const { operationId, eventId, bodyBase64 } = params;
	return callMessaging(call, params, { method: "reply", operationId, eventId, body: decodeMessagingBody(bodyBase64) });
}

function decodeMessagingBody(encoded: string): string {
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded || bytes.length > HOSTED_MAILBOX_MAX_BODY_BYTES) {
		throw new Error("Messaging body encoding or byte limit is invalid.");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function listWorktrees(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): Promise<HostedResponse> {
	const worktrees = requireWorktrees(call);
	return success(call.id, { worktrees: await worktrees.list(authorize(call, params)) });
}

async function ensureWorktree(call: HostedMethodCall, params: Static<typeof WorktreeEnsureParams>): Promise<HostedResponse> {
	const worktrees = requireWorktrees(call);
	const { callerParticipantKey, expectedCallerGeneration, protocol, participantId } = params;
	const input = { callerParticipantKey, expectedCallerGeneration, protocol, participantId };
	return success(call.id, await worktrees.ensure(authorize(call, params), input));
}

async function removeWorktree(call: HostedMethodCall, params: Static<typeof WorktreeRemoveParams>): Promise<HostedResponse> {
	const worktrees = requireWorktrees(call);
	const { callerParticipantKey, expectedCallerGeneration, protocol, participantId, discardConfirmed } = params;
	const input = { callerParticipantKey, expectedCallerGeneration, protocol, participantId, discardConfirmed };
	return success(call.id, await worktrees.remove(authorize(call, params), input));
}

async function bindAgent(call: HostedMethodCall, params: Static<typeof BridgeBindParams>): Promise<HostedResponse> {
	const bridges = call.context.bridges;
	if (!bridges) throw new HostedCapabilityError("Runtime Herdr agent binding is unavailable in this process.");
	const { registrationId, registrationKey, ...input } = params;
	return success(call.id, boundAgentResult(await bridges.bind(call.registrations.authorize(registrationId, registrationKey), input)));
}

async function registerPi(call: HostedMethodCall, params: Static<typeof PiRegisterParams>): Promise<HostedResponse> {
	return success(call.id, registrationResult(await call.registrations.register(params)));
}

async function heartbeatAgent(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): Promise<HostedResponse> {
	const registration = await call.registrations.heartbeat(params.registrationId, params.registrationKey);
	return success(call.id, registrationResult(registration));
}

/** The Pi heartbeat is the only delivery path: it hands out one batch and Pi acks what it admitted. */
async function heartbeatPi(call: HostedMethodCall, params: Static<typeof PiHeartbeatParams>): Promise<HostedResponse> {
	const registration = await call.registrations.heartbeat(params.registrationId, params.registrationKey);
	const mail = call.context.messaging?.unread(registration);
	const heartbeat: JsonObject = registrationResult(registration);
	const events = params.admit === true ? call.inbox.deliver(registration) : [];
	if (events.length > 0) heartbeat.events = events.map(inboxEventResult);
	if (mail) heartbeat.mail = { namespaceId: mail.namespaceId, eventId: mail.eventId };
	return success(call.id, heartbeat);
}

function unregister(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): HostedResponse {
	call.registrations.unregister(params.registrationId, params.registrationKey);
	return success(call.id, { unregistered: true });
}

function createMonitor(call: HostedMethodCall, params: Static<typeof MonitorCreateParams>): HostedResponse {
	const registration = authorize(call, params);
	return success(call.id, monitorResult(call.monitors.create(registration.targetKey, params.directory, params.settleMs)));
}

function getMonitor(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): HostedResponse {
	const monitor = call.monitors.get(authorize(call, params).targetKey);
	return success(call.id, { monitor: monitor ? monitorResult(monitor) : null });
}

function deleteMonitor(call: HostedMethodCall, params: Static<typeof MonitorDeleteParams>): HostedResponse {
	call.monitors.delete(authorize(call, params).targetKey, params.monitorId);
	return success(call.id, { deleted: true });
}

function ackInbox(call: HostedMethodCall, params: Static<typeof InboxAckParams>): HostedResponse {
	call.inbox.ack(authorize(call, params), params.eventIds);
	return success(call.id, { settled: true });
}

function inboxStatus(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): HostedResponse {
	return success(call.id, call.inbox.status(authorize(call, params)));
}

function sendMailbox(call: HostedMethodCall, params: Static<typeof MailboxSendParams>): HostedResponse {
	const participants = requireParticipants(call);
	const event = participants.send(
		authorize(call, params),
		params.senderParticipantKey,
		params.expectedSenderGeneration,
		params.recipientParticipantKey,
		params.sendId,
		params.body,
	);
	return success(call.id, { eventId: event.eventId, sequence: event.source.sequence });
}

function acquireParticipant(call: HostedMethodCall, params: Static<typeof ParticipantAcquireParams>): HostedResponse {
	const participants = requireParticipants(call);
	const registration = authorize(call, params);
	return success(call.id, participants.acquire(registration, params.protocol, params.participantId, params.revive ?? false));
}

function listParticipants(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): HostedResponse {
	const participants = requireParticipants(call);
	return success(call.id, { participants: participants.list(authorize(call, params)) });
}

function getParticipant(call: HostedMethodCall, params: Static<typeof ParticipantAuthParams>): HostedResponse {
	const participants = requireParticipants(call);
	return success(call.id, participants.get(authorize(call, params), params.participantKey));
}

function releaseParticipant(call: HostedMethodCall, params: Static<typeof ParticipantAuthParams>): HostedResponse {
	const participants = requireParticipants(call);
	return success(call.id, participants.release(authorize(call, params), params.participantKey));
}

function standDownParticipant(call: HostedMethodCall, params: Static<typeof ParticipantStandDownParams>): HostedResponse {
	const participants = requireParticipants(call);
	const registration = authorize(call, params);
	return success(call.id, participants.standDown(registration, params.participantKey, params.expectedGeneration));
}

function standDownParticipantConfirmed(call: HostedMethodCall, params: Static<typeof ParticipantConfirmedParams>): HostedResponse {
	const participants = requireParticipants(call);
	const registration = authorize(call, params);
	return success(call.id, participants.standDownConfirmed(registration, params.participantKey, params.expectedGeneration));
}

async function stopParticipantConfirmed(
	call: HostedMethodCall,
	params: Static<typeof ParticipantConfirmedParams>,
): Promise<HostedResponse> {
	const participants = requireParticipants(call);
	const registration = authorize(call, params);
	return success(call.id, await participants.stopConfirmed(registration, params.participantKey, params.expectedGeneration));
}

function takeoverParticipant(call: HostedMethodCall, params: Static<typeof ParticipantConfirmedParams>): HostedResponse {
	const participants = requireParticipants(call);
	const registration = authorize(call, params);
	return success(call.id, participants.takeover(registration, params.participantKey, params.expectedGeneration));
}

const HOSTED_METHODS = new Map<string, HostedMethodHandler>([
	["messaging.issue", method(MessagingIssueParams, issueMessaging)],
	["messaging.peers", method(MessagingPeersParams, listMessagingPeers)],
	["messaging.send", method(MessagingSendParams, sendMessaging)],
	["messaging.status", method(MessagingStatusParams, (call, params) => callMessaging(call, params, {
		method: "status",
		operationId: params.operationId,
	}))],
	["messaging.receive", method(MessagingEventParams, (call, params) => callMessaging(call, params, {
		method: "receive",
		eventId: params.eventId,
	}))],
	["messaging.received", method(MessagingEventParams, (call, params) => callMessaging(call, params, {
		method: "received",
		eventId: params.eventId,
	}))],
	["messaging.reply", method(MessagingReplyParams, replyMessaging)],
	["pi.register", method(PiRegisterParams, registerPi)],
	["pi.heartbeat", method(PiHeartbeatParams, heartbeatPi)],
	["pi.unregister", method(RegistrationAuthParams, unregister)],
	["bridge.bind", method(BridgeBindParams, bindAgent)],
	["bridge.heartbeat", method(RegistrationAuthParams, heartbeatAgent)],
	["bridge.unregister", method(RegistrationAuthParams, unregister)],
	["worktree.list", method(RegistrationAuthParams, listWorktrees)],
	["worktree.ensure", method(WorktreeEnsureParams, ensureWorktree)],
	["worktree.remove", method(WorktreeRemoveParams, removeWorktree)],
	["monitor.create", method(MonitorCreateParams, createMonitor)],
	["monitor.get", method(RegistrationAuthParams, getMonitor)],
	["monitor.delete", method(MonitorDeleteParams, deleteMonitor)],
	["inbox.ack", method(InboxAckParams, ackInbox)],
	["inbox.status", method(RegistrationAuthParams, inboxStatus)],
	["participant.acquire", method(ParticipantAcquireParams, acquireParticipant)],
	["participant.get", method(ParticipantAuthParams, getParticipant)],
	["participant.list", method(RegistrationAuthParams, listParticipants)],
	["participant.stand_down", method(ParticipantStandDownParams, standDownParticipant)],
	["participant.stand_down_confirmed", method(ParticipantConfirmedParams, standDownParticipantConfirmed)],
	["participant.stop_confirmed", method(ParticipantConfirmedParams, stopParticipantConfirmed)],
	["participant.release", method(ParticipantAuthParams, releaseParticipant)],
	["participant.takeover", method(ParticipantConfirmedParams, takeoverParticipant)],
	["mailbox.send", method(MailboxSendParams, sendMailbox)],
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

function authorize(call: HostedMethodCall, params: Static<typeof RegistrationAuthParams>): HostedLiveRegistration {
	return call.registrations.authorize(params.registrationId, params.registrationKey);
}

function registrationResult(registration: HostedLiveRegistration) {
	return {
		targetKey: registration.targetKey,
		registrationId: registration.registrationId,
		registrationKey: registration.registrationKey,
		leaseUntil: registration.leaseUntil,
	};
}

function boundAgentResult(result: BoundAgentResult) {
	return {
		...registrationResult(result.registration),
		participantKey: result.participantKey,
		holderGeneration: result.holderGeneration,
		driver: result.driver,
		profile: result.profile,
		projectRoot: result.projectRoot,
		cwd: result.cwd,
	};
}

function monitorResult(monitor: HostedMonitor) {
	return {
		monitorId: monitor.monitorId,
		directory: monitor.directory,
		status: monitor.status,
		settleMs: monitor.settleMs,
	};
}

function inboxEventResult(event: HostedFilesystemCreatedEvent) {
	return { eventId: event.eventId, type: event.type, summary: event.summary, path: event.payload.path };
}

function success<Result>(id: string, result: Result): HostedResponse {
	return { v: 1, id, ok: true, result };
}

function failure(id: string | null, code: HostedErrorCode, message: string): HostedResponse {
	return { v: 1, id, ok: false, error: { code, message } };
}

const ERROR_CODES: ReadonlySet<string> = new Set([
	"invalid_request", "unsupported_version", "capability_unavailable", "not_found", "conflict", "registration_stale",
	"identity_mismatch", "host_unavailable", "busy", "storage_error", "internal",
]);

function errorCode(cause: unknown): HostedErrorCode {
	if (!(cause instanceof Error)) return "internal";
	const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
	const code: JsonValue | undefined = descriptor?.value;
	return isHostedErrorCode(code) ? code : "invalid_request";
}

function isHostedErrorCode(value: JsonValue | undefined): value is HostedErrorCode {
	return value !== undefined && value !== null && value.constructor === String && ERROR_CODES.has(String(value));
}
