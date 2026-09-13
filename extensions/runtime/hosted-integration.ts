import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type MessageStartEvent,
	type SessionHeader,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import { markClaudeWorkspaceTrusted } from "./claude-trust.ts";
import {
	collaboratorConfiguration,
	collaboratorName,
	collaboratorToolBlock,
	READ_ONLY_COLLABORATOR_TOOLS,
	resolveCollaboratorCandidate,
	usesNativeUserConfiguration,
	WORKSPACE_WRITE_COLLABORATOR_TOOLS,
	type CollaboratorCandidate,
	type CollaboratorToolBlock,
	type ResolvedCollaboratorCandidate,
} from "./collaborator-policy.ts";
import {
	createCollaboratorTab,
	delay,
	HERDR_AGENT_START_CODES,
	isHerdrError,
	shellQuote,
	throwIfAborted,
	waitForHerdrPaneCwd,
	type CollaboratorTab,
} from "./herdr.ts";
import { HostedDelivery, type HostedClaimCustomMessage } from "./delivery.ts";
import { MessagingClient } from "./messaging-client.ts";
import { RuntimeSession, type HostedReceipt, type RuntimeSessionHooks } from "./runtime-session.ts";
import {
	COLLABORATOR_ENV,
	HOSTED_SESSION_ENTRY,
	HostedSessionStore,
	sameAgentSession,
	type CollaboratorLaunch,
	type CollaboratorPersona,
	type HostedSessionRecord,
	type ManagedAgentControl,
	type ManagedAgentSession,
	type ParticipantIdentity,
} from "./session-record.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile } from "./hosted-types.ts";
import {
	auth,
	booleanValue,
	errorCode,
	parseAcquireResult,
	parseHeartbeat,
	parseParticipant,
	parseRegistration,
	parseSerializedResponse,
	strictObject,
	text,
	type ClientParticipantStatus,
	type HostedHeartbeat,
	type LiveClientRegistration,
	type RuntimeResponse,
	type SerializedObject,
	type SerializedValue,
} from "./responses.ts";
import { nativeMessagingLaunch } from "./mcp/native.ts";
import { deriveAgentTargetKey } from "./service/state.ts";


interface BeforeAgentStartResult {
	message?: HostedClaimCustomMessage;
	systemPrompt?: string;
}

type CollaboratorManageAction = "start" | "stand_down" | "stop";

interface CollaboratorManageResult {
	participant: string;
	status: "started" | "stood_down" | "stopped" | "already_vacant" | "already_stopped" | "unmanaged" | "failed" | "declined" | "cancelled";
	paneId?: string;
	error?: string;
}

type CollaboratorWorktreeInput =
	| { action: "list" }
	| { action: "cleanup"; participantId: string };

interface ManagedAgentLaunch {
	protocol: string;
	participantId: string;
	agentName: string;
	targetKey: string;
	projectRoot: string;
	cwd: string;
	clientGeneration: string;
	driver: "claude-code" | "codex";
	profile: HostedCollaboratorProfile;
	tab: CollaboratorTab;
	agentSession: ManagedAgentSession;
	messagingConfigured: boolean;
}

interface AgentBindRequest {
	agentName: string;
	driver: "claude-code" | "codex";
	profile: HostedCollaboratorProfile;
	clientGeneration: string;
	protocol: string;
	participantId: string;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	expectedParticipantGeneration?: string;
}

interface BoundAgent {
	registration: LiveClientRegistration;
	participantKey: string;
	holderGeneration: string;
	driver: "claude-code" | "codex";
	profile: HostedCollaboratorProfile;
	projectRoot: string;
	cwd: string;
	agentSession: ManagedAgentSession;
}

interface ManagedAgentStatus {
	name: string;
	paneId: string;
	terminalId: string;
	status: "idle" | "working" | "blocked" | "done" | "unknown";
	focused: boolean;
	agentSession: ManagedAgentSession;
}

class HostedCollaboratorStartError extends HostedRuntimeClientError {
	readonly childMayBeLive: boolean;

	constructor(code: string, message: string, childMayBeLive: boolean) {
		super(code, message);
		this.childMayBeLive = childMayBeLive;
	}
}

export class HostedRuntimeIntegration implements RuntimeSessionHooks {
	private readonly pi: ExtensionAPI;
	private readonly root: string;
	private readonly client: HostedRuntimeClient;
	private readonly store: HostedSessionStore;
	private readonly session: RuntimeSession;
	private readonly delivery: HostedDelivery;
	private readonly messaging: MessagingClient;
	private readonly managedAgentRegistrations = new Map<string, LiveClientRegistration>();
	private readonly managedAgentLaunches = new Set<string>();
	private managedAgentHeartbeatActive = false;
	private collaboratorManageActive = false;
	private readonly trustClaudeWorkspace: (cwd: string) => void;

	constructor(pi: ExtensionAPI, root = defaultRuntimeRoot(), trustClaudeWorkspace: (cwd: string) => void = markClaudeWorkspaceTrusted) {
		this.pi = pi;
		this.root = root;
		this.store = new HostedSessionStore(pi);
		this.session = new RuntimeSession(pi, root, this.store, this);
		this.client = this.session.client;
		this.delivery = new HostedDelivery(this.session);
		this.messaging = new MessagingClient(this.session);
		this.trustClaudeWorkspace = trustClaudeWorkspace;
	}

	sessionStart(ctx: ExtensionContext): Promise<void> {
		return this.session.sessionStart(ctx);
	}

	sessionTree(ctx: ExtensionContext): void {
		this.session.sessionTree(ctx);
	}

	sessionCompact(ctx: ExtensionContext): void {
		this.session.sessionCompact(ctx);
	}

	sessionShutdown(): Promise<void> {
		return this.session.sessionShutdown();
	}

	acceptWake(args: string, ctx: ExtensionCommandContext): Promise<void> {
		return this.delivery.acceptWake(args, ctx);
	}

	acknowledgeMessage(message: MessageStartEvent["message"]): void {
		this.delivery.acknowledgeMessage(message);
	}

	messagingDescriptor(ctx: ExtensionContext): Promise<string> {
		return this.messaging.descriptor(ctx);
	}

	async beforeAgentStart(systemPrompt: string, ctx: ExtensionContext): Promise<BeforeAgentStartResult | undefined> {
		this.session.setContext(ctx);
		if (!this.session.isActive) return undefined;
		const current = this.session.scope(ctx);
		const result: BeforeAgentStartResult = {};
		const persona = this.store.launch?.persona;
		if (persona) result.systemPrompt = `${systemPrompt}\n\n# Collaborator persona: ${persona.name}\n\n${persona.prompt}`;
		let registration: LiveClientRegistration;
		try { registration = await this.session.requireRegistration(ctx); } catch { return personaOnly(result); }
		if (!current()) return undefined;
		const claim = await this.delivery.claimForTurn(registration, current);
		switch (claim.status) {
			case "none": return personaOnly(result);
			case "stale": return undefined;
			case "claimed": {
				result.message = claim.message;
				return result;
			}
			default: {
				const unreachable: never = claim;
				return unreachable;
			}
		}
	}

	restoreSessionState(ctx: ExtensionContext): void {
		this.managedAgentRegistrations.clear();
		this.messaging.clearManagedIssuance();
		this.store.restore(ctx);
		this.delivery.restoreAdmissions(ctx);
	}

	admittedClaims(): HostedReceipt[] {
		return this.delivery.admittedClaims();
	}

	clearPendingAcks(): void {
		this.delivery.clearPendingAcks();
	}

	async afterRegister(registration: LiveClientRegistration, _ctx: ExtensionContext, current: () => boolean): Promise<void> {
		if (this.store.identity?.disposition === "held") await this.messaging.provision(registration, current);
	}

	async afterHeartbeat(registration: LiveClientRegistration, ctx: ExtensionContext, heartbeat: HostedHeartbeat, current: () => boolean): Promise<void> {
		await this.delivery.retryAdmissions(registration);
		this.session.requireCurrentScope(current);
		if (heartbeat.inboxReady) await this.delivery.admitHeartbeatInbox(registration, ctx);
		this.session.requireCurrentScope(current);
		this.messaging.offerMailHint(registration, ctx, heartbeat.mail);
	}

	async afterHeartbeatSettled(): Promise<void> {
		await this.heartbeatManagedAgents();
	}

	guardCollaboratorTool(toolName: string, input: ToolCallEvent["input"] | undefined, cwd: string): CollaboratorToolBlock | undefined {
		const configuredProfile = this.store.launch?.profile;
		if (!configuredProfile) return undefined;
		const path = input && "path" in input ? input.path : undefined;
		return collaboratorToolBlock(this.effectiveCollaboratorProfile(configuredProfile), toolName, path, cwd);
	}

	/** A workspace-write collaborator falls back to read-only until its worktree and held identity are both proven. */
	private effectiveCollaboratorProfile(configured: HostedCollaboratorProfile): HostedCollaboratorProfile {
		if (configured !== "workspace-write") return configured;
		if (!this.store.worktree) return "read-only";
		return this.store.identity?.disposition === "held" ? "workspace-write" : "read-only";
	}

	async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		try {
			if (action === "start") {
				await this.session.start(ctx);
				await this.session.register(ctx);
				ctx.ui.notify("Runtime service started and this Pi session is registered.", "info");
				return;
			}
			if (action === "register") {
				await this.session.register(ctx);
				ctx.ui.notify("This Pi session is registered with Runtime.", "info");
				return;
			}
			if (action === "collaborate") {
				const [protocol, participantId, ...extra] = rest;
				if (!protocol || !participantId || extra.length) throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime collaborate <protocol> <participant-id>");
				const registration = await this.session.requireRegistration(ctx);
				const existing = (await this.session.listParticipants(registration)).find((participant) => participant.protocol === protocol && participant.participantId === participantId);
				if (existing?.state === "ended" && !await ctx.ui.confirm("Revive collaborator identity?", `Revive ${protocol}/${participantId} and make its queued mail deliverable?`)) return;
				const result = parseAcquireResult(await this.client.call("participant.acquire", { ...auth(registration), protocol, participantId, revive: existing?.state === "ended" }));
				this.store.persistIdentity({ protocol, participantId, participantKey: result.participant.participantKey, generation: result.participant.generation, disposition: "held" });
				await this.messagingDescriptor(ctx);
				ctx.ui.notify(`Collaborating as ${protocol}/${participantId}${result.revived ? " (revived)" : ""}.`, "info");
				return;
			}
			if (action === "participants") {
				const registration = await this.session.requireRegistration(ctx);
				const participants = await this.session.listParticipants(registration);
				ctx.ui.notify(participants.length ? participants.map((participant) => `${participant.protocol}/${participant.participantId}: ${participant.state}${participant.holderLive ? " (live)" : ""}${participant.driver ? `; ${participant.driver}` : ""}`).join("\n") : "No Runtime collaborators.", "info");
				return;
			}
			if (action === "stand-down" || action === "leave") {
				let identity = this.session.requireParticipantIdentity();
				const registration = await this.session.requireRegistration(ctx);
				if (!identity.participantKey) {
					const current = (await this.session.listParticipants(registration)).find((participant) => participant.protocol === identity.protocol && participant.participantId === identity.participantId && participant.state === "held" && participant.holderTargetKey === registration.targetKey);
					if (!current) throw new HostedRuntimeClientError("not_found", "Current collaborator identity has no recoverable durable participant key.");
					identity = { ...identity, participantKey: current.participantKey, generation: current.generation, disposition: "held" };
					this.store.persistIdentity(identity);
				}
				if (action === "leave" && !await ctx.ui.confirm("End collaborator identity?", `End ${identity.protocol}/${identity.participantId}? New mail will be rejected until explicit revival.`)) return;
				const method = action === "stand-down" ? "participant.stand_down" : "participant.release";
				const participant = parseParticipant(await this.client.call(method, { ...auth(registration), participantKey: identity.participantKey }));
				this.store.persistIdentity({ ...identity, generation: participant.generation, disposition: action === "stand-down" ? "vacant" : "ended" });
				ctx.ui.notify(`${identity.protocol}/${identity.participantId} is now ${participant.state}.`, "info");
				return;
			}
			if (action === "takeover") {
				const [protocol, participantId, ...extra] = rest;
				if (!protocol || !participantId || extra.length) throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime takeover <protocol> <participant-id>");
				const registration = await this.session.requireRegistration(ctx);
				const existing = (await this.session.listParticipants(registration)).find((participant) => participant.protocol === protocol && participant.participantId === participantId);
				if (!existing) throw new HostedRuntimeClientError("not_found", "Participant does not exist in this project.");
				if (!await ctx.ui.confirm("Take over collaborator identity?", `Take over ${protocol}/${participantId} generation ${existing.generation}? The current holder must be offline.`)) return;
				const participant = parseParticipant(await this.client.call("participant.takeover", { ...auth(registration), participantKey: existing.participantKey, expectedGeneration: existing.generation, confirmed: true }));
				this.store.persistIdentity({ protocol, participantId, participantKey: participant.participantKey, generation: participant.generation, disposition: "held" });
				ctx.ui.notify(`Took over ${protocol}/${participantId}.`, "info");
				return;
			}
			if (action === "collaborator-start") {
				const [rawProtocol, rawParticipantId, rawModel, ...extra] = rest;
				if (!rawProtocol || !rawParticipantId || extra.length) throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime collaborator-start <protocol> <participant-id> [model]");
				await this.startCommandCollaborator(ctx, collaboratorName(rawProtocol, "protocol"), collaboratorName(rawParticipantId, "participant ID"), resolveCollaboratorCandidate({ participantId: rawParticipantId, model: rawModel }));
				return;
			}
			if (action === "monitor") {
				if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Monitor creation requires a trusted project.");
				const directory = rest.join(" ");
				if (!directory) throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime monitor <directory>");
				const registration = await this.session.requireRegistration(ctx);
				const result = await this.client.call("monitor.create", { ...auth(registration), directory: resolve(ctx.cwd, directory), settleMs: 250 });
				ctx.ui.notify(`Runtime Monitor active: ${monitorSummary(result)}`, "info");
				return;
			}
			if (action === "monitor-delete") {
				const registration = await this.session.requireRegistration(ctx);
				const status = await this.client.call("monitor.get", auth(registration));
				const monitorId = monitorIdFromStatus(status);
				if (!monitorId) {
					ctx.ui.notify("No Runtime Monitor is configured for this session.", "info");
					return;
				}
				await this.client.call("monitor.delete", { ...auth(registration), monitorId });
				ctx.ui.notify("Runtime Monitor deleted; queued events were retained.", "info");
				return;
			}
			if (action !== "status") throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime [status|start|register|monitor <directory>|monitor-delete|collaborate <protocol> <id>|collaborator-start <protocol> <id>|participants|stand-down|leave|takeover <protocol> <id>]");
			const hello = strictObject(await this.client.hello(), "Runtime hello");
			const registration = this.session.liveRegistration;
			ctx.ui.notify(`Runtime ${String(hello.runtimeId)} (${String(hello.epoch)}); Pi ${registration ? `registered until ${new Date(registration.leaseUntil).toISOString()}` : "not registered"}.`, "info");
		} catch (error) {
			ctx.ui.notify(`${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	async listCollaborators(ctx: ExtensionContext): Promise<ClientParticipantStatus[]> {
		return this.session.listParticipants(await this.session.requireRegistration(ctx));
	}

	async manageCollaborators(input: { action: CollaboratorManageAction; participants: CollaboratorCandidate[]; protocol?: string; callerParticipantId?: string }, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		if (input.participants.length < 1 || input.participants.length > 12) throw new HostedRuntimeClientError("invalid_request", "Collaborator management requires 1 to 12 participants.");
		if (input.action === "start") {
			if (input.participants.length === 1) {
				const candidate = input.participants[0]!;
				const result = await this.startCollaborator({ ...candidate, protocol: input.protocol, callerParticipantId: input.callerParticipantId }, ctx, signal);
				return [{ participant: result.participant, status: result.started ? "started" : "declined", paneId: result.paneId }];
			}
			const identity = this.session.requireParticipantIdentity();
			if (input.protocol && collaboratorName(input.protocol, "protocol") !== identity.protocol) throw new HostedRuntimeClientError("conflict", `Current collaborator identity uses protocol ${identity.protocol}.`);
			if (input.callerParticipantId && collaboratorName(input.callerParticipantId, "caller participant ID") !== identity.participantId) throw new HostedRuntimeClientError("conflict", `Current collaborator identity is ${identity.protocol}/${identity.participantId}.`);
			return this.startCollaborators(input.participants, ctx, signal);
		}
		if (input.callerParticipantId || input.participants.some((participant) => participant.driver !== undefined || participant.model !== undefined || participant.persona !== undefined || participant.profile !== undefined)) throw new HostedRuntimeClientError("invalid_request", "Only collaborator starts accept caller identity, driver, model, persona, or profile fields.");
		return this.changeCollaborators(input.action, input.protocol, input.participants, ctx, signal);
	}

	private async changeCollaborators(action: "stand_down" | "stop", requestedProtocol: string | undefined, candidates: CollaboratorCandidate[], ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		if (this.collaboratorManageActive) throw new HostedRuntimeClientError("busy", "Another collaborator lifecycle operation is already in progress.");
		this.collaboratorManageActive = true;
		try {
			throwIfAborted(signal);
			if (!ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Collaborator lifecycle confirmation requires an interactive Pi session.");
			if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator lifecycle changes require a trusted project.");
			const protocol = collaboratorName(requestedProtocol ?? this.store.identity?.protocol, "protocol");
			const participantIds = candidates.map((candidate) => collaboratorName(candidate.participantId, "participant ID"));
			if (new Set(participantIds).size !== participantIds.length) throw new HostedRuntimeClientError("conflict", "Collaborator participant IDs must be unique.");
			const registration = await this.session.requireRegistration(ctx);
			const participants = await this.session.listParticipants(registration);
			const targets = participantIds.map((participantId) => {
				const participant = participants.find((candidate) => candidate.protocol === protocol && candidate.participantId === participantId);
				if (!participant) throw new HostedRuntimeClientError("not_found", `No ${protocol}/${participantId} participant exists.`);
				if (participant.state === "ended") throw new HostedRuntimeClientError("conflict", `Participant ${protocol}/${participantId} has ended.`);
				return participant;
			});
			const actionable = action === "stand_down" ? targets.filter((participant) => participant.state === "held") : targets;
			const results = Array<CollaboratorManageResult>(targets.length);
			if (action === "stand_down") targets.forEach((participant, index) => {
				if (participant.state === "vacant") results[index] = { participant: `${protocol}/${participant.participantId}`, status: "already_vacant" };
			});
			if (actionable.length === 0) return results;
			const summary = actionable.map((participant) => `${protocol}/${participant.participantId}`).join("\n");
			const detail = action === "stand_down" ? "Vacate these collaborators and preserve their queued messages?" : "Vacate these collaborators, preserve queued messages, and terminate only their exact plugin-managed Herdr tabs?";
			if (!await ctx.ui.confirm(`${action === "stand_down" ? "Stand down" : "Stop"} Runtime collaborators?`, `${detail}\n\n${summary}`, { signal })) {
				targets.forEach((participant, index) => {
					if (!results[index]) results[index] = { participant: `${protocol}/${participant.participantId}`, status: "declined" };
				});
				return results;
			}
			let next = 0;
			const worker = async (): Promise<void> => {
				while (next < actionable.length) {
					if (signal?.aborted) return;
					const participant = actionable[next++]!;
					const index = targets.indexOf(participant);
					try {
						if (action === "stand_down") {
							const changed = parseParticipant(await this.client.call("participant.stand_down_confirmed", { ...auth(registration), participantKey: participant.participantKey, expectedGeneration: participant.generation, confirmed: true }));
							if (this.store.identity?.participantKey === changed.participantKey) this.store.persistIdentity({ ...this.store.identity, generation: changed.generation, disposition: "vacant" });
							results[index] = { participant: `${protocol}/${participant.participantId}`, status: "stood_down" };
						} else {
							const response = strictObject(await this.client.call("participant.stop_confirmed", { ...auth(registration), participantKey: participant.participantKey, expectedGeneration: participant.generation, confirmed: true }), "Collaborator stop result");
							const changed = parseParticipant(response.participant);
							const outcome = response.outcome;
							if (outcome !== "stopped" && outcome !== "already_stopped" && outcome !== "unmanaged") throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid collaborator stop outcome.");
							if (this.store.identity?.participantKey === changed.participantKey && changed.state === "vacant") this.store.persistIdentity({ ...this.store.identity, generation: changed.generation, disposition: "vacant" });
							const control = participant.holderTargetKey ? this.store.agent(participant.holderTargetKey) : undefined;
							if (control && outcome !== "unmanaged") {
								this.managedAgentRegistrations.delete(control.targetKey);
								this.store.persistAgent({ ...control, state: "stopped" });
							}
							results[index] = { participant: `${protocol}/${participant.participantId}`, status: outcome };
						}
					} catch (error) {
						results[index] = { participant: `${protocol}/${participant.participantId}`, status: signal?.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) };
					}
				}
			};
			const settled = await Promise.allSettled(Array.from({ length: Math.min(4, actionable.length) }, worker));
			const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (rejected) throw rejected.reason;
			targets.forEach((participant, index) => {
				if (!results[index]) results[index] = { participant: `${protocol}/${participant.participantId}`, status: "cancelled" };
			});
			return results;
		} finally {
			this.collaboratorManageActive = false;
		}
	}

	private async withCollaboratorStart<T>(operation: () => Promise<T>): Promise<T> {
		if (this.collaboratorManageActive) throw new HostedRuntimeClientError("busy", "Another collaborator lifecycle operation is already in progress.");
		this.collaboratorManageActive = true;
		try {
			return await operation();
		} finally {
			this.collaboratorManageActive = false;
		}
	}

	private async startCommandCollaborator(ctx: ExtensionContext, protocol: string, participantId: string, candidate: ResolvedCollaboratorCandidate): Promise<void> {
		await this.withCollaboratorStart(async () => this.launchCollaborator(ctx, protocol, participantId, true, undefined, undefined, candidate));
	}

	async startCollaborator(input: { participantId: string; protocol?: string; callerParticipantId?: string; driver?: HostedCollaboratorDriver; model?: string; persona?: string; profile?: HostedCollaboratorProfile }, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ started: boolean; participant: string; paneId?: string }> {
		return this.withCollaboratorStart(async () => this.startCollaboratorConfirmed(input, ctx, signal));
	}

	async startCollaborators(candidates: CollaboratorCandidate[], ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		return this.withCollaboratorStart(async () => {
			throwIfAborted(signal);
			if (candidates.length < 1 || candidates.length > 12) throw new HostedRuntimeClientError("invalid_request", "Batch collaborator start requires 1 to 12 candidates.");
			if (!ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start confirmation requires an interactive Pi session.");
			if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator start requires a trusted project.");
			if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires this Pi session to run inside Herdr.");
			const identity = this.session.requireParticipantIdentity();
			if (identity.disposition !== "held") throw new HostedRuntimeClientError("conflict", "Batch collaborator start requires this Pi session to hold its collaborator identity.");
			const normalized = candidates.map((candidate) => resolveCollaboratorCandidate(candidate));
			if (new Set(normalized.map((candidate) => candidate.participantId)).size !== normalized.length) throw new HostedRuntimeClientError("conflict", "Batch collaborator participant IDs must be unique.");
			if (normalized.some((candidate) => candidate.participantId === identity.participantId)) throw new HostedRuntimeClientError("conflict", "Caller and child collaborator identities must differ.");
			const registration = await this.session.requireRegistration(ctx);
			const participants = await this.session.listParticipants(registration);
			const caller = (identity.participantKey ? participants.find((participant) => participant.participantKey === identity.participantKey) : undefined)
				?? participants.find((participant) => participant.protocol === identity.protocol && participant.participantId === identity.participantId);
			const callerMatches = caller?.protocol === identity.protocol && caller.participantId === identity.participantId && caller.state === "held" && caller.holderTargetKey === registration.targetKey && caller.generation === identity.generation;
			if (!caller || !callerMatches) throw new HostedRuntimeClientError("conflict", `Current collaborator identity ${identity.protocol}/${identity.participantId} is not authoritatively held by this Pi target.`);
			for (const candidate of normalized) {
				const existing = participants.find((participant) => participant.protocol === identity.protocol && participant.participantId === candidate.participantId);
				if (existing?.state === "held") throw new HostedRuntimeClientError("conflict", `Participant ${identity.protocol}/${candidate.participantId} already has a holder.`);
				if (existing?.state === "ended") throw new HostedRuntimeClientError("conflict", `Ended collaborator ${identity.protocol}/${candidate.participantId} requires explicit revival.`);
			}
			const projectRoot = realpathSync(ctx.cwd);
			const summary = normalized.map((candidate) => { const prior = participants.find((participant) => participant.protocol === identity.protocol && participant.participantId === candidate.participantId); return `${identity.protocol}/${candidate.participantId} — ${collaboratorConfiguration(candidate)}, project ${projectRoot}, isolated worktree ${candidate.profile === "workspace-write" ? "yes" : "no"}, replace stood-down process ${prior?.state === "vacant" && prior.lastTransition.cause === "stand_down" ? "yes" : "no"}`; }).join("\n");
			const confirmed = await ctx.ui.confirm("Start Runtime collaborators?",  `As ${identity.protocol}/${identity.participantId}, start ${normalized.length} collaborators with concurrency up to 4 in no-focus Herdr tabs?\n\n${summary}`, { signal });
			throwIfAborted(signal);
			if (!confirmed) return normalized.map((candidate) => ({ participant: `${identity.protocol}/${candidate.participantId}`, status: "declined" }));
			const results = Array<CollaboratorManageResult>(normalized.length);
			let next = 0;
			const worker = async (): Promise<void> => {
				while (next < normalized.length) {
					if (signal?.aborted) return;
					const index = next++;
					const candidate = normalized[index]!;
					try {
						const paneId = await this.launchCollaborator(ctx, identity.protocol, candidate.participantId, false, signal, caller, candidate);
						results[index] = { participant: `${identity.protocol}/${candidate.participantId}`, status: "started", paneId };
					} catch (error) {
						results[index] = { participant: `${identity.protocol}/${candidate.participantId}`, status: signal?.aborted ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) };
					}
				}
			};
			const settled = await Promise.allSettled(Array.from({ length: Math.min(4, normalized.length) }, worker));
			const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (rejected) throw rejected.reason;
			normalized.forEach((candidate, index) => {
				if (!results[index]) results[index] = { participant: `${identity.protocol}/${candidate.participantId}`, status: "cancelled" };
			});
			return results;
		});
	}

	private async startCollaboratorConfirmed(input: { participantId: string; protocol?: string; callerParticipantId?: string; driver?: HostedCollaboratorDriver; model?: string; persona?: string; profile?: HostedCollaboratorProfile }, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<{ started: boolean; participant: string; paneId?: string }> {
		throwIfAborted(signal);
		if (!ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start confirmation requires an interactive Pi session.");
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator start requires a trusted project.");
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires this Pi session to run inside Herdr.");
		const identity = this.store.identity;
		if (identity?.disposition === "ended") throw new HostedRuntimeClientError("conflict", "Current collaborator identity has ended; explicit revival is required.");
		const protocol = collaboratorName(identity?.protocol ?? input.protocol, "protocol");
		const callerParticipantId = collaboratorName(identity?.participantId ?? input.callerParticipantId, "caller participant ID");
		const candidate = resolveCollaboratorCandidate(input);
		const nativeConfirmation = usesNativeUserConfiguration(candidate);
		if (nativeConfirmation && !ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Normal native configuration requires explicit interactive confirmation.");
		const participantId = candidate.participantId;
		if (identity && ((input.protocol && input.protocol !== protocol) || (input.callerParticipantId && input.callerParticipantId !== callerParticipantId))) throw new HostedRuntimeClientError("conflict", `Current collaborator identity is ${protocol}/${callerParticipantId}.`);
		if (participantId === callerParticipantId) throw new HostedRuntimeClientError("conflict", "Caller and child collaborator identities must differ.");
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		throwIfAborted(signal);
		const caller = (identity?.participantKey ? participants.find((participant) => participant.participantKey === identity.participantKey) : undefined)
			?? participants.find((participant) => participant.protocol === protocol && participant.participantId === callerParticipantId);
		const identityMatches = caller?.protocol === protocol && caller.participantId === callerParticipantId;
		if (identity && caller && !identityMatches) {
			this.store.persistIdentity({ protocol, participantId: callerParticipantId, disposition: "vacant" });
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity key does not match its protocol and participant ID.");
		}
		if (caller?.state === "ended") {
			this.store.persistIdentity({ protocol, participantId: callerParticipantId, participantKey: caller.participantKey, generation: caller.generation, disposition: "ended" });
			throw new HostedRuntimeClientError("conflict", "Ended caller identities require explicit /runtime collaborate revival.");
		}
		let expectedCaller: ClientParticipantStatus | undefined;
		if (caller?.state === "held") {
			if (!identityMatches || caller.holderTargetKey !== registration.targetKey) throw new HostedRuntimeClientError("conflict", `Current collaborator identity ${protocol}/${callerParticipantId} is held by another Pi target.`);
			expectedCaller = caller;
			if (identity?.disposition !== "held" || identity.participantKey !== caller.participantKey || identity.generation !== caller.generation) this.store.persistIdentity({ protocol, participantId: callerParticipantId, participantKey: caller.participantKey, generation: caller.generation, disposition: "held" });
		} else if (identity?.disposition === "held") {
			this.store.persistIdentity(identityMatches && caller
				? { protocol, participantId: callerParticipantId, participantKey: caller.participantKey, generation: caller.generation, disposition: "vacant" }
				: { protocol, participantId: callerParticipantId, disposition: "vacant" });
			throw new HostedRuntimeClientError("conflict", `Current collaborator identity ${protocol}/${callerParticipantId} is not held by this Pi target.`);
		}
		const child = participants.find((participant) => participant.protocol === protocol && participant.participantId === participantId);
		if (child?.state === "held") throw new HostedRuntimeClientError("conflict", "Participant already has a holder.");
		if (child?.state === "ended") throw new HostedRuntimeClientError("conflict", "Ended collaborator identities require explicit /runtime collaborator-start revival.");
		const callerAction = expectedCaller ? `As ${protocol}/${callerParticipantId}, start` : identity ? `Reacquire ${protocol}/${callerParticipantId} and start` : `Acquire ${protocol}/${callerParticipantId} and start`;
		const participantName = `${protocol}/${participantId}`;
		const projectRoot = realpathSync(ctx.cwd);
		const replacesStoodDown = child?.state === "vacant" && child.lastTransition.cause === "stand_down";
		const confirmed = await ctx.ui.confirm("Start Runtime collaborator?",  `${callerAction} ${participantName} using ${collaboratorConfiguration(candidate)}, project ${projectRoot}, isolated worktree ${candidate.profile === "workspace-write" ? "yes" : "no"}${replacesStoodDown ? ", replacing its exact stood-down process" : ""}, in a no-focus Herdr tab?`, { signal });
		throwIfAborted(signal);
		if (!confirmed) return { started: false, participant: participantName };
		let acquiredCaller: ParticipantIdentity | undefined;
		let rollbackCaller = false;
		try {
			let launchCaller = expectedCaller;
			if (!expectedCaller) {
				const acquired = parseAcquireResult(await this.client.call("participant.acquire", { ...auth(registration), protocol, participantId: callerParticipantId, revive: false }));
				acquiredCaller = { protocol, participantId: callerParticipantId, participantKey: acquired.participant.participantKey, generation: acquired.participant.generation, disposition: "held" };
				rollbackCaller = acquired.transitioned;
				launchCaller = acquired.participant;
				this.store.persistIdentity(acquiredCaller);
				throwIfAborted(signal);
			}
			const paneId = await this.launchCollaborator(ctx, protocol, participantId, false, signal, launchCaller, candidate);
			return { started: true, participant: participantName, paneId };
		} catch (error) {
			const childMayBeLive = error instanceof HostedCollaboratorStartError && error.childMayBeLive;
			if (acquiredCaller?.participantKey && rollbackCaller && !childMayBeLive) {
				try {
					const participant = parseParticipant(await this.client.call("participant.stand_down", { ...auth(registration), participantKey: acquiredCaller.participantKey, expectedGeneration: acquiredCaller.generation }));
					this.store.persistIdentity({ ...acquiredCaller, generation: participant.generation, disposition: "vacant" });
				} catch (rollbackError) {
					throw new HostedRuntimeClientError("internal", `Collaborator launch failed and caller rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
				}
			}
			throw error;
		}
	}

	async manageWorktrees(input: CollaboratorWorktreeInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<SerializedValue> {
		throwIfAborted(signal);
		const identity = this.session.requireParticipantIdentity();
		if (identity.disposition !== "held" || !identity.participantKey || !identity.generation) throw new HostedRuntimeClientError("conflict", "Current collaborator identity is not authoritatively held.");
		const registration = await this.session.requireRegistration(ctx);
		if (input.action === "list") return parseSerializedResponse(await this.client.call("worktree.list", auth(registration)), "Worktree listing");
		if (!ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Worktree cleanup requires an interactive trusted Pi session.");
		const participantId = collaboratorName(input.participantId, "participant ID");
		const detail = `Force-remove the worktree of ${identity.protocol}/${participantId} and delete branch runtime/collab/${participantId}? Uncommitted or unmerged work in it is lost.`;
		if (!await ctx.ui.confirm("Remove collaborator worktree?", detail, { signal })) return { declined: true };
		const params = { ...auth(registration), callerParticipantKey: identity.participantKey, expectedCallerGeneration: identity.generation, protocol: identity.protocol, participantId, discardConfirmed: true };
		return parseSerializedResponse(await this.client.call("worktree.remove", params), "Worktree removal");
	}

	private async launchCollaborator(ctx: ExtensionContext, protocol: string, participantId: string, allowRevive: boolean, signal: AbortSignal | undefined, expectedCaller: ClientParticipantStatus | undefined, candidate: ResolvedCollaboratorCandidate, terminateAmbiguous = false): Promise<string | undefined> {
		throwIfAborted(signal);
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires this Pi session to run inside Herdr.");
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator start requires a trusted project.");
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		if (expectedCaller) {
			const caller = participants.find((participant) => participant.participantKey === expectedCaller.participantKey);
			const unchanged = caller?.protocol === expectedCaller.protocol && caller.participantId === expectedCaller.participantId && caller.state === "held" && caller.holderTargetKey === registration.targetKey && caller.generation === expectedCaller.generation;
			if (!caller || !unchanged) {
				this.store.persistIdentity(caller && caller.protocol === expectedCaller.protocol && caller.participantId === expectedCaller.participantId
					? { protocol: caller.protocol, participantId: caller.participantId, participantKey: caller.participantKey, generation: caller.generation, disposition: caller.state === "ended" ? "ended" : caller.state === "held" && caller.holderTargetKey === registration.targetKey ? "held" : "vacant" }
					: { protocol: expectedCaller.protocol, participantId: expectedCaller.participantId, disposition: "vacant" });
				throw new HostedRuntimeClientError("conflict", `Caller identity ${expectedCaller.protocol}/${expectedCaller.participantId} changed while launch confirmation was pending.`);
			}
		}
		const existing = participants.find((participant) => participant.protocol === protocol && participant.participantId === participantId);
		throwIfAborted(signal);
		if (existing?.state === "held") throw new HostedRuntimeClientError("conflict", "Participant already has a holder.");
		if (existing?.state === "ended") {
			if (!allowRevive) throw new HostedRuntimeClientError("conflict", "Ended collaborator identities require explicit /runtime collaborator-start revival.");
			if (!await ctx.ui.confirm("Revive collaborator identity?", `Start a ${candidate.driver} collaborator and revive ${protocol}/${participantId}?`)) return undefined;
		}
		if (existing?.state === "vacant" && existing.lastTransition.cause === "stand_down") {
			const stopped = strictObject(await this.client.call("participant.stop_confirmed", { ...auth(registration), participantKey: existing.participantKey, expectedGeneration: existing.generation, confirmed: true }), "Stood-down collaborator replacement");
			if (stopped.outcome !== "stopped" && stopped.outcome !== "already_stopped") throw new HostedRuntimeClientError("conflict", "The exact stood-down collaborator process could not be replaced safely.");
		}
		if (candidate.driver !== "pi") {
			return this.launchBridgeCollaborator(ctx, protocol, participantId, signal, expectedCaller, candidate, existing);
		}
		const bootstrap = `${protocol}:${participantId}${existing?.state === "ended" ? ":revive" : ""}`;
		const sessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const projectRoot = realpathSync(ctx.cwd);
		const worktreePath = candidate.profile === "workspace-write" ? await this.ensureWorktree(registration, protocol, participantId, expectedCaller) : undefined;
		const launchCwd = worktreePath ?? projectRoot;
		const targetKey = `pi_${createHash("sha256").update(projectRoot).update("\0").update(sessionId).digest("hex")}`;
		const sessionFile = this.createCollaboratorSession(projectRoot, launchCwd, sessionId, timestamp, piCollaboratorLaunch(candidate));
		let tabId: string | undefined;
		let paneId: string | undefined;
		let tabCreated = false;
		let childMayBeLive = false;
		try {
			throwIfAborted(signal);
			const createArgs = ["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID, "--cwd", launchCwd, "--label", `collaborator:${participantId}`, "--env", `${COLLABORATOR_ENV}=${bootstrap}`, "--no-focus"];
			const created = await this.pi.exec("herdr", createArgs, { timeout: 5_000 });
			if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the collaborator tab.");
			tabCreated = true;
			const result = strictObject(strictObject(JSON.parse(created.stdout), "Herdr response").result, "Herdr result");
			const rootPane = strictObject(result.root_pane, "Herdr root pane");
			try { paneId = text(rootPane.pane_id); } catch {}
			try { tabId = text(strictObject(result.tab, "Herdr tab").tab_id); } catch {}
			if (!paneId || !tabId) throw new HostedRuntimeClientError("invalid_response", "Herdr did not return the created collaborator tab and root pane IDs.");
			throwIfAborted(signal);
			childMayBeLive = true;
			const profileTools = candidate.profile === "read-only" ? READ_ONLY_COLLABORATOR_TOOLS : candidate.profile === "workspace-write" ? WORKSPACE_WRITE_COLLABORATOR_TOOLS : undefined;
			const command = `exec pi --approve --session ${shellQuote(sessionFile)}${profileTools ? ` --tools ${shellQuote(profileTools.join(","))}` : ""}${candidate.model ? ` --model ${shellQuote(candidate.model)}` : ""}`;
			const started = await this.pi.exec("herdr", ["pane", "run", paneId, command], { timeout: 5_000 });
			if (started.code !== 0) throw new HostedRuntimeClientError("host_unavailable", `Herdr could not dispatch Pi collaborator startup in ${paneId}; its tab and session were preserved.`);
			throwIfAborted(signal);
			for (let attempt = 0; attempt < 150; attempt++) {
				throwIfAborted(signal);
				let participant: ClientParticipantStatus | undefined;
				try {
					participant = (await this.session.listParticipants(registration)).find((candidate) => candidate.protocol === protocol && candidate.participantId === participantId);
				} catch (error) {
					throw new HostedRuntimeClientError("unavailable", `Collaborator identity handshake became unavailable after Pi started in ${paneId}; its tab and session were preserved: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (participant?.state === "held" && participant.holderLive && participant.holderTargetKey === targetKey && participant.generation !== existing?.generation) {
					ctx.ui.notify(`Collaborator ${protocol}/${participantId} started in ${paneId}.`, "info");
					return paneId;
				}
				await delay(100);
			}
			throw new HostedRuntimeClientError("unavailable", `Pi started in ${paneId}, but its identity handshake did not settle; the tab and session were preserved for recovery.`);
		} catch (error) {
			if (childMayBeLive && terminateAmbiguous) {
				try {
					await this.cleanupFailedCollaborator(tabId, paneId, sessionFile);
					childMayBeLive = false;
					tabId = undefined;
					paneId = undefined;
					tabCreated = false;
				} catch (cleanupError) {
					throw new HostedCollaboratorStartError("host_unavailable", `Ambiguous collaborator startup could not be terminated; its recovery artifacts were preserved: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, true);
				}
			}
			if (childMayBeLive) throw new HostedCollaboratorStartError(errorCode(error), error instanceof Error ? error.message : String(error), true);
			if (tabCreated && !tabId && !paneId) throw new HostedCollaboratorStartError("invalid_response", `Herdr created collaborator resources without returning an authoritative tab or pane ID; session ${sessionFile} was preserved for recovery.`, false);
			throw error;
		} finally {
			if (!childMayBeLive && (tabId || paneId || !tabCreated)) await this.cleanupFailedCollaborator(tabId, paneId, sessionFile);
		}
	}

	private async launchBridgeCollaborator(
		ctx: ExtensionContext,
		protocol: string,
		participantId: string,
		signal: AbortSignal | undefined,
		expectedCaller: ClientParticipantStatus | undefined,
		candidate: ResolvedCollaboratorCandidate,
		existing: ClientParticipantStatus | undefined,
	): Promise<string> {
		if (!expectedCaller || candidate.driver === "pi" || !candidate.profile) {
			throw new HostedRuntimeClientError("conflict", "Native launch requires a held caller and a resolved profile.");
		}
		const registration = await this.session.requireRegistration(ctx);
		const projectRoot = realpathSync(ctx.cwd);
		const agentName = managedAgentName(protocol, participantId);
		const targetKey = deriveAgentTargetKey(projectRoot, agentName);
		const clientGeneration = `agent_client_${randomUUID()}`;
		const identity = this.store.identity;
		const scope = this.session.scope(ctx, registration);
		const current = () => scope() && this.store.identity === identity;
		let messaging: ReturnType<typeof nativeMessagingLaunch> | undefined;
		let tabId: string | undefined;
		let paneId: string | undefined;
		let childMayBeLive = false;
		this.managedAgentLaunches.add(targetKey);
		try {
			const worktreePath = candidate.profile === "workspace-write" ? await this.ensureWorktree(registration, protocol, participantId, expectedCaller) : undefined;
			throwIfAborted(signal);
			const launchCwd = worktreePath ?? projectRoot;
			const tab = await createCollaboratorTab(this.pi, launchCwd, participantId);
			paneId = tab.paneId;
			tabId = tab.tabId;
			if (worktreePath) {
				await waitForHerdrPaneCwd(this.pi, tab, launchCwd, signal);
				this.session.requireCurrentScope(current);
				messaging = await this.configureNativeMessaging(candidate, targetKey, clientGeneration);
			}
			this.session.requireCurrentScope(current);
			throwIfAborted(signal);
			childMayBeLive = true;
			const kind = candidate.driver === "claude-code" ? "claude" : "codex";
			if (candidate.driver === "claude-code" && candidate.profile === "read-only") this.trustClaudeWorkspace(launchCwd);
			const nativeArgs = messaging?.args ?? guardedNativeArgs(candidate, launchCwd);
			if (messaging) ctx.ui.notify(`Complete any native trust or permission prompt in ${tab.paneId}. Runtime will not accept it for you; startup has a bounded timeout.`, "info");
			const launch: ManagedAgentLaunch = {
				protocol,
				participantId,
				agentName,
				targetKey,
				projectRoot,
				cwd: launchCwd,
				clientGeneration,
				driver: candidate.driver,
				profile: candidate.profile,
				tab,
				agentSession: await this.startManagedAgent(agentName, kind, tab, nativeArgs),
				messagingConfigured: messaging !== undefined,
			};
			this.session.requireCurrentScope(current);
			const bound = await this.bindAgent(registration, bindRequestFor(launch, expectedCaller, existing));
			this.session.requireCurrentScope(current);
			await this.settleBoundAgent(ctx, registration, launch, bound);
			ctx.ui.notify(`Interactive ${kind} collaborator ${protocol}/${participantId} started in ${tab.paneId}.`, "info");
			return tab.paneId;
		} catch (error) {
			if (error instanceof HostedCollaboratorStartError && error.childMayBeLive) childMayBeLive = true;
			if (!childMayBeLive) throw error;
			throw new HostedCollaboratorStartError(errorCode(error), error instanceof Error ? error.message : String(error), true);
		} finally {
			this.managedAgentLaunches.delete(targetKey);
			const resource = tabId ? ["tab", "close", tabId] : paneId ? ["pane", "close", paneId] : undefined;
			if (!childMayBeLive && resource) {
				const closed = await this.pi.exec("herdr", resource, { timeout: 5_000 });
				if (closed.code !== 0) {
					// oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must replace the original launch result instead of claiming quiescence.
					throw new HostedRuntimeClientError("host_unavailable", "Herdr could not clean up failed native collaborator resources.");
				}
			}
		}
	}

	/** Records one verified bound agent and proves its participant lease settled before provisioning messaging. */
	private async settleBoundAgent(ctx: ExtensionContext, registration: LiveClientRegistration, launch: ManagedAgentLaunch, bound: BoundAgent): Promise<void> {
		if (!boundAgentMatchesLaunch(bound, launch)) {
			throw new HostedRuntimeClientError("identity_mismatch", "Runtime bound another Herdr agent identity than the one this launch started.");
		}
		const control: ManagedAgentControl = {
			owner: { sessionId: ctx.sessionManager.getSessionId(), sessionFile: text(ctx.sessionManager.getSessionFile()), cwd: ctx.cwd },
			projectRoot: launch.projectRoot,
			cwd: launch.cwd,
			agentName: launch.agentName,
			targetKey: launch.targetKey,
			driver: launch.driver,
			profile: launch.profile,
			protocol: launch.protocol,
			participantId: launch.participantId,
			clientGeneration: launch.clientGeneration,
			holderGeneration: bound.holderGeneration,
			paneId: launch.tab.paneId,
			terminalId: launch.tab.terminalId,
			agentSession: launch.agentSession,
			state: "active",
		};
		if (launch.messagingConfigured) control.messagingConfigured = true;
		this.store.persistAgent(control);
		this.managedAgentRegistrations.set(launch.targetKey, bound.registration);
		const participants = await this.session.listParticipants(registration);
		const participant = participants.find((item) => item.protocol === launch.protocol && item.participantId === launch.participantId);
		const settled = participant?.state === "held"
			&& participant.holderTargetKey === launch.targetKey
			&& participant.generation === bound.holderGeneration;
		if (!settled) {
			const message = `Collaborator started in ${launch.tab.paneId}, but its Runtime identity did not settle; its tab was preserved.`;
			throw new HostedRuntimeClientError("unavailable", message);
		}
		if (launch.messagingConfigured) await this.messaging.provisionManaged(ctx, registration, control);
	}

	private async configureNativeMessaging(candidate: ResolvedCollaboratorCandidate, targetKey: string, clientGeneration: string) {
		if (candidate.driver === "pi") throw new HostedRuntimeClientError("conflict", "Native messaging requires an interactive driver.");
		const node = await this.pi.exec("node", ["--print", "process.execPath"], { timeout: 3_000 });
		if (node.code !== 0) throw new HostedRuntimeClientError("capability_unavailable", "Native messaging requires an available Node executable.");
		return nativeMessagingLaunch({
			driver: candidate.driver,
			root: this.root,
			targetKey,
			clientGeneration,
			nodeExecutable: node.stdout.trim(),
			model: candidate.model,
			personaPrompt: candidate.persona?.prompt,
		});
	}

	private async startManagedAgent(agentName: string, kind: "claude" | "codex", tab: CollaboratorTab, nativeArgs: string[]): Promise<ManagedAgentSession> {
		const args = ["agent", "start", agentName, "--kind", kind, "--pane", tab.paneId, "--timeout", "30000", ...(nativeArgs.length ? ["--", ...nativeArgs] : [])];
		const started = await this.pi.exec("herdr", args, { timeout: 35_000 });
		if (started.code !== 0) {
			const diagnostic = HERDR_AGENT_START_CODES.find(code => isHerdrError(started, code)) ?? "unclassified";
			const detail = `exit ${started.code}; Herdr ${diagnostic}`;
			throw new HostedRuntimeClientError("host_unavailable", `Herdr could not start ${kind} in ${tab.paneId} (${detail}); its tab was preserved.`);
		}
		return parseStartedAgent(started.stdout, tab.paneId, tab.terminalId, kind, agentName);
	}

	private async bindAgent(registration: LiveClientRegistration, request: AgentBindRequest): Promise<BoundAgent> {
		try { return parseBoundAgent(await this.client.call("bridge.bind", { ...auth(registration), ...request })); }
		catch (error) {
			// Binding one exact agent name is idempotent, so an unavailable response is retried instead of preserved as ambiguous authority.
			if (!(error instanceof HostedRuntimeClientError) || error.code !== "unavailable") throw error;
			return parseBoundAgent(await this.client.call("bridge.bind", { ...auth(registration), ...request }));
		}
	}

	private createCollaboratorSession(projectRoot: string, cwd: string, sessionId: string, timestamp: string, launch: CollaboratorLaunch): string {
		const sessionCwd = realpathSync(cwd);
		const directory = join(this.root, "collaborator-sessions");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const sessionFile = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		const record: HostedSessionRecord = { version: 2, launch };
		if (sessionCwd !== projectRoot) record.worktree = { projectRoot, worktreePath: sessionCwd };
		const entries: Array<SessionHeader | CustomEntry<HostedSessionRecord>> = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: sessionCwd },
			{ type: "custom", customType: HOSTED_SESSION_ENTRY, data: record, id: randomUUID(), parentId: null, timestamp },
		];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
		return sessionFile;
	}

	private async ensureWorktree(registration: LiveClientRegistration, protocol: string, participantId: string, caller: ClientParticipantStatus | undefined): Promise<string> {
		if (!caller) throw new HostedRuntimeClientError("conflict", "Workspace-write launch requires an authoritatively held caller generation.");
		const params = { ...auth(registration), callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol, participantId };
		return text(strictObject(await this.client.call("worktree.ensure", params), "Collaborator worktree").path);
	}

	private async cleanupFailedCollaborator(tabId: string | undefined, paneId: string | undefined, sessionFile: string): Promise<void> {
		const resource = tabId ? { type: "tab", id: tabId } : paneId ? { type: "pane", id: paneId } : undefined;
		if (resource) {
			const closed = await this.pi.exec("herdr", [resource.type, "close", resource.id], { timeout: 5_000 });
			if (closed.code !== 0) throw new HostedRuntimeClientError("host_unavailable", `Herdr could not clean up failed collaborator ${resource.type} ${resource.id}.`);
		}
		rmSync(sessionFile, { force: true });
	}

	private async heartbeatManagedAgents(): Promise<void> {
		if (this.managedAgentHeartbeatActive || !this.session.isActive || !this.session.context) return;
		const current = this.session.scope(this.session.context);
		this.managedAgentHeartbeatActive = true;
		try {
			for (const [targetKey, control] of this.store.agents) {
				if (!current()) return;
				if (this.managedAgentLaunches.has(targetKey) || control.state === "needs_attention" || control.state === "stopped") continue;
				try {
					let registration = this.managedAgentRegistrations.get(targetKey);
					let heartbeat: ReturnType<typeof parseHeartbeat>;
					if (!registration) {
						const bound = await this.rebindManagedAgent(control);
						if (!current() || this.store.agent(targetKey) !== control) return;
						registration = bound.registration;
						heartbeat = { registration, inboxReady: false, mail: undefined };
					} else {
						heartbeat = parseHeartbeat(await this.client.call("bridge.heartbeat", auth(registration)));
						if (!current() || this.store.agent(targetKey) !== control) return;
						if (heartbeat.registration.registrationId !== registration.registrationId || heartbeat.registration.registrationKey !== registration.registrationKey) throw new HostedRuntimeClientError("identity_mismatch", "Native heartbeat replaced its registration authority.");
					}
					if (!current()) return;
					if (heartbeat.registration.targetKey !== targetKey || heartbeat.registration.paneId !== control.paneId) throw new HostedRuntimeClientError("identity_mismatch", "Native heartbeat replaced its target identity.");
					this.managedAgentRegistrations.set(targetKey, heartbeat.registration);
					const activeControl = this.store.agent(targetKey);
					if (activeControl?.messagingConfigured && !this.messaging.isManagedIssued(targetKey) && this.session.liveRegistration) await this.messaging.provisionManaged(this.session.context, this.session.liveRegistration, activeControl);
					// Native automatic input is blocked until the provider can attest editor ownership and exact-session admission.
				} catch (error) {
					if (!current() || this.store.agent(targetKey) !== control) return;
					this.managedAgentRegistrations.delete(targetKey);
					const fatal = error instanceof HostedRuntimeClientError && ["not_found", "conflict", "identity_mismatch"].includes(error.code);
					if (fatal) this.store.persistAgent({ ...control, state: "needs_attention" });
				}
			}
		} finally { this.managedAgentHeartbeatActive = false; }
	}

	/** Re-verifies one managed Herdr agent by name and reinstalls its registration under the same client generation. */
	private async rebindManagedAgent(control: ManagedAgentControl): Promise<BoundAgent> {
		const registration = this.session.liveRegistration;
		const identity = this.store.identity;
		if (!registration) throw new HostedRuntimeClientError("registration_stale", "Managed agent rebinding requires a live Pi registration.");
		if (identity?.disposition !== "held" || !identity.participantKey || !identity.generation) {
			throw new HostedRuntimeClientError("conflict", "Managed agent rebinding requires this Pi session to hold its collaborator identity.");
		}
		const bound = await this.bindAgent(registration, {
			agentName: control.agentName,
			driver: control.driver,
			profile: control.profile,
			clientGeneration: control.clientGeneration,
			protocol: control.protocol,
			participantId: control.participantId,
			callerParticipantKey: identity.participantKey,
			expectedCallerGeneration: identity.generation,
		});
		const sameTarget = bound.registration.targetKey === control.targetKey
			&& bound.registration.paneId === control.paneId
			&& bound.holderGeneration === control.holderGeneration;
		if (!sameTarget) {
			throw new HostedRuntimeClientError("identity_mismatch", "Rebound Herdr agent differs from its persisted managed target.");
		}
		const sameIdentity = bound.driver === control.driver
			&& bound.cwd === control.cwd
			&& sameAgentSession(bound.agentSession, control.agentSession);
		if (!sameIdentity) {
			throw new HostedRuntimeClientError("identity_mismatch", "Rebound Herdr agent identity differs from its persisted managed session.");
		}
		return bound;
	}

	/** Best-effort idle hint. Not submission, body retrieval, read receipt or native admission; never replayed. */
}

interface CollaboratorLaunchOptions {
	model?: string;
	profile?: HostedCollaboratorProfile;
	persona?: CollaboratorPersona;
}

function piCollaboratorLaunch(options: CollaboratorLaunchOptions): CollaboratorLaunch {
	const launch: CollaboratorLaunch = { driver: "pi" };
	if (options.model) launch.model = options.model;
	if (options.profile) launch.profile = options.profile;
	if (options.persona) launch.persona = options.persona;
	return launch;
}

function personaOnly(result: BeforeAgentStartResult): BeforeAgentStartResult | undefined {
	return result.systemPrompt ? result : undefined;
}

function defaultRuntimeRoot(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "runtime");
}

function parseBoundAgent(value: RuntimeResponse): BoundAgent {
	const result = strictObject(value, "Herdr agent bind result");
	const session = strictObject(result.agentSession, "Bound agent session");
	if (result.driver !== "claude-code" && result.driver !== "codex") {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent driver.");
	}
	if (result.profile !== "read-only" && result.profile !== "workspace-write") {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent profile.");
	}
	if (session.kind !== "id" && session.kind !== "path") {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent session kind.");
	}
	return {
		registration: parseRegistration(value),
		participantKey: text(result.participantKey),
		holderGeneration: text(result.holderGeneration),
		driver: result.driver,
		profile: result.profile,
		projectRoot: text(result.projectRoot),
		cwd: text(result.cwd),
		agentSession: { source: text(session.source), agent: text(session.agent), kind: session.kind, value: text(session.value) },
	};
}

function bindRequestFor(launch: ManagedAgentLaunch, caller: ClientParticipantStatus, existing: ClientParticipantStatus | undefined): AgentBindRequest {
	const request: AgentBindRequest = {
		agentName: launch.agentName,
		driver: launch.driver,
		profile: launch.profile,
		clientGeneration: launch.clientGeneration,
		protocol: launch.protocol,
		participantId: launch.participantId,
		callerParticipantKey: caller.participantKey,
		expectedCallerGeneration: caller.generation,
	};
	if (existing) request.expectedParticipantGeneration = existing.generation;
	return request;
}

function boundAgentMatchesLaunch(bound: BoundAgent, launch: ManagedAgentLaunch): boolean {
	return bound.registration.targetKey === launch.targetKey
		&& bound.registration.paneId === launch.tab.paneId
		&& bound.driver === launch.driver
		&& bound.profile === launch.profile
		&& bound.cwd === launch.cwd
		&& sameAgentSession(bound.agentSession, launch.agentSession);
}

function parseStartedAgent(value: string, paneId: string, terminalId: string, kind: "claude" | "codex", agentName: string): ManagedAgentSession {
	const agent = parseManagedAgent(value);
	if (agent.paneId !== paneId || agent.terminalId !== terminalId || agent.agentSession.source !== `herdr:${kind}` || agent.agentSession.agent !== kind || agent.name !== agentName) throw new HostedRuntimeClientError("identity_mismatch", "Herdr started agent identity does not match the authorized collaborator target.");
	return agent.agentSession;
}

function parseManagedAgent(value: string): ManagedAgentStatus {
	let response: SerializedObject;
	try { response = strictObject(JSON.parse(value), "Herdr response"); } catch { throw new HostedRuntimeClientError("invalid_response", "Herdr returned malformed agent JSON."); }
	const result = strictObject(response.result, "Herdr result");
	const agent = strictObject(result.agent, "Herdr agent");
	const agentKind = text(agent.agent);
	const session = agent.agent_session === undefined ? { source: `herdr:${agentKind}`, agent: agentKind, kind: "id" as const, value: text(agent.name) } : strictObject(agent.agent_session, "Herdr agent session");
	if (session.kind !== "id" && session.kind !== "path") throw new HostedRuntimeClientError("invalid_response", "Herdr agent session kind is invalid.");
	if (session.agent !== agentKind || session.source !== `herdr:${agentKind}`) throw new HostedRuntimeClientError("identity_mismatch", "Herdr agent session does not match its reported driver.");
	if (agent.agent_status !== "idle" && agent.agent_status !== "working" && agent.agent_status !== "blocked" && agent.agent_status !== "done" && agent.agent_status !== "unknown") throw new HostedRuntimeClientError("invalid_response", "Herdr agent status is invalid.");
	return { name: text(agent.name), paneId: text(agent.pane_id), terminalId: text(agent.terminal_id), status: agent.agent_status, focused: booleanValue(agent.focused), agentSession: { source: text(session.source), agent: text(session.agent), kind: session.kind, value: text(session.value) } };
}

function managedAgentName(protocol: string, participantId: string): string {
	return `collab-${createHash("sha256").update(`${protocol}\0${participantId}\0${randomUUID()}`).digest("hex").slice(0, 25)}`;
}

function guardedNativeArgs(candidate: ResolvedCollaboratorCandidate, launchCwd: string): string[] {
	if (candidate.profile !== "read-only" || candidate.driver === "pi") throw new HostedRuntimeClientError("capability_unavailable", "Guarded native startup requires a read-only profile.");
	if (candidate.driver === "claude-code") return ["--safe-mode", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", ...(candidate.model ? ["--model", candidate.model] : []), ...(candidate.persona ? ["--append-system-prompt", candidate.persona.prompt] : [])];
	const trustedProject = `projects={ ${JSON.stringify(launchCwd)} = { trust_level = "trusted" } }`;
	return ["--ask-for-approval", "never", "--sandbox", "read-only", "--disable", "hooks", "--config", trustedProject, ...(candidate.model ? ["--model", candidate.model] : []), ...(candidate.persona ? ["--config", `developer_instructions=${JSON.stringify(candidate.persona.prompt)}`] : [])];
}

function monitorSummary(value: RuntimeResponse): string {
	const monitor = strictObject(value, "Runtime Monitor");
	return `${text(monitor.monitorId)} (${text(monitor.status)})`;
}

function monitorIdFromStatus(value: RuntimeResponse): string | undefined {
	const status = strictObject(value, "Runtime Monitor status");
	if (status.monitor === null) return undefined;
	return text(strictObject(status.monitor, "Runtime Monitor").monitorId);
}

