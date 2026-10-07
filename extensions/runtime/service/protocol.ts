import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { GitError } from "../../shared/worktree.ts";
import { RuntimeError, type RuntimeErrorCode } from "../errors.ts";
import { HOSTED_MAILBOX_MAX_BODY_BYTES, HOSTED_PROTOCOL_VERSION, schemaError } from "../schemas/common.ts";
import {
	BridgeBindParams,
	HelloParams,
	HostedRequestIdSchema,
	HostedRequestSchema,
	HostedRequestVersionSchema,
	MessagingIssueParams,
	MessagingNamespaceParams,
	MessagingSendParams,
	ParticipantAcquireParams,
	ParticipantAuthParams,
	ParticipantConfirmedParams,
	PiRegisterParams,
	RegistrationAuthParams,
	WorktreeEnsureParams,
	WorktreeRemoveParams,
	type JsonObject,
	type JsonValue,
	type MessagingNamespaceAuth,
} from "../schemas/rpc.ts";
import { RuntimeAgentBinder, type BoundAgentResult } from "./bridge.ts";
import { RuntimeMessaging, type MessagingInput } from "./messaging.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { LiveTargets, type HostedCaller } from "./live.ts";
import { RuntimeWorktrees } from "./worktree.ts";

export const HOSTED_MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MESSAGING_RESPONSE_BYTES = 128 * 1024;

/** Every authority a started runtime serves; a process that cannot build one cannot dispatch at all. */
export interface HostedProtocolContext {
	runtimeId: string;
	live: LiveTargets;
	messaging: RuntimeMessaging;
	participants: HostedParticipantCoordinator;
	bridges: RuntimeAgentBinder;
	worktrees: RuntimeWorktrees;
}

type HostedResponse =
	| { v: 1; id: string | null; ok: true; result: unknown }
	| { v: 1; id: string | null; ok: false; error: { code: RuntimeErrorCode; message: string } };

/** One dispatched call: the request id plus the services its method reaches for. */
interface HostedCall {
	id: string;
	context: HostedProtocolContext;
}

type HostedMethodHandler = (
	id: string,
	params: JsonValue | undefined,
	context: HostedProtocolContext,
) => HostedResponse | Promise<HostedResponse>;

/** Validates this method's params once, then hands the handler a typed object it never re-checks. */
function method<Schema extends TSchema>(
	schema: Schema,
	handle: (call: HostedCall, params: Static<Schema>) => HostedResponse | Promise<HostedResponse>,
): HostedMethodHandler {
	return (id, params, context) => {
		if (!Value.Check(schema, params)) throw schemaError(schema, params, "Request params");
		return handle({ id, context }, params);
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
		if (error instanceof RuntimeError) return failure(candidateId, error.code, error.message);
		if (error instanceof GitError) return failure(candidateId, "host_unavailable", error.message);
		return failure(candidateId, "invalid_request", error instanceof Error ? error.message : "Invalid request.");
	}
}

export function encodeHostedResponse(response: HostedResponse): string {
	return `${JSON.stringify(response)}\n`;
}

export function invalidFrame(message: string): HostedResponse {
	return failure(null, "invalid_request", message);
}

function hello(id: string, value: JsonValue | undefined, context: HostedProtocolContext): HostedResponse {
	if (!Value.Check(HelloParams, value)) return failure(id, "invalid_request", schemaError(HelloParams, value, "hello params").message);
	const { minVersion, maxVersion } = value;
	if (minVersion > HOSTED_PROTOCOL_VERSION || maxVersion < HOSTED_PROTOCOL_VERSION || minVersion > maxVersion) {
		return failure(id, "unsupported_version", "Requested version range does not include protocol v1.");
	}
	const capabilities = {
		targets: ["pi", "claude-code", "codex"],
		mailbox: { maxBodyBytes: HOSTED_MAILBOX_MAX_BODY_BYTES },
		interactiveAgent: { bind: "herdr_agent_name" },
		worktree: { isolatedWrite: true },
	};
	return success(id, { version: 1, runtimeId: context.runtimeId, capabilities });
}

async function callMessaging(call: HostedCall, namespace: MessagingNamespaceAuth, input: MessagingInput): Promise<HostedResponse> {
	const result = success(call.id, await call.context.messaging.call(namespace.namespaceId, namespace.secret, input));
	if (Buffer.byteLength(encodeHostedResponse(result)) > MAX_MESSAGING_RESPONSE_BYTES) {
		return failure(call.id, "conflict", "Messaging response exceeds its byte limit.");
	}
	return result;
}

function decodeMessagingBody(encoded: string): string {
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded || bytes.length > HOSTED_MAILBOX_MAX_BODY_BYTES) {
		throw new Error("Messaging body encoding or byte limit is invalid.");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The Pi heartbeat renews the lease and carries the mail hint of this target's sole live namespace. */
async function heartbeatPi(call: HostedCall, params: Static<typeof RegistrationAuthParams>): Promise<HostedResponse> {
	const caller = await call.context.live.heartbeat(params.targetKey);
	const mail = call.context.messaging.unread(caller);
	const heartbeat: JsonObject = { targetKey: caller.targetKey };
	if (mail) heartbeat.mail = { namespaceId: mail.namespaceId, eventId: mail.eventId };
	return success(call.id, heartbeat);
}

async function bindAgent(call: HostedCall, params: Static<typeof BridgeBindParams>): Promise<HostedResponse> {
	const { targetKey, ...input } = params;
	const caller = call.context.live.caller(targetKey);
	return success(call.id, boundAgentResult(await call.context.bridges.bind(caller, input)));
}

const HOSTED_METHODS = new Map<string, HostedMethodHandler>([
	["messaging.issue", method(MessagingIssueParams, async (call, params) => success(
		call.id,
		await call.context.messaging.issue(authorize(call, params), params.participantKey, params.expectedGeneration),
	))],
	["messaging.inbox", method(MessagingNamespaceParams, (call, params) => callMessaging(call, params, { method: "inbox" }))],
	["messaging.send", method(MessagingSendParams, (call, params) => callMessaging(call, params, {
		method: "send",
		operationId: params.operationId,
		participantId: params.participantId,
		body: decodeMessagingBody(params.bodyBase64),
	}))],
	["pi.register", method(PiRegisterParams, async (call, params) => success(
		call.id,
		await call.context.live.register(params),
	))],
	["pi.heartbeat", method(RegistrationAuthParams, heartbeatPi)],
	["pi.unregister", method(RegistrationAuthParams, (call, params) => unregister(call, params))],
	["bridge.bind", method(BridgeBindParams, bindAgent)],
	["bridge.heartbeat", method(RegistrationAuthParams, async (call, params) => {
		const caller = await call.context.live.heartbeat(params.targetKey);
		const heartbeat: JsonObject = { targetKey: caller.targetKey };
		const agentStatus = call.context.live.agentStatus(caller.targetKey);
		if (agentStatus) heartbeat.agentStatus = agentStatus;
		return success(call.id, heartbeat);
	})],
	["worktree.list", method(RegistrationAuthParams, async (call, params) => success(
		call.id,
		{ worktrees: await call.context.worktrees.list(authorize(call, params)) },
	))],
	["worktree.ensure", method(WorktreeEnsureParams, async (call, params) => success(
		call.id,
		await call.context.worktrees.ensure(authorize(call, params), params),
	))],
	["worktree.remove", method(WorktreeRemoveParams, async (call, params) => success(
		call.id,
		await call.context.worktrees.remove(authorize(call, params), params),
	))],
	["participant.acquire", method(ParticipantAcquireParams, (call, params) => success(
		call.id,
		call.context.participants.acquire(authorize(call, params), params.protocol, params.participantId),
	))],
	["participant.get", method(ParticipantAuthParams, (call, params) => success(
		call.id,
		call.context.participants.get(authorize(call, params), params.participantKey),
	))],
	["participant.list", method(RegistrationAuthParams, (call, params) => success(
		call.id,
		{ participants: call.context.participants.list(authorize(call, params)) },
	))],
	["participant.stand_down_confirmed", method(ParticipantConfirmedParams, (call, params) => success(
		call.id,
		call.context.participants.standDownConfirmed(authorize(call, params), params.participantKey, params.expectedGeneration),
	))],
	["participant.stop_confirmed", method(ParticipantConfirmedParams, async (call, params) => success(
		call.id,
		await call.context.participants.stopConfirmed(authorize(call, params), params.participantKey, params.expectedGeneration),
	))],
	["participant.takeover", method(ParticipantConfirmedParams, (call, params) => success(
		call.id,
		call.context.participants.takeover(authorize(call, params), params.participantKey, params.expectedGeneration),
	))],
]);

/** Every dispatchable method except `hello`, which the dispatcher answers before the handler map. */
export const HOSTED_METHOD_NAMES: readonly string[] = [...HOSTED_METHODS.keys()];

function unregister(call: HostedCall, params: Static<typeof RegistrationAuthParams>): HostedResponse {
	call.context.live.forget(params.targetKey);
	return success(call.id, { unregistered: true });
}

function authorize(call: HostedCall, params: Static<typeof RegistrationAuthParams>): HostedCaller {
	return call.context.live.caller(params.targetKey);
}

function boundAgentResult(result: BoundAgentResult) {
	return {
		targetKey: result.targetKey,
		participantKey: result.participantKey,
		holderGeneration: result.holderGeneration,
		driver: result.driver,
		profile: result.profile,
		projectRoot: result.projectRoot,
		cwd: result.cwd,
	};
}

function success<Result>(id: string, result: Result): HostedResponse {
	return { v: 1, id, ok: true, result };
}

function failure(id: string | null, code: RuntimeErrorCode, message: string): HostedResponse {
	return { v: 1, id, ok: false, error: { code, message } };
}
