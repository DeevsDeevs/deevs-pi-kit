import { HOSTED_BRIDGE_MAX_METADATA_ENTRIES, HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES, HOSTED_MAILBOX_MAX_BODY_BYTES, HOSTED_MAX_DELIVERY_BATCH, HOSTED_MONITOR_MAX_ENTRIES, HOSTED_PROTOCOL_VERSION, type HostedAgentSessionIdentity, type HostedMonitor } from "../hosted-types.ts";
import { RuntimeBridgeCoordinator, type BridgeReconnectInput, type BridgeRegisterInput, type CreateBridgeLaunchInput } from "./bridge.ts";
import { DirectoryMonitorManager } from "./monitor.ts";
import { HostedParticipantCoordinator } from "./participant.ts";
import { RuntimeRegistrationManager, type RegisterPiInput, type RegisterWorkspacePiInput } from "./registration.ts";
import { HostedWakeCoordinator, type HostedClaimResult } from "./wake.ts";
import { RuntimeWorkspaceCoordinator, type CreateBridgeWorkspaceInput, type CreateWorkspaceInput, type WorkspaceAuthority } from "./workspace.ts";

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
	monitors?: DirectoryMonitorManager;
	wakes?: HostedWakeCoordinator;
	participants?: HostedParticipantCoordinator;
	bridges?: RuntimeBridgeCoordinator;
	workspaces?: RuntimeWorkspaceCoordinator;
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
		const workspaces = context.workspaces;
		if (!registrations || !monitors || !wakes) return failure(id, "capability_unavailable", "Hosted runtime methods are unavailable in this process.");

		if (method === "workspace.pi.register" || method === "workspace.pi.reconnect") {
			if (!workspaces) return failure(id, "capability_unavailable", "Runtime workspace registration is unavailable in this process.");
			const result = method === "workspace.pi.register" ? await workspaces.register(workspaceRegisterParams(params)) : await workspaces.reconnect(workspaceReconnectParams(params));
			return success(id, workspaceRegistrationResult(result));
		}
		if (method.startsWith("workspace.")) {
			if (!workspaces) return failure(id, "capability_unavailable", "Runtime workspace authority is unavailable in this process.");
			const parsed = workspaceAuthorizedParams(params, method);
			const caller = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			if (parsed.method === "workspace.launch.create") return success(id, await workspaces.create(caller, parsed.input));
			if (parsed.method === "workspace.bridge.create") return success(id, await workspaces.createBridge(caller, parsed.input));
			if (parsed.method === "workspace.launch.bind") return success(id, await workspaces.bind(caller, parsed.input));
			if (parsed.method === "workspace.launch.recover") return success(id, { workspace: await workspaces.recoverLaunch(caller, parsed.input) });
			if (parsed.method === "workspace.inspect") return success(id, { workspace: workspaces.inspect(caller, parsed.input.workspaceId) });
			if (parsed.method === "workspace.integration.inspect") return success(id, { integration: workspaces.inspectIntegration(caller, parsed.input.integrationId) });
			if (parsed.method === "workspace.retain") return success(id, { workspace: workspaces.retain(caller, parsed.input) });
			if (parsed.method === "workspace.reconcile") return success(id, { workspace: await workspaces.reconcile(caller, parsed.input) });
			if (parsed.method === "workspace.checkpoint") return success(id, { workspace: await workspaces.checkpoint(caller, parsed.input) });
			if (parsed.method === "workspace.integration.prepare") return success(id, { integration: await workspaces.prepareIntegration(caller, parsed.input) });
			if (parsed.method === "workspace.integration.reconcile") return success(id, { integration: await workspaces.reconcileIntegration(caller, parsed.input) });
			if (parsed.method === "workspace.integration.finalize") return success(id, { integration: await workspaces.finalizeIntegration(caller, parsed.input) });
			if (parsed.method === "workspace.cleanup") return success(id, { workspace: await workspaces.cleanupWorkspace(caller, parsed.input) });
			if (parsed.method === "workspace.integration.cleanup") return success(id, { integration: await workspaces.cleanupIntegration(caller, parsed.input) });
		}
		if (method === "bridge.register" || method === "bridge.reconnect") {
			if (!bridges) return failure(id, "capability_unavailable", "Runtime bridge registration is unavailable in this process.");
			const result = method === "bridge.register" ? await bridges.register(bridgeRegisterParams(params)) : await bridges.reconnect(bridgeReconnectParams(params));
			return success(id, bridgeRegistrationResult(result));
		}
		if (method === "bridge.launch.create") {
			if (!bridges) return failure(id, "capability_unavailable", "Runtime bridge launch authority is unavailable in this process.");
			const parsed = bridgeLaunchParams(params);
			const caller = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			return success(id, await bridges.create(caller, parsed.input));
		}
		if (method === "bridge.launch.recover") {
			if (!bridges) return failure(id, "capability_unavailable", "Runtime bridge launch authority is unavailable in this process.");
			const parsed = bridgeRecoverParams(params);
			const caller = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			return success(id, { launch: bridges.recoverLaunch(caller, parsed.input) });
		}
		if (method === "bridge.launch.cancel") {
			if (!bridges) return failure(id, "capability_unavailable", "Runtime bridge launch authority is unavailable in this process.");
			const parsed = bridgeCancelParams(params);
			const caller = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			bridges.cancel(caller, parsed.input);
			return success(id, { cancelled: true });
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
			return success(id, { ...registrationResult(registration), inboxReady: wakes.status(registration).pending > 0 });
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
		if (method === "inbox.submit_begin" || method === "inbox.submit_settle") {
			const input = strictObject(params, `${method} params`, ["registrationId", "registrationKey", "claimId", "eventIds", "attemptId", "outcome"]);
			const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
			const eventIds = boundedArray(input.eventIds, "event IDs", HOSTED_MAX_DELIVERY_BATCH).map((eventId) => boundedText(eventId, "event ID", 200));
			const attemptId = boundedText(input.attemptId, "submission attempt ID", 200);
			if (method === "inbox.submit_begin") wakes.submitBegin(registration, boundedText(input.claimId, "claim ID", 200), eventIds, attemptId);
			else {
				if (input.outcome !== "submitted" && input.outcome !== "pending" && input.outcome !== "needs_attention") throw new Error("managed submission outcome is invalid");
				wakes.submitSettle(registration, boundedText(input.claimId, "claim ID", 200), eventIds, attemptId, input.outcome);
			}
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
		if (method === "task.send" || method === "task.result" || method === "task.status") {
			if (!participants) return failure(id, "capability_unavailable", "Collaborator task methods are unavailable in this process.");
			const parsed = taskParams(params, method);
			const registration = registrations.authorize(parsed.registrationId, parsed.registrationKey);
			if (parsed.method === "task.send") {
				const event = participants.sendTask(registration, parsed.senderParticipantKey, parsed.expectedSenderGeneration, parsed.recipientParticipantKey, parsed.sendId, parsed.body);
				return success(id, { eventId: event.eventId, sequence: event.source.sequence });
			}
			if (parsed.method === "task.result") {
				const existing = participants.recoverTaskResult(registration, parsed.senderParticipantKey, parsed.expectedSenderGeneration, parsed.eventId, parsed.sendId, parsed.status, parsed.body, parsed.sessionAdvance);
				const publish = (workspace?: Awaited<ReturnType<RuntimeWorkspaceCoordinator["taskEvidence"]>>) => participants.resultTask(registration, parsed.senderParticipantKey, parsed.expectedSenderGeneration, parsed.eventId, parsed.sendId, parsed.status, parsed.body, parsed.sessionAdvance, workspace);
				const event = existing ?? (workspaces ? await workspaces.withTaskEvidence(registration.targetKey, publish) : publish());
				return success(id, { eventId: event.eventId, sequence: event.source.sequence, replyId: event.payload.replyId, workspace: event.payload.workspace });
			}
			return success(id, participants.taskStatus(registration, parsed.senderParticipantKey, parsed.expectedSenderGeneration, parsed.eventId));
		}
		if (method.startsWith("participant.") || method === "mailbox.send") {
			if (!participants) return failure(id, "capability_unavailable", "Collaborator mailbox methods are unavailable in this process.");
			if (method === "participant.auto_capacity.list") {
				const auth = authParams(params);
				return success(id, { reservations: participants.listAutoCapacity(registrations.authorize(auth.registrationId, auth.registrationKey)) });
			}
			if (method === "participant.auto_capacity.reserve") {
				const input = strictObject(params, "participant.auto_capacity.reserve params", ["registrationId", "registrationKey", "operationId", "protocol", "callerParticipantId", "expectedCallerGeneration", "participantIds"]);
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				const participantIds = boundedArray(input.participantIds, "Auto capacity participant IDs", 12).map((participantId) => participantName(participantId, "participant ID"));
				if (participantIds.length < 1 || new Set(participantIds).size !== participantIds.length) throw new Error("Auto capacity participant IDs must contain 1 to 12 unique items");
				return success(id, { reservation: participants.reserveAutoCapacity(registration, boundedText(input.operationId, "Auto capacity operation ID", 200), participantName(input.protocol, "protocol"), participantName(input.callerParticipantId, "caller participant ID"), input.expectedCallerGeneration === undefined ? undefined : boundedText(input.expectedCallerGeneration, "expected caller generation", 200), participantIds) });
			}
			if (method === "participant.auto_capacity.release") {
				const input = strictObject(params, "participant.auto_capacity.release params", ["registrationId", "registrationKey", "operationId"]);
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				participants.releaseAutoCapacity(registration, boundedText(input.operationId, "Auto capacity operation ID", 200));
				return success(id, { released: true });
			}
			if (method === "participant.auto_capacity.recover") {
				const input = strictObject(params, "participant.auto_capacity.recover params", ["registrationId", "registrationKey", "operationId", "confirmedAbsent"]);
				const confirmedAbsent = booleanValue(input.confirmedAbsent, "Auto capacity absence confirmation must be boolean");
				const registration = registrations.authorize(boundedText(input.registrationId, "registration ID", 200), boundedText(input.registrationKey, "registration key", 200));
				return success(id, participants.recoverAutoCapacity(registration, boundedText(input.operationId, "Auto capacity operation ID", 200), confirmedAbsent));
			}
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
		targets: { pi: { tier: "durable" }, "claude-code": { tier: "managed" }, codex: { tier: "managed" } },
		monitor: { maxEntries: HOSTED_MONITOR_MAX_ENTRIES },
	};
	if (context.degradedReason) Object.assign(capabilities, { degradedReason: context.degradedReason });
	if (context.participants) Object.assign(capabilities, { mailbox: { maxBodyBytes: HOSTED_MAILBOX_MAX_BODY_BYTES }, task: { typedResults: true, maxBodyBytes: HOSTED_MAILBOX_MAX_BODY_BYTES } });
	if (context.bridges) Object.assign(capabilities, { interactiveAgent: { launch: "single_use", reconnect: true, managedDelivery: ["pending", "submitting", "submitted", "needs_attention"] }, legacyBridge: { stopOnly: true } });
	if (context.workspaces) Object.assign(capabilities, { workspace: { isolatedWrite: true, stagedIntegration: true } });
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

function workspaceRegisterParams(value: JsonValue | undefined): RegisterWorkspacePiInput & { launchToken: string } {
	const params = strictObject(value, "workspace.pi.register params", ["launchToken", "piSessionId", "piSessionFile", "clientGeneration", "admittedClaims", "herdr"]);
	return { launchToken: boundedText(params.launchToken, "workspace launch token", 512), ...workspacePiRegistration(params) };
}

function workspaceReconnectParams(value: JsonValue | undefined): RegisterWorkspacePiInput & { workspaceId: string } {
	const params = strictObject(value, "workspace.pi.reconnect params", ["workspaceId", "piSessionId", "piSessionFile", "clientGeneration", "admittedClaims", "herdr"]);
	return { workspaceId: boundedText(params.workspaceId, "workspace ID", 200), ...workspacePiRegistration(params) };
}

function workspacePiRegistration(params: JsonObject): RegisterWorkspacePiInput {
	const host = strictObject(params.herdr, "workspace Pi Herdr identity", ["paneId", "terminalId", "agentName"]);
	const herdr: RegisterWorkspacePiInput["herdr"] = { paneId: boundedText(host.paneId, "Herdr pane ID", 200), terminalId: boundedText(host.terminalId, "Herdr terminal ID", 200) };
	if (host.agentName !== undefined) herdr.agentName = boundedText(host.agentName, "Herdr agent name", 200);
	return { piSessionId: boundedText(params.piSessionId, "Pi session ID", 200), piSessionFile: boundedText(params.piSessionFile, "Pi session file", 8 * 1024), clientGeneration: boundedText(params.clientGeneration, "client generation", 200), admittedClaims: admittedClaimParams(params.admittedClaims), herdr };
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

interface BridgeRecoverInput extends WorkspaceAuthority {
	requestId: string;
}

interface BridgeCancelInput extends WorkspaceAuthority {
	launchId: string;
}

type WorkspaceAuthorizedParams =
	| ({ method: "workspace.launch.create" } & AuthorizedParams<CreateWorkspaceInput>)
	| ({ method: "workspace.bridge.create" } & AuthorizedParams<CreateBridgeWorkspaceInput>)
	| ({ method: "workspace.launch.bind" } & AuthorizedParams<WorkspaceAuthority & { workspaceId: string; herdr: { paneId: string; terminalId: string } }>)
	| ({ method: "workspace.launch.recover" } & AuthorizedParams<WorkspaceAuthority & { requestId: string }>)
	| ({ method: "workspace.inspect" } & AuthorizedParams<{ workspaceId: string }>)
	| ({ method: "workspace.integration.inspect" } & AuthorizedParams<{ integrationId: string }>)
	| ({ method: "workspace.retain" | "workspace.reconcile" | "workspace.integration.prepare" } & AuthorizedParams<WorkspaceAuthority & { workspaceId: string }>)
	| ({ method: "workspace.checkpoint" } & AuthorizedParams<WorkspaceAuthority & { workspaceId: string; taskStatus?: "completed" | "failed" | "cancelled" }>)
	| ({ method: "workspace.integration.reconcile" | "workspace.integration.finalize" } & AuthorizedParams<WorkspaceAuthority & { integrationId: string }>)
	| ({ method: "workspace.cleanup" } & AuthorizedParams<WorkspaceAuthority & { workspaceId: string; discardConfirmed: boolean }>)
	| ({ method: "workspace.integration.cleanup" } & AuthorizedParams<WorkspaceAuthority & { integrationId: string; discardConfirmed: boolean }>);

function workspaceAuthorizedParams(value: JsonValue | undefined, method: string): WorkspaceAuthorizedParams {
	const params = strictObject(value, `${method} params`, workspaceAllowedFields(method));
	const registrationId = boundedText(params.registrationId, "registration ID", 200);
	const registrationKey = boundedText(params.registrationKey, "registration key", 200);
	if (method === "workspace.launch.create") {
		const input: CreateWorkspaceInput = { requestId: boundedText(params.requestId, "request ID", 200), callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200), expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200), protocol: participantName(params.protocol, "protocol"), participantId: participantName(params.participantId, "participant ID"), piSessionId: boundedText(params.piSessionId, "Pi session ID", 200) };
		if (params.expectedParticipantGeneration !== undefined) input.expectedParticipantGeneration = boundedText(params.expectedParticipantGeneration, "expected participant generation", 200);
		return { method, registrationId, registrationKey, input };
	}
	if (method === "workspace.bridge.create") {
		const input: CreateBridgeWorkspaceInput = { requestId: boundedText(params.requestId, "request ID", 200), callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200), expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200), protocol: participantName(params.protocol, "protocol"), participantId: participantName(params.participantId, "participant ID"), bridgeId: boundedText(params.bridgeId, "bridge ID", 200) };
		if (params.expectedParticipantGeneration !== undefined) input.expectedParticipantGeneration = boundedText(params.expectedParticipantGeneration, "expected participant generation", 200);
		return { method, registrationId, registrationKey, input };
	}
	if (method === "workspace.inspect") return { method, registrationId, registrationKey, input: { workspaceId: boundedText(params.workspaceId, "workspace ID", 200) } };
	if (method === "workspace.integration.inspect") return { method, registrationId, registrationKey, input: { integrationId: boundedText(params.integrationId, "integration ID", 200) } };
	const authority: WorkspaceAuthority = { callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200), expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200) };
	if (method === "workspace.launch.recover") return { method, registrationId, registrationKey, input: { ...authority, requestId: boundedText(params.requestId, "request ID", 200) } };
	if (method === "workspace.launch.bind") {
		const herdr = strictObject(params.herdr, "workspace launch Herdr identity", ["paneId", "terminalId"]);
		return { method, registrationId, registrationKey, input: { ...authority, workspaceId: boundedText(params.workspaceId, "workspace ID", 200), herdr: { paneId: boundedText(herdr.paneId, "Herdr pane ID", 200), terminalId: boundedText(herdr.terminalId, "Herdr terminal ID", 200) } } };
	}
	if (method === "workspace.retain" || method === "workspace.reconcile") return { method, registrationId, registrationKey, input: { ...authority, workspaceId: boundedText(params.workspaceId, "workspace ID", 200) } };
	if (method === "workspace.checkpoint") {
		if (params.taskStatus !== undefined && params.taskStatus !== "completed" && params.taskStatus !== "failed" && params.taskStatus !== "cancelled") throw new Error("invalid workspace task status");
		const input: Extract<WorkspaceAuthorizedParams, { method: "workspace.checkpoint" }>["input"] = { ...authority, workspaceId: boundedText(params.workspaceId, "workspace ID", 200) };
		if (params.taskStatus !== undefined) input.taskStatus = params.taskStatus;
		return { method, registrationId, registrationKey, input };
	}
	if (method === "workspace.integration.prepare") return { method, registrationId, registrationKey, input: { ...authority, workspaceId: boundedText(params.workspaceId, "workspace ID", 200) } };
	if (method === "workspace.integration.reconcile" || method === "workspace.integration.finalize") return { method, registrationId, registrationKey, input: { ...authority, integrationId: boundedText(params.integrationId, "integration ID", 200) } };
	if (method === "workspace.integration.cleanup") {
		if (params.discardConfirmed !== true && params.discardConfirmed !== false) throw new Error("integration discard confirmation must be boolean");
		return { method, registrationId, registrationKey, input: { ...authority, integrationId: boundedText(params.integrationId, "integration ID", 200), discardConfirmed: params.discardConfirmed } };
	}
	if (method !== "workspace.cleanup") throw new Error("unsupported workspace authority method");
	if (params.discardConfirmed !== true && params.discardConfirmed !== false) throw new Error("workspace discard confirmation must be boolean");
	return { method, registrationId, registrationKey, input: { ...authority, workspaceId: boundedText(params.workspaceId, "workspace ID", 200), discardConfirmed: params.discardConfirmed } };
}

function workspaceAllowedFields(method: string) {
	if (method === "workspace.launch.create") return ["registrationId", "registrationKey", "requestId", "callerParticipantKey", "expectedCallerGeneration", "protocol", "participantId", "expectedParticipantGeneration", "piSessionId"];
	if (method === "workspace.bridge.create") return ["registrationId", "registrationKey", "requestId", "callerParticipantKey", "expectedCallerGeneration", "protocol", "participantId", "expectedParticipantGeneration", "bridgeId"];
	if (method === "workspace.launch.bind") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "workspaceId", "herdr"];
	if (method === "workspace.launch.recover") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "requestId"];
	if (method === "workspace.inspect") return ["registrationId", "registrationKey", "workspaceId"];
	if (method === "workspace.integration.inspect") return ["registrationId", "registrationKey", "integrationId"];
	if (method === "workspace.retain" || method === "workspace.reconcile" || method === "workspace.integration.prepare") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "workspaceId"];
	if (method === "workspace.checkpoint") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "workspaceId", "taskStatus"];
	if (method === "workspace.integration.reconcile" || method === "workspace.integration.finalize") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "integrationId"];
	if (method === "workspace.cleanup") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "workspaceId", "discardConfirmed"];
	if (method === "workspace.integration.cleanup") return ["registrationId", "registrationKey", "callerParticipantKey", "expectedCallerGeneration", "integrationId", "discardConfirmed"];
	throw new Error("unsupported workspace authority method");
}

function bridgeLaunchParams(value: JsonValue | undefined): AuthorizedParams<CreateBridgeLaunchInput> {
	const params = strictObject(value, "bridge.launch.create params", ["registrationId", "registrationKey", "requestId", "launchId", "workspaceId", "callerParticipantKey", "expectedCallerGeneration", "protocol", "participantId", "expectedParticipantGeneration", "profile", "configurationHash", "driver", "herdr", "metadata"]);
	if (params.profile !== "read-only" && params.profile !== "workspace-write") throw new Error("bridge profile must be read-only or workspace-write");
	const herdr = strictObject(params.herdr, "bridge launch Herdr identity", ["paneId", "terminalId"]);
	const metadata = strictObject(params.metadata ?? {}, "bridge metadata");
	const metadataEntries = Object.entries(metadata);
	if (metadataEntries.length > HOSTED_BRIDGE_MAX_METADATA_ENTRIES) throw new Error(`bridge metadata may contain at most ${HOSTED_BRIDGE_MAX_METADATA_ENTRIES} entries`);
	const parsedMetadata = Object.fromEntries(metadataEntries.map(([key, item]) => {
		if (key !== "adapter") throw new Error("bridge metadata key is not allowlisted");
		if (!isText(item) || Buffer.byteLength(item) > HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES) throw new Error("bridge metadata value exceeds its byte limit");
		return [key, item];
	}));
	const input: CreateBridgeLaunchInput = {
		requestId: boundedText(params.requestId, "request ID", 200),
		callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200),
		expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200),
		protocol: participantName(params.protocol, "protocol"),
		participantId: participantName(params.participantId, "participant ID"),
		profile: params.profile,
		configurationHash: boundedText(params.configurationHash, "configuration hash", 64),
		herdr: { paneId: boundedText(herdr.paneId, "Herdr pane ID", 200), terminalId: boundedText(herdr.terminalId, "Herdr terminal ID", 200) },
		metadata: parsedMetadata,
	};
	if (params.launchId !== undefined) input.launchId = boundedText(params.launchId, "launch ID", 200);
	if (params.workspaceId !== undefined) input.workspaceId = boundedText(params.workspaceId, "workspace ID", 200);
	if (params.expectedParticipantGeneration !== undefined) input.expectedParticipantGeneration = boundedText(params.expectedParticipantGeneration, "expected participant generation", 200);
	if (params.driver !== undefined) input.driver = nativeDriver(params.driver);
	return { registrationId: boundedText(params.registrationId, "registration ID", 200), registrationKey: boundedText(params.registrationKey, "registration key", 200), input };
}

function bridgeRecoverParams(value: JsonValue | undefined): AuthorizedParams<BridgeRecoverInput> {
	const params = strictObject(value, "bridge.launch.recover params", ["registrationId", "registrationKey", "requestId", "callerParticipantKey", "expectedCallerGeneration"]);
	return { registrationId: boundedText(params.registrationId, "registration ID", 200), registrationKey: boundedText(params.registrationKey, "registration key", 200), input: { requestId: boundedText(params.requestId, "request ID", 200), callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200), expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200) } };
}

function bridgeCancelParams(value: JsonValue | undefined): AuthorizedParams<BridgeCancelInput> {
	const params = strictObject(value, "bridge.launch.cancel params", ["registrationId", "registrationKey", "launchId", "callerParticipantKey", "expectedCallerGeneration"]);
	return { registrationId: boundedText(params.registrationId, "registration ID", 200), registrationKey: boundedText(params.registrationKey, "registration key", 200), input: { launchId: boundedText(params.launchId, "launch ID", 200), callerParticipantKey: boundedText(params.callerParticipantKey, "caller participant key", 200), expectedCallerGeneration: boundedText(params.expectedCallerGeneration, "expected caller generation", 200) } };
}

function bridgeRegisterParams(value: JsonValue | undefined): BridgeRegisterInput {
	const params = strictObject(value, "bridge.register params", ["launchToken", "reconnectToken", "clientGeneration", "admittedClaims", "herdr", "agentSession"]);
	const input: BridgeRegisterInput = { launchToken: boundedText(params.launchToken, "bridge launch token", 512), reconnectToken: boundedText(params.reconnectToken, "bridge reconnect token", 200), clientGeneration: boundedText(params.clientGeneration, "client generation", 200), admittedClaims: admittedClaimParams(params.admittedClaims), herdr: bridgeRegistrationHerdr(params.herdr) };
	if (params.agentSession !== undefined) input.agentSession = agentSession(params.agentSession);
	return input;
}

function bridgeReconnectParams(value: JsonValue | undefined): BridgeReconnectInput {
	const params = strictObject(value, "bridge.reconnect params", ["targetKey", "reconnectToken", "clientGeneration", "admittedClaims", "herdr"]);
	return { targetKey: boundedText(params.targetKey, "bridge target key", 200), reconnectToken: boundedText(params.reconnectToken, "bridge reconnect token", 200), clientGeneration: boundedText(params.clientGeneration, "client generation", 200), admittedClaims: admittedClaimParams(params.admittedClaims), herdr: bridgeRegistrationHerdr(params.herdr) };
}

function nativeDriver(value: JsonValue | undefined): "claude-code" | "codex" {
	if (value !== "claude-code" && value !== "codex") throw new Error("native collaborator driver must be claude-code or codex");
	return value;
}

function agentSession(value: JsonValue | undefined): HostedAgentSessionIdentity {
	const session = strictObject(value, "interactive agent session", ["source", "agent", "kind", "value"]);
	if (session.kind !== "id" && session.kind !== "path") throw new Error("interactive agent session kind is invalid");
	return { source: boundedText(session.source, "agent session source", 200), agent: boundedText(session.agent, "agent session agent", 64), kind: session.kind, value: boundedText(session.value, "agent session value", 8 * 1024) };
}

function bridgeRegistrationHerdr(value: JsonValue | undefined): BridgeRegisterInput["herdr"] {
	const herdr = strictObject(value, "bridge registration Herdr identity", ["paneId", "terminalId"]);
	return { paneId: boundedText(herdr.paneId, "Herdr pane ID", 200), terminalId: boundedText(herdr.terminalId, "Herdr terminal ID", 200) };
}

function admittedClaimParams(value: JsonValue | undefined): Array<{ claimId: string; eventIds: string[] }> {
	return boundedArray(value, "admittedClaims", 12).map((item, index) => {
		const receipt = strictObject(item, `admittedClaims[${index}]`, ["claimId", "eventIds"]);
		const eventIds = boundedArray(receipt.eventIds, `admittedClaims[${index}].eventIds`, HOSTED_MAX_DELIVERY_BATCH).map((eventId) => boundedText(eventId, "event ID", 200));
		if (new Set(eventIds).size !== eventIds.length) throw new Error("Admitted claim event IDs must be unique.");
		return { claimId: boundedText(receipt.claimId, "claim ID", 200), eventIds };
	});
}

interface TaskAuthority extends RegistrationAuth {
	senderParticipantKey: string;
	expectedSenderGeneration: string;
}

interface TaskSendParams extends TaskAuthority {
	method: "task.send";
	recipientParticipantKey: string;
	sendId: string;
	body: string;
}

interface TaskResultParams extends TaskAuthority {
	method: "task.result";
	eventId: string;
	sendId: string;
	status: "completed" | "failed" | "cancelled";
	body: string;
	sessionAdvance: "none" | "committed";
}

interface TaskStatusParams extends TaskAuthority {
	method: "task.status";
	eventId: string;
}

type TaskParams = TaskSendParams | TaskResultParams | TaskStatusParams;

function taskParams(value: JsonValue | undefined, method: string): TaskParams {
	if (method !== "task.send" && method !== "task.result" && method !== "task.status") throw new Error("unsupported task method");
	const allowed = method === "task.send" ? ["registrationId", "registrationKey", "senderParticipantKey", "expectedSenderGeneration", "recipientParticipantKey", "sendId", "body"] : method === "task.result" ? ["registrationId", "registrationKey", "senderParticipantKey", "expectedSenderGeneration", "eventId", "sendId", "status", "body", "sessionAdvance"] : ["registrationId", "registrationKey", "senderParticipantKey", "expectedSenderGeneration", "eventId"];
	const params = strictObject(value, `${method} params`, allowed);
	const common: TaskAuthority = {
		registrationId: boundedText(params.registrationId, "registration ID", 200),
		registrationKey: boundedText(params.registrationKey, "registration key", 200),
		senderParticipantKey: boundedText(params.senderParticipantKey, "task sender key", 200),
		expectedSenderGeneration: boundedText(params.expectedSenderGeneration, "task sender generation", 200),
	};
	if (method === "task.send") return { method, ...common, recipientParticipantKey: boundedText(params.recipientParticipantKey, "task recipient key", 200), sendId: boundedText(params.sendId, "task send ID", 200), body: boundedText(params.body, "task body", HOSTED_MAILBOX_MAX_BODY_BYTES) };
	const eventId = boundedText(params.eventId, "task event ID", 200);
	if (method === "task.status") return { method, ...common, eventId };
	if (params.status !== "completed" && params.status !== "failed" && params.status !== "cancelled") throw new Error("task result status is invalid");
	if (params.sessionAdvance !== "none" && params.sessionAdvance !== "committed") throw new Error("task session advancement is invalid");
	return { method: "task.result", ...common, eventId, sendId: boundedText(params.sendId, "task result send ID", 200), status: params.status, body: boundedText(params.body, "task result body", HOSTED_MAILBOX_MAX_BODY_BYTES), sessionAdvance: params.sessionAdvance };
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

function workspaceRegistrationResult(result: Awaited<ReturnType<RuntimeWorkspaceCoordinator["register"]>>) {
	return { ...registrationResult(result.registration), workspaceId: result.workspace.workspaceId, projectRoot: result.workspace.projectRoot, workspaceRoot: result.workspace.worktreePath, participantKey: result.participantKey, holderGeneration: result.holderGeneration, participantGeneration: result.participantGeneration, participantState: result.participantState, protocol: result.protocol, participantId: result.participantId };
}

function bridgeRegistrationResult(result: Awaited<ReturnType<RuntimeBridgeCoordinator["register"]>>) {
	const value = { ...registrationResult(result.registration), participantKey: result.participantKey, holderGeneration: result.holderGeneration, profile: result.profile, configurationHash: result.configurationHash, projectRoot: result.projectRoot, cwd: result.cwd, metadata: result.metadata };
	if (result.driver) Object.assign(value, { driver: result.driver, capabilityTier: result.capabilityTier, agentSession: result.agentSession });
	if (result.workspaceId) Object.assign(value, { workspaceId: result.workspaceId });
	return value;
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

const HOSTED_METHODS = new Set(["pi.register", "pi.heartbeat", "pi.unregister", "bridge.launch.create", "bridge.launch.recover", "bridge.launch.cancel", "bridge.register", "bridge.reconnect", "bridge.heartbeat", "bridge.unregister", "workspace.launch.create", "workspace.bridge.create", "workspace.launch.bind", "workspace.launch.recover", "workspace.pi.register", "workspace.pi.reconnect", "workspace.inspect", "workspace.integration.inspect", "workspace.retain", "workspace.reconcile", "workspace.checkpoint", "workspace.integration.prepare", "workspace.integration.reconcile", "workspace.integration.finalize", "workspace.cleanup", "workspace.integration.cleanup", "monitor.create", "monitor.get", "monitor.delete", "wake.accept", "inbox.claim", "inbox.ack", "inbox.release", "inbox.submit_begin", "inbox.submit_settle", "inbox.status", "participant.auto_capacity.list", "participant.auto_capacity.reserve", "participant.auto_capacity.release", "participant.auto_capacity.recover", "participant.acquire", "participant.get", "participant.list", "participant.stand_down", "participant.stand_down_confirmed", "participant.stop_confirmed", "participant.release", "participant.takeover", "mailbox.send", "mailbox.status", "task.send", "task.result", "task.status"]);

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
