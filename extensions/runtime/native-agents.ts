import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import type { DriverSpec, StartedAgentIdentity } from "./drivers.ts";
import type { CollaboratorTab } from "./herdr.ts";
import type { HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "./hosted-types.ts";
import { nativeMessagingConfiguration, type NativeMessagingConfiguration } from "./mcp/native.ts";
import type { MessagingClient } from "./messaging-client.ts";
import {
	auth,
	booleanValue,
	parseHeartbeat,
	parseRegistration,
	strictObject,
	text,
	type LiveClientRegistration,
	type RuntimeResponse,
	type SerializedObject,
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ManagedAgentControl, ManagedAgentSession } from "./session-record.ts";
import { deriveAgentTargetKey } from "./service/state.ts";

const FATAL_HEARTBEAT_CODES = ["not_found", "conflict", "identity_mismatch"];

/** The Runtime-owned identity one collaborator launch starts and binds under. */
export interface ManagedAgentPlan {
	agentName: string;
	targetKey: string;
}

interface StartAgentRequest {
	agentName: string;
	spec: DriverSpec;
	tab: CollaboratorTab;
	argv: string[];
}

interface BindLaunchedRequest {
	ctx: ExtensionContext;
	registration: LiveClientRegistration;
	plan: ManagedAgentPlan;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	protocol: string;
	participantId: string;
	projectRoot: string;
	cwd: string;
	tab: CollaboratorTab;
	agentSession: ManagedAgentSession;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	expectedParticipantGeneration?: string;
	messagingConfigured: boolean;
}

interface AgentBindRequest {
	agentName: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
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
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	projectRoot: string;
	cwd: string;
}

interface ManagedAgentStatus {
	name: string;
	paneId: string;
	terminalId: string;
	status: "idle" | "working" | "blocked" | "done" | "unknown";
	focused: boolean;
	agentSession: ManagedAgentSession;
}

/** Starts, binds and re-verifies collaborators as real Herdr agents. */
export class NativeAgentService {
	private readonly session: RuntimeSession;
	private readonly messaging: MessagingClient;
	private readonly registrations = new Map<string, LiveClientRegistration>();
	private readonly launching = new Set<string>();
	private heartbeatActive = false;

	constructor(session: RuntimeSession, messaging: MessagingClient) {
		this.session = session;
		this.messaging = messaging;
	}

	private get pi(): ExtensionAPI {
		return this.session.pi;
	}

	clearRegistrations(): void {
		this.registrations.clear();
	}

	/** Drops the reconnection authority of a collaborator Runtime confirmed stopped. */
	markStopped(control: ManagedAgentControl): void {
		this.registrations.delete(control.targetKey);
		this.session.store.persistAgent({ ...control, state: "stopped" });
	}

	plan(protocol: string, participantId: string, projectRoot: string): ManagedAgentPlan {
		const digest = createHash("sha256").update(`${protocol}\0${participantId}\0${randomUUID()}`).digest("hex");
		const agentName = `collab-${digest.slice(0, 25)}`;
		return { agentName, targetKey: deriveAgentTargetKey(projectRoot, agentName) };
	}

	/** Holds the heartbeat sweep off one target for the length of its launch. */
	beginLaunch(targetKey: string): void {
		this.launching.add(targetKey);
	}

	finishLaunch(targetKey: string): void {
		this.launching.delete(targetKey);
	}

	async messagingConfiguration(plan: ManagedAgentPlan, personaPrompt: string | undefined): Promise<NativeMessagingConfiguration> {
		const node = await this.pi.exec("node", ["--print", "process.execPath"], { timeout: 3_000 });
		if (node.code !== 0) {
			throw new HostedRuntimeClientError("capability_unavailable", "Native messaging requires an available Node executable.");
		}
		const input = {
			root: this.session.root,
			targetKey: plan.targetKey,
			nodeExecutable: node.stdout.trim(),
		};
		return nativeMessagingConfiguration(personaPrompt ? { ...input, personaPrompt } : input);
	}

	/** Starts one exact Herdr agent and proves it is the driver and pane the launch authorized. */
	async startAgent(request: StartAgentRequest): Promise<StartedAgentIdentity> {
		const { agentName, spec, tab, argv } = request;
		const separated = argv.length ? ["--", ...argv] : [];
		const args = ["agent", "start", agentName, "--kind", spec.kind, "--pane", tab.paneId, "--timeout", "30000", ...separated];
		const started = await this.pi.exec("herdr", args, { timeout: 35_000 });
		if (started.code !== 0) {
			const detail = `Herdr could not start ${spec.kind} in ${tab.paneId} (exit ${started.code}).`;
			throw new HostedRuntimeClientError("host_unavailable", detail);
		}
		const agent = parseManagedAgent(started.stdout);
		if (!startedAsAuthorized(agent, request)) {
			const detail = "Herdr started agent identity does not match the authorized collaborator target.";
			throw new HostedRuntimeClientError("identity_mismatch", detail);
		}
		return agent;
	}

	/** Binds one started agent to its participant lease and records the reconnection authority. */
	async bindLaunched(request: BindLaunchedRequest): Promise<void> {
		const bound = await this.bindAgent(request.registration, bindRequestFor(request));
		if (!boundAgentMatchesLaunch(bound, request)) {
			throw new HostedRuntimeClientError("identity_mismatch", "Runtime bound another Herdr agent identity than the one this launch started.");
		}
		const { ctx } = request;
		const control: ManagedAgentControl = {
			owner: { sessionId: ctx.sessionManager.getSessionId(), sessionFile: text(ctx.sessionManager.getSessionFile()), cwd: ctx.cwd },
			projectRoot: request.projectRoot,
			cwd: request.cwd,
			agentName: request.plan.agentName,
			targetKey: request.plan.targetKey,
			driver: request.driver,
			profile: request.profile,
			protocol: request.protocol,
			participantId: request.participantId,
			holderGeneration: bound.holderGeneration,
			paneId: request.tab.paneId,
			terminalId: request.tab.terminalId,
			agentSession: request.agentSession,
			state: "active",
		};
		if (request.messagingConfigured) control.messagingConfigured = true;
		this.session.store.persistAgent(control);
		this.registrations.set(request.plan.targetKey, bound.registration);
		if (request.messagingConfigured) await this.messaging.provisionManaged(ctx, request.registration, control);
	}

	private async bindAgent(registration: LiveClientRegistration, request: AgentBindRequest): Promise<BoundAgent> {
		try { return parseBoundAgent(await this.session.client.call("bridge.bind", { ...auth(registration), ...request })); }
		catch (error) {
			// Binding one exact agent name is idempotent, so an unavailable response is retried instead of preserved as ambiguous authority.
			if (!(error instanceof HostedRuntimeClientError) || error.code !== "unavailable") throw error;
			return parseBoundAgent(await this.session.client.call("bridge.bind", { ...auth(registration), ...request }));
		}
	}

	async heartbeatManagedAgents(): Promise<void> {
		const ctx = this.session.context;
		if (this.heartbeatActive || !this.session.isActive || !ctx) return;
		const current = this.session.scope(ctx);
		this.heartbeatActive = true;
		try {
			for (const [targetKey, control] of this.session.store.agents) {
				if (!current()) return;
				if (this.launching.has(targetKey) || control.state !== "active") continue;
				if (!await this.heartbeatManagedAgent(ctx, targetKey, control, current)) return;
			}
		} finally {
			this.heartbeatActive = false;
		}
	}

	/** False when this session moved on and the whole managed sweep must stop. */
	private async heartbeatManagedAgent(
		ctx: ExtensionContext,
		targetKey: string,
		control: ManagedAgentControl,
		current: () => boolean,
	): Promise<boolean> {
		try {
			const registration = await this.verifyManagedRegistration(targetKey, control, current);
			if (!registration) return false;
			this.registrations.set(targetKey, registration);
			const active = this.session.store.agent(targetKey);
			const live = this.session.liveRegistration;
			// Native automatic input is blocked until the provider can attest editor ownership and exact-session admission.
			const needsMessaging = active?.messagingConfigured === true && !this.messaging.isManagedIssued(targetKey);
			if (needsMessaging && live && active) await this.messaging.provisionManaged(ctx, live, active);
			return true;
		} catch (error) {
			if (!current() || this.session.store.agent(targetKey) !== control) return false;
			this.registrations.delete(targetKey);
			if (error instanceof HostedRuntimeClientError && FATAL_HEARTBEAT_CODES.includes(error.code)) {
				this.session.store.persistAgent({ ...control, state: "needs_attention" });
			}
			return true;
		}
	}

	/** The verified registration for one managed target, or undefined when this session moved on. */
	private async verifyManagedRegistration(
		targetKey: string,
		control: ManagedAgentControl,
		current: () => boolean,
	): Promise<LiveClientRegistration | undefined> {
		const known = this.registrations.get(targetKey);
		let registration: LiveClientRegistration;
		if (known) {
			const heartbeat = parseHeartbeat(await this.session.client.call("bridge.heartbeat", auth(known)));
			if (!current() || this.session.store.agent(targetKey) !== control) return undefined;
			if (heartbeat.registration.registrationId !== known.registrationId || heartbeat.registration.registrationKey !== known.registrationKey) {
				throw new HostedRuntimeClientError("identity_mismatch", "Native heartbeat replaced its registration authority.");
			}
			registration = heartbeat.registration;
		} else {
			const bound = await this.rebindManagedAgent(control);
			if (!current() || this.session.store.agent(targetKey) !== control) return undefined;
			registration = bound.registration;
		}
		if (!current()) return undefined;
		if (registration.targetKey !== targetKey) {
			throw new HostedRuntimeClientError("identity_mismatch", "Native heartbeat replaced its target identity.");
		}
		return registration;
	}

	/** Re-verifies one managed Herdr agent by name and reinstalls its registration. */
	private async rebindManagedAgent(control: ManagedAgentControl): Promise<BoundAgent> {
		const registration = this.session.liveRegistration;
		const identity = this.session.store.identity;
		if (!registration) throw new HostedRuntimeClientError("registration_stale", "Managed agent rebinding requires a live Pi registration.");
		if (identity?.disposition !== "held" || !identity.participantKey || !identity.generation) {
			throw new HostedRuntimeClientError("conflict", "Managed agent rebinding requires this Pi session to hold its collaborator identity.");
		}
		const bound = await this.bindAgent(registration, {
			agentName: control.agentName,
			driver: control.driver,
			profile: control.profile,
			protocol: control.protocol,
			participantId: control.participantId,
			callerParticipantKey: identity.participantKey,
			expectedCallerGeneration: identity.generation,
		});
		const sameTarget = bound.registration.targetKey === control.targetKey
			&& bound.holderGeneration === control.holderGeneration
			&& bound.driver === control.driver
			&& bound.cwd === control.cwd;
		if (!sameTarget) {
			throw new HostedRuntimeClientError("identity_mismatch", "Rebound Herdr agent differs from its persisted managed target.");
		}
		return bound;
	}
}

function startedAsAuthorized(agent: ManagedAgentStatus, request: StartAgentRequest): boolean {
	if (agent.name !== request.agentName) return false;
	if (agent.paneId !== request.tab.paneId) return false;
	if (agent.terminalId !== request.tab.terminalId) return false;
	return request.spec.verify(agent);
}

function bindRequestFor(request: BindLaunchedRequest): AgentBindRequest {
	const bind: AgentBindRequest = {
		agentName: request.plan.agentName,
		driver: request.driver,
		profile: request.profile,
		protocol: request.protocol,
		participantId: request.participantId,
		callerParticipantKey: request.callerParticipantKey,
		expectedCallerGeneration: request.expectedCallerGeneration,
	};
	if (request.expectedParticipantGeneration) bind.expectedParticipantGeneration = request.expectedParticipantGeneration;
	return bind;
}

function boundAgentMatchesLaunch(bound: BoundAgent, request: BindLaunchedRequest): boolean {
	return bound.registration.targetKey === request.plan.targetKey
		&& bound.driver === request.driver
		&& bound.profile === request.profile
		&& bound.cwd === request.cwd;
}

function parseBoundAgent(value: RuntimeResponse): BoundAgent {
	const result = strictObject(value, "Herdr agent bind result");
	if (result.driver !== "claude-code" && result.driver !== "codex") {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent driver.");
	}
	if (result.profile !== "read-only" && result.profile !== "workspace-write") {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent profile.");
	}
	return {
		registration: parseRegistration(value),
		participantKey: text(result.participantKey),
		holderGeneration: text(result.holderGeneration),
		driver: result.driver,
		profile: result.profile,
		projectRoot: text(result.projectRoot),
		cwd: text(result.cwd),
	};
}

function parseManagedAgent(value: string): ManagedAgentStatus {
	let response: SerializedObject;
	try {
		response = strictObject(JSON.parse(value), "Herdr response");
	} catch {
		throw new HostedRuntimeClientError("invalid_response", "Herdr returned malformed agent JSON.");
	}
	const agent = strictObject(strictObject(response.result, "Herdr result").agent, "Herdr agent");
	const agentKind = text(agent.agent);
	const session = agent.agent_session === undefined
		? { source: `herdr:${agentKind}`, agent: agentKind, kind: "id", value: text(agent.name) }
		: strictObject(agent.agent_session, "Herdr agent session");
	if (session.kind !== "id" && session.kind !== "path") {
		throw new HostedRuntimeClientError("invalid_response", "Herdr agent session kind is invalid.");
	}
	if (session.agent !== agentKind || session.source !== `herdr:${agentKind}`) {
		throw new HostedRuntimeClientError("identity_mismatch", "Herdr agent session does not match its reported driver.");
	}
	if (!isManagedAgentStatus(agent.agent_status)) throw new HostedRuntimeClientError("invalid_response", "Herdr agent status is invalid.");
	return {
		name: text(agent.name),
		paneId: text(agent.pane_id),
		terminalId: text(agent.terminal_id),
		status: agent.agent_status,
		focused: booleanValue(agent.focused),
		agentSession: { source: text(session.source), agent: text(session.agent), kind: session.kind, value: text(session.value) },
	};
}

const MANAGED_AGENT_STATUSES: readonly ManagedAgentStatus["status"][] = ["idle", "working", "blocked", "done", "unknown"];

function isManagedAgentStatus(value: RuntimeResponse): value is ManagedAgentStatus["status"] {
	return MANAGED_AGENT_STATUSES.some((status) => status === value);
}
