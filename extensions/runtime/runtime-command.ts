import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import { collaboratorName, resolveCollaboratorCandidate } from "./collaborator-policy.ts";
import type { CollaboratorService } from "./collaborators.ts";
import type { MessagingClient } from "./messaging-client.ts";
import {
	auth,
	errorCode,
	parseAcquireResult,
	parseParticipant,
	strictObject,
	text,
	type ClientParticipantStatus,
	type LiveClientRegistration,
	type RuntimeResponse,
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ParticipantIdentity } from "./session-record.ts";

const USAGE = "Usage: /runtime [status|start|register|monitor <directory>|monitor-delete|collaborate <protocol> <id>"
	+ "|collaborator-start <protocol> <id>|participants|stand-down|leave|takeover <protocol> <id>]";

export interface RuntimeCommandServices {
	session: RuntimeSession;
	messaging: MessagingClient;
	collaborators: CollaboratorService;
}

interface RuntimeCommandInput {
	services: RuntimeCommandServices;
	args: string[];
	ctx: ExtensionCommandContext;
}

type RuntimeCommandHandler = (input: RuntimeCommandInput) => Promise<void>;

const HANDLERS = new Map<string, RuntimeCommandHandler>([
	["status", runStatus],
	["start", runStart],
	["register", runRegister],
	["collaborate", runCollaborate],
	["participants", runParticipants],
	["stand-down", (input) => runRelinquish(input, "stand-down")],
	["leave", (input) => runRelinquish(input, "leave")],
	["takeover", runTakeover],
	["collaborator-start", runCollaboratorStart],
	["monitor", runMonitor],
	["monitor-delete", runMonitorDelete],
]);

/** Dispatches one /runtime subcommand and reports every failure as a typed notification. */
export async function runRuntimeCommand(services: RuntimeCommandServices, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const handler = HANDLERS.get(action);
	try {
		if (!handler) throw new HostedRuntimeClientError("invalid_request", USAGE);
		await handler({ services, args: rest, ctx });
	} catch (error) {
		ctx.ui.notify(`${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runStatus({ services, ctx }: RuntimeCommandInput): Promise<void> {
	const hello = strictObject(await services.session.client.hello(), "Runtime hello");
	const registration = services.session.liveRegistration;
	const lease = registration ? `registered until ${new Date(registration.leaseUntil).toISOString()}` : "not registered";
	ctx.ui.notify(`Runtime ${String(hello.runtimeId)} (${String(hello.epoch)}); Pi ${lease}.`, "info");
}

async function runStart({ services, ctx }: RuntimeCommandInput): Promise<void> {
	await services.session.start(ctx);
	await services.session.register(ctx);
	ctx.ui.notify("Runtime service started and this Pi session is registered.", "info");
}

async function runRegister({ services, ctx }: RuntimeCommandInput): Promise<void> {
	await services.session.register(ctx);
	ctx.ui.notify("This Pi session is registered with Runtime.", "info");
}

async function runCollaborate({ services, args, ctx }: RuntimeCommandInput): Promise<void> {
	const { protocol, participantId } = participantArguments(args, "Usage: /runtime collaborate <protocol> <participant-id>");
	const { session } = services;
	const registration = await session.requireRegistration(ctx);
	const existing = findParticipant(await session.listParticipants(registration), protocol, participantId);
	if (existing?.state === "ended") {
		const detail = `Revive ${protocol}/${participantId} and make its queued mail deliverable?`;
		if (!await ctx.ui.confirm("Revive collaborator identity?", detail)) return;
	}
	const params = { ...auth(registration), protocol, participantId, revive: existing?.state === "ended" };
	const result = parseAcquireResult(await session.client.call("participant.acquire", params));
	session.store.persistIdentity({
		protocol,
		participantId,
		participantKey: result.participant.participantKey,
		generation: result.participant.generation,
		disposition: "held",
	});
	await services.messaging.descriptor(ctx);
	ctx.ui.notify(`Collaborating as ${protocol}/${participantId}${result.revived ? " (revived)" : ""}.`, "info");
}

async function runParticipants({ services, ctx }: RuntimeCommandInput): Promise<void> {
	const registration = await services.session.requireRegistration(ctx);
	const participants = await services.session.listParticipants(registration);
	const lines = participants.map((participant) => {
		const live = participant.holderLive ? " (live)" : "";
		const driver = participant.driver ? `; ${participant.driver}` : "";
		return `${participant.protocol}/${participant.participantId}: ${participant.state}${live}${driver}`;
	});
	ctx.ui.notify(lines.length ? lines.join("\n") : "No Runtime collaborators.", "info");
}

async function runRelinquish({ services, ctx }: RuntimeCommandInput, action: "stand-down" | "leave"): Promise<void> {
	const { session } = services;
	const known = session.requireParticipantIdentity();
	const registration = await session.requireRegistration(ctx);
	const identity = known.participantKey ? known : await recoverParticipantKey(session, known, registration);
	if (action === "leave") {
		const detail = `End ${identity.protocol}/${identity.participantId}? New mail will be rejected until explicit revival.`;
		if (!await ctx.ui.confirm("End collaborator identity?", detail)) return;
	}
	const method = action === "stand-down" ? "participant.stand_down" : "participant.release";
	const params = { ...auth(registration), participantKey: identity.participantKey };
	const participant = parseParticipant(await session.client.call(method, params));
	session.store.persistIdentity({
		...identity,
		generation: participant.generation,
		disposition: action === "stand-down" ? "vacant" : "ended",
	});
	ctx.ui.notify(`${identity.protocol}/${identity.participantId} is now ${participant.state}.`, "info");
}

/** Recovers the durable key of an identity that only knows its own name. */
async function recoverParticipantKey(
	session: RuntimeSession,
	identity: ParticipantIdentity,
	registration: LiveClientRegistration,
): Promise<ParticipantIdentity> {
	const current = (await session.listParticipants(registration)).find((participant) =>
		participant.protocol === identity.protocol
		&& participant.participantId === identity.participantId
		&& participant.state === "held"
		&& participant.holderTargetKey === registration.targetKey);
	if (!current) throw new HostedRuntimeClientError("not_found", "Current collaborator identity has no recoverable durable participant key.");
	const recovered: ParticipantIdentity = {
		...identity,
		participantKey: current.participantKey,
		generation: current.generation,
		disposition: "held",
	};
	session.store.persistIdentity(recovered);
	return recovered;
}

async function runTakeover({ services, args, ctx }: RuntimeCommandInput): Promise<void> {
	const { protocol, participantId } = participantArguments(args, "Usage: /runtime takeover <protocol> <participant-id>");
	const { session } = services;
	const registration = await session.requireRegistration(ctx);
	const existing = findParticipant(await session.listParticipants(registration), protocol, participantId);
	if (!existing) throw new HostedRuntimeClientError("not_found", "Participant does not exist in this project.");
	const detail = `Take over ${protocol}/${participantId} generation ${existing.generation}? The current holder must be offline.`;
	if (!await ctx.ui.confirm("Take over collaborator identity?", detail)) return;
	const params = {
		...auth(registration),
		participantKey: existing.participantKey,
		expectedGeneration: existing.generation,
		confirmed: true,
	};
	const participant = parseParticipant(await session.client.call("participant.takeover", params));
	session.store.persistIdentity({
		protocol,
		participantId,
		participantKey: participant.participantKey,
		generation: participant.generation,
		disposition: "held",
	});
	ctx.ui.notify(`Took over ${protocol}/${participantId}.`, "info");
}

async function runCollaboratorStart({ services, args, ctx }: RuntimeCommandInput): Promise<void> {
	const [rawProtocol, rawParticipantId, rawModel, ...extra] = args;
	if (!rawProtocol || !rawParticipantId || extra.length) {
		throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime collaborator-start <protocol> <participant-id> [model]");
	}
	const protocol = collaboratorName(rawProtocol, "protocol");
	const participantId = collaboratorName(rawParticipantId, "participant ID");
	const candidate = resolveCollaboratorCandidate({ participantId: rawParticipantId, model: rawModel });
	await services.collaborators.startFromCommand(ctx, protocol, participantId, candidate);
}

async function runMonitor({ services, args, ctx }: RuntimeCommandInput): Promise<void> {
	if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Monitor creation requires a trusted project.");
	const directory = args.join(" ");
	if (!directory) throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime monitor <directory>");
	const registration = await services.session.requireRegistration(ctx);
	const params = { ...auth(registration), directory: resolve(ctx.cwd, directory), settleMs: 250 };
	const result = strictObject(await services.session.client.call("monitor.create", params), "Runtime Monitor");
	ctx.ui.notify(`Runtime Monitor active: ${text(result.monitorId)} (${text(result.status)})`, "info");
}

async function runMonitorDelete({ services, ctx }: RuntimeCommandInput): Promise<void> {
	const registration = await services.session.requireRegistration(ctx);
	const status = await services.session.client.call("monitor.get", auth(registration));
	const monitorId = monitorIdFromStatus(status);
	if (!monitorId) {
		ctx.ui.notify("No Runtime Monitor is configured for this session.", "info");
		return;
	}
	await services.session.client.call("monitor.delete", { ...auth(registration), monitorId });
	ctx.ui.notify("Runtime Monitor deleted; queued events were retained.", "info");
}

function monitorIdFromStatus(value: RuntimeResponse): string | undefined {
	const status = strictObject(value, "Runtime Monitor status");
	if (status.monitor === null) return undefined;
	return text(strictObject(status.monitor, "Runtime Monitor").monitorId);
}

interface ParticipantArguments {
	protocol: string;
	participantId: string;
}

function participantArguments(args: string[], usage: string): ParticipantArguments {
	const [protocol, participantId, ...extra] = args;
	if (!protocol || !participantId || extra.length) throw new HostedRuntimeClientError("invalid_request", usage);
	return { protocol, participantId };
}

function findParticipant(
	participants: ClientParticipantStatus[],
	protocol: string,
	participantId: string,
): ClientParticipantStatus | undefined {
	return participants.find((participant) => participant.protocol === protocol && participant.participantId === participantId);
}
