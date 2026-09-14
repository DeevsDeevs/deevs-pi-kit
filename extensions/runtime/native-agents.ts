import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClientError } from "./client.ts";
import { HostedCollaboratorStartError, type ResolvedCollaboratorCandidate } from "./collaborator-policy.ts";
import {
	createCollaboratorTab,
	HERDR_AGENT_START_CODES,
	isHerdrError,
	throwIfAborted,
	waitForHerdrPaneCwd,
	type CollaboratorTab,
} from "./herdr.ts";
import { sameAgentSession, type HostedCollaboratorProfile, type HostedNativeCollaboratorDriver } from "./hosted-types.ts";
import { nativeMessagingLaunch } from "./mcp/native.ts";
import type { MessagingClient } from "./messaging-client.ts";
import {
	auth,
	booleanValue,
	errorCode,
	parseHeartbeat,
	parseRegistration,
	strictObject,
	text,
	type ClientParticipantStatus,
	type LiveClientRegistration,
	type RuntimeResponse,
	type SerializedObject,
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { ManagedAgentControl, ManagedAgentSession } from "./session-record.ts";
import { deriveAgentTargetKey } from "./service/state.ts";

const FATAL_HEARTBEAT_CODES = ["not_found", "conflict", "identity_mismatch"];

interface NativeLaunchRequest {
	ctx: ExtensionContext;
	registration: LiveClientRegistration;
	protocol: string;
	participantId: string;
	candidate: ResolvedCollaboratorCandidate;
	caller: ClientParticipantStatus | undefined;
	existing: ClientParticipantStatus | undefined;
	worktreePath: string | undefined;
	signal?: AbortSignal;
}

interface ManagedAgentLaunch {
	protocol: string;
	participantId: string;
	agentName: string;
	targetKey: string;
	projectRoot: string;
	cwd: string;
	clientGeneration: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	tab: CollaboratorTab;
	agentSession: ManagedAgentSession;
	messagingConfigured: boolean;
}

interface AgentBindRequest {
	agentName: string;
	driver: HostedNativeCollaboratorDriver;
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
	driver: HostedNativeCollaboratorDriver;
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

interface NativeLaunchScope {
	agentName: string;
	targetKey: string;
	clientGeneration: string;
	projectRoot: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	caller: ClientParticipantStatus;
	current: () => boolean;
}

/** Starts, binds and re-verifies interactive Claude Code and Codex collaborators as real Herdr agents. */
export class NativeAgentService {
	private readonly session: RuntimeSession;
	private readonly messaging: MessagingClient;
	private readonly trustClaudeWorkspace: (cwd: string) => void;
	private readonly registrations = new Map<string, LiveClientRegistration>();
	private readonly launching = new Set<string>();
	private heartbeatActive = false;

	constructor(session: RuntimeSession, messaging: MessagingClient, trustClaudeWorkspace: (cwd: string) => void) {
		this.session = session;
		this.messaging = messaging;
		this.trustClaudeWorkspace = trustClaudeWorkspace;
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

	async launch(request: NativeLaunchRequest): Promise<string> {
		const { candidate, caller } = request;
		if (!caller || candidate.driver === "pi" || !candidate.profile) {
			throw new HostedRuntimeClientError("conflict", "Native launch requires a held caller and a resolved profile.");
		}
		const projectRoot = realpathSync(request.ctx.cwd);
		const agentName = managedAgentName(request.protocol, request.participantId);
		const identity = this.session.store.identity;
		const scope = this.session.scope(request.ctx, request.registration);
		const launchScope: NativeLaunchScope = {
			agentName,
			targetKey: deriveAgentTargetKey(projectRoot, agentName),
			clientGeneration: `agent_client_${randomUUID()}`,
			projectRoot,
			driver: candidate.driver,
			profile: candidate.profile,
			caller,
			current: () => scope() && this.session.store.identity === identity,
		};
		this.launching.add(launchScope.targetKey);
		try {
			return await this.launchTab(request, launchScope);
		} finally {
			this.launching.delete(launchScope.targetKey);
		}
	}

	private async launchTab(request: NativeLaunchRequest, launch: NativeLaunchScope): Promise<string> {
		let tab: CollaboratorTab | undefined;
		let childMayBeLive = false;
		try {
			throwIfAborted(request.signal);
			const launchCwd = request.worktreePath ?? launch.projectRoot;
			tab = await createCollaboratorTab(this.pi, launchCwd, request.participantId);
			const messaging = await this.configureLaunchMessaging(request, launch, tab, launchCwd);
			this.session.requireCurrentScope(launch.current);
			throwIfAborted(request.signal);
			childMayBeLive = true;
			return await this.startAndBind(request, launch, tab, launchCwd, messaging);
		} catch (error) {
			if (error instanceof HostedCollaboratorStartError && error.childMayBeLive) childMayBeLive = true;
			if (!childMayBeLive) throw error;
			throw new HostedCollaboratorStartError(errorCode(error), error instanceof Error ? error.message : String(error), true);
		} finally {
			if (!childMayBeLive && tab) await this.closeFailedTab(tab);
		}
	}

	private async closeFailedTab(tab: CollaboratorTab): Promise<void> {
		const closed = await this.pi.exec("herdr", ["tab", "close", tab.tabId], { timeout: 5_000 });
		if (closed.code !== 0) {
			// oxlint-disable-next-line no-unsafe-finally -- Cleanup failure must replace the original launch result instead of claiming quiescence.
			throw new HostedRuntimeClientError("host_unavailable", "Herdr could not clean up failed native collaborator resources.");
		}
	}

	/** Only a writer in its own settled worktree receives an MCP messaging configuration. */
	private async configureLaunchMessaging(
		request: NativeLaunchRequest,
		launch: NativeLaunchScope,
		tab: CollaboratorTab,
		launchCwd: string,
	): Promise<NativeMessagingConfiguration | undefined> {
		if (!request.worktreePath) return undefined;
		await waitForHerdrPaneCwd(this.pi, tab, launchCwd, request.signal);
		this.session.requireCurrentScope(launch.current);
		return this.configureNativeMessaging(request.candidate, launch.targetKey, launch.clientGeneration);
	}

	private async startAndBind(
		request: NativeLaunchRequest,
		scope: NativeLaunchScope,
		tab: CollaboratorTab,
		launchCwd: string,
		messaging: NativeMessagingConfiguration | undefined,
	): Promise<string> {
		const { candidate, ctx } = request;
		const kind = scope.driver === "claude-code" ? "claude" : "codex";
		if (scope.driver === "claude-code" && scope.profile === "read-only") this.trustClaudeWorkspace(launchCwd);
		const nativeArgs = messaging?.args ?? guardedNativeArgs(candidate, launchCwd);
		if (messaging) {
			const prompt = `Complete any native trust or permission prompt in ${tab.paneId}.`
				+ " Runtime will not accept it for you; startup has a bounded timeout.";
			ctx.ui.notify(prompt, "info");
		}
		const launch: ManagedAgentLaunch = {
			protocol: request.protocol,
			participantId: request.participantId,
			agentName: scope.agentName,
			targetKey: scope.targetKey,
			projectRoot: scope.projectRoot,
			cwd: launchCwd,
			clientGeneration: scope.clientGeneration,
			driver: scope.driver,
			profile: scope.profile,
			tab,
			agentSession: await this.startManagedAgent(scope.agentName, kind, tab, nativeArgs),
			messagingConfigured: messaging !== undefined,
		};
		this.session.requireCurrentScope(scope.current);
		const bound = await this.bindAgent(request.registration, bindRequestFor(launch, scope.caller, request.existing));
		this.session.requireCurrentScope(scope.current);
		await this.settleBoundAgent(ctx, request.registration, launch, bound);
		ctx.ui.notify(`Interactive ${kind} collaborator ${request.protocol}/${request.participantId} started in ${tab.paneId}.`, "info");
		return tab.paneId;
	}

	/** Records one verified bound agent and proves its participant lease settled before provisioning messaging. */
	private async settleBoundAgent(
		ctx: ExtensionContext,
		registration: LiveClientRegistration,
		launch: ManagedAgentLaunch,
		bound: BoundAgent,
	): Promise<void> {
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
		this.session.store.persistAgent(control);
		this.registrations.set(launch.targetKey, bound.registration);
		const participants = await this.session.listParticipants(registration);
		const participant = participants.find((item) => item.protocol === launch.protocol && item.participantId === launch.participantId);
		const settled = participant?.state === "held"
			&& participant.holderTargetKey === launch.targetKey
			&& participant.generation === bound.holderGeneration;
		if (!settled) {
			const detail = `Collaborator started in ${launch.tab.paneId}, but its Runtime identity did not settle; its tab was preserved.`;
			throw new HostedRuntimeClientError("unavailable", detail);
		}
		if (launch.messagingConfigured) await this.messaging.provisionManaged(ctx, registration, control);
	}

	private async configureNativeMessaging(
		candidate: ResolvedCollaboratorCandidate,
		targetKey: string,
		clientGeneration: string,
	): Promise<NativeMessagingConfiguration> {
		if (candidate.driver === "pi") throw new HostedRuntimeClientError("conflict", "Native messaging requires an interactive driver.");
		const node = await this.pi.exec("node", ["--print", "process.execPath"], { timeout: 3_000 });
		if (node.code !== 0) {
			throw new HostedRuntimeClientError("capability_unavailable", "Native messaging requires an available Node executable.");
		}
		return nativeMessagingLaunch({
			driver: candidate.driver,
			root: this.session.root,
			targetKey,
			clientGeneration,
			nodeExecutable: node.stdout.trim(),
			model: candidate.model,
			personaPrompt: candidate.persona?.prompt,
		});
	}

	private async startManagedAgent(
		agentName: string,
		kind: "claude" | "codex",
		tab: CollaboratorTab,
		nativeArgs: string[],
	): Promise<ManagedAgentSession> {
		const separated = nativeArgs.length ? ["--", ...nativeArgs] : [];
		const args = ["agent", "start", agentName, "--kind", kind, "--pane", tab.paneId, "--timeout", "30000", ...separated];
		const started = await this.pi.exec("herdr", args, { timeout: 35_000 });
		if (started.code !== 0) {
			const diagnostic = HERDR_AGENT_START_CODES.find(code => isHerdrError(started, code)) ?? "unclassified";
			const detail = `Herdr could not start ${kind} in ${tab.paneId} (exit ${started.code}; Herdr ${diagnostic}); its tab was preserved.`;
			throw new HostedRuntimeClientError("host_unavailable", detail);
		}
		return parseStartedAgent(started.stdout, tab.paneId, tab.terminalId, kind, agentName);
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
		if (registration.targetKey !== targetKey || registration.paneId !== control.paneId) {
			throw new HostedRuntimeClientError("identity_mismatch", "Native heartbeat replaced its target identity.");
		}
		return registration;
	}

	/** Re-verifies one managed Herdr agent by name and reinstalls its registration under the same client generation. */
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
}

type NativeMessagingConfiguration = ReturnType<typeof nativeMessagingLaunch>;

function managedAgentName(protocol: string, participantId: string): string {
	return `collab-${createHash("sha256").update(`${protocol}\0${participantId}\0${randomUUID()}`).digest("hex").slice(0, 25)}`;
}

function guardedNativeArgs(candidate: ResolvedCollaboratorCandidate, launchCwd: string): string[] {
	if (candidate.profile !== "read-only" || candidate.driver === "pi") {
		throw new HostedRuntimeClientError("capability_unavailable", "Guarded native startup requires a read-only profile.");
	}
	const model = candidate.model ? ["--model", candidate.model] : [];
	if (candidate.driver === "claude-code") {
		const persona = candidate.persona ? ["--append-system-prompt", candidate.persona.prompt] : [];
		return ["--safe-mode", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep", ...model, ...persona];
	}
	const trustedProject = `projects={ ${JSON.stringify(launchCwd)} = { trust_level = "trusted" } }`;
	const persona = candidate.persona ? ["--config", `developer_instructions=${JSON.stringify(candidate.persona.prompt)}`] : [];
	return ["--ask-for-approval", "never", "--sandbox", "read-only", "--disable", "hooks", "--config", trustedProject, ...model, ...persona];
}

function bindRequestFor(
	launch: ManagedAgentLaunch,
	caller: ClientParticipantStatus,
	existing: ClientParticipantStatus | undefined,
): AgentBindRequest {
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

function parseStartedAgent(
	value: string,
	paneId: string,
	terminalId: string,
	kind: "claude" | "codex",
	agentName: string,
): ManagedAgentSession {
	const agent = parseManagedAgent(value);
	const matches = agent.paneId === paneId
		&& agent.terminalId === terminalId
		&& agent.agentSession.source === `herdr:${kind}`
		&& agent.agentSession.agent === kind
		&& agent.name === agentName;
	if (!matches) {
		const detail = "Herdr started agent identity does not match the authorized collaborator target.";
		throw new HostedRuntimeClientError("identity_mismatch", detail);
	}
	return agent.agentSession;
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
