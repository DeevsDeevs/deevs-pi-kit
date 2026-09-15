import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import { isEnded, isHeld } from "./schemas/state.ts";
import type { MessagingClient } from "./messaging-client.ts";
import {
	auth,
	errorCode,
	findParticipant,
	parseAcquireResult,
	parseParticipant,
	strictObject,
	type LiveClientRegistration,
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ParticipantIdentity } from "./session-record.ts";

const USAGE = "Usage: /runtime [status|start|register|collaborate <protocol> <id>"
	+ "|participants|stand-down|leave|takeover <protocol> <id>|auto on|off]";

export interface RuntimeCommandServices {
	session: RuntimeSession;
	messaging: MessagingClient;
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
	["auto", runAuto],
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
	const auto = services.session.store.auto ? "; auto mode on" : "";
	ctx.ui.notify(`Runtime ${String(hello.runtimeId)}; Pi ${lease}${auto}.`, "info");
}

/** Auto mode is this session's standing confirmation for collaborator lifecycle changes inside its own project. */
function runAuto({ services, args, ctx }: RuntimeCommandInput): Promise<void> {
	const [setting, ...extra] = args;
	if ((setting !== "on" && setting !== "off") || extra.length) {
		throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime auto on|off");
	}
	if (setting === "on" && !ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Auto mode requires a trusted project.");
	services.session.store.persistAuto(setting === "on");
	const effect = setting === "on"
		? "collaborator starts, stand-downs, stops and worktree cleanups in this project run without confirmation."
		: "collaborator lifecycle changes ask for confirmation again.";
	ctx.ui.notify(`Runtime auto mode ${setting}: ${effect}`, "info");
	return Promise.resolve();
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
	if (isEnded(existing?.state)) {
		const detail = `Revive ${protocol}/${participantId} and make its queued mail deliverable?`;
		if (!await ctx.ui.confirm("Revive collaborator identity?", detail)) return;
	}
	const params = { ...auth(registration), protocol, participantId, revive: isEnded(existing?.state) };
	const result = parseAcquireResult(await session.client.call("participant.acquire", params));
	session.store.persistHeld(protocol, participantId, result.participant);
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
	const participants = await session.listParticipants(registration);
	const current = findParticipant(participants, identity.protocol, identity.participantId);
	if (!current || !isHeld(current.state) || current.holderTargetKey !== registration.targetKey) {
		throw new HostedRuntimeClientError("not_found", "Current collaborator identity has no recoverable durable participant key.");
	}
	session.store.persistHeld(identity.protocol, identity.participantId, current);
	return session.requireParticipantIdentity();
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
	session.store.persistHeld(protocol, participantId, participant);
	ctx.ui.notify(`Took over ${protocol}/${participantId}.`, "info");
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

