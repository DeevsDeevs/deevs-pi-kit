import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionHeader,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import {
	collaboratorConfiguration,
	collaboratorName,
	collaboratorToolBlock,
	resolveCollaboratorCandidate,
	type CollaboratorCandidate,
	type CollaboratorToolBlock,
	type ResolvedCollaboratorCandidate,
} from "./collaborator-policy.ts";
import { DRIVERS, driverLaunchArgv, type DriverSpec } from "./drivers.ts";
import { createCollaboratorTab, throwIfAborted, waitForHerdrPaneCwd, type CollaboratorTab } from "./herdr.ts";
import type { HostedCollaboratorProfile } from "./hosted-types.ts";
import type { ManagedAgentPlan, NativeAgentService } from "./native-agents.ts";
import {
	auth,
	parseAcquireResult,
	parseParticipant,
	parseSerializedResponse,
	strictObject,
	text,
	type ClientParticipantStatus,
	type LiveClientRegistration,
	type SerializedValue,
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { CollaboratorLaunch, ManagedAgentSession } from "./session-record.ts";
import { COLLABORATOR_ENV, HOSTED_SESSION_ENTRY, type HostedSessionRecord } from "./session-restore.ts";

const COLLABORATOR_CONCURRENCY = 4;
const COLLABORATOR_BATCH_LIMIT = 12;

type CollaboratorManageAction = "start" | "stand_down" | "stop";

export interface CollaboratorManageInput {
	action: CollaboratorManageAction;
	participants: CollaboratorCandidate[];
	protocol?: string;
	callerParticipantId?: string;
}

export interface CollaboratorManageResult {
	participant: string;
	status: "started" | "stood_down" | "stopped" | "already_vacant" | "already_stopped" | "unmanaged" | "failed" | "declined" | "cancelled";
	paneId?: string;
	error?: string;
}

export type CollaboratorWorktreeInput =
	| { action: "list" }
	| { action: "cleanup"; participantId: string };

/** The authority one confirmed start batch shares across its launches. */
interface CollaboratorStart {
	ctx: ExtensionContext;
	protocol: string;
	registration: LiveClientRegistration;
	caller: ClientParticipantStatus;
	projectRoot: string;
	signal?: AbortSignal;
}

interface CollaboratorLaunchRequest {
	start: CollaboratorStart;
	candidate: ResolvedCollaboratorCandidate;
	existing: ClientParticipantStatus | undefined;
	spec: DriverSpec;
	plan: ManagedAgentPlan;
	current: () => boolean;
}

/** What `herdr agent start` produced for one launch, before Runtime binds it. */
interface StartedCollaborator {
	tab: CollaboratorTab;
	cwd: string;
	agentSession: ManagedAgentSession;
	messagingConfigured: boolean;
}

interface StartConfirmation {
	ctx: ExtensionContext;
	protocol: string;
	callerParticipantId: string;
	acquires: boolean;
	candidates: ResolvedCollaboratorCandidate[];
	participants: ClientParticipantStatus[];
	signal?: AbortSignal;
}

/** Owns collaborator lifecycle: listing, confirmed start/stand-down/stop, launches and worktrees. */
export class CollaboratorService {
	private readonly session: RuntimeSession;
	private readonly native: NativeAgentService;
	private manageActive = false;

	constructor(session: RuntimeSession, native: NativeAgentService) {
		this.session = session;
		this.native = native;
	}

	private get pi(): ExtensionAPI {
		return this.session.pi;
	}

	private get client(): HostedRuntimeClient {
		return this.session.client;
	}

	async list(ctx: ExtensionContext): Promise<ClientParticipantStatus[]> {
		return this.session.listParticipants(await this.session.requireRegistration(ctx));
	}

	guardTool(toolName: string, input: ToolCallEvent["input"] | undefined, cwd: string): CollaboratorToolBlock | undefined {
		const configured = this.session.store.launch?.profile;
		if (!configured) return undefined;
		const path = input && "path" in input ? input.path : undefined;
		return collaboratorToolBlock(this.effectiveProfile(configured), toolName, path, cwd);
	}

	/** A workspace-write collaborator falls back to read-only until its worktree and held identity are both proven. */
	private effectiveProfile(configured: HostedCollaboratorProfile): HostedCollaboratorProfile {
		if (configured !== "workspace-write") return configured;
		if (!this.session.store.worktree) return "read-only";
		return this.session.store.identity?.disposition === "held" ? "workspace-write" : "read-only";
	}

	async manage(input: CollaboratorManageInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		if (input.participants.length < 1 || input.participants.length > COLLABORATOR_BATCH_LIMIT) {
			throw new HostedRuntimeClientError("invalid_request", "Collaborator management requires 1 to 12 participants.");
		}
		if (input.action === "start") return this.exclusively(async () => this.startCollaborators(input, ctx, signal));
		if (input.callerParticipantId || input.participants.some(hasStartOnlyFields)) {
			const detail = "Only collaborator starts accept caller identity, driver, model, persona, or profile fields.";
			throw new HostedRuntimeClientError("invalid_request", detail);
		}
		return this.changeCollaborators(input.action, input.protocol, input.participants, ctx, signal);
	}

	private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
		if (this.manageActive) throw new HostedRuntimeClientError("busy", "Another collaborator lifecycle operation is already in progress.");
		this.manageActive = true;
		try {
			return await operation();
		} finally {
			this.manageActive = false;
		}
	}

	/** One confirmation, then one launch path for every requested collaborator. */
	private async startCollaborators(
		input: CollaboratorManageInput,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<CollaboratorManageResult[]> {
		throwIfAborted(signal);
		assertInteractiveHerdrStart(ctx);
		const identity = this.session.store.identity;
		if (identity?.disposition === "ended") {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity has ended; explicit revival is required.");
		}
		const protocol = collaboratorName(identity?.protocol ?? input.protocol, "protocol");
		const callerParticipantId = collaboratorName(identity?.participantId ?? input.callerParticipantId, "caller participant ID");
		if (identity && requestsOtherIdentity(input, protocol, callerParticipantId)) {
			throw new HostedRuntimeClientError("conflict", `Current collaborator identity is ${protocol}/${callerParticipantId}.`);
		}
		const candidates = input.participants.map((participant) => resolveCollaboratorCandidate(participant));
		assertDistinctCandidates(candidates, callerParticipantId);
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		throwIfAborted(signal);
		const held = this.heldCaller(participants, protocol, callerParticipantId, registration);
		assertStartableChildren(participants, protocol, candidates);
		const acquires = held === undefined;
		const confirmed = await confirmStart({ ctx, protocol, callerParticipantId, acquires, candidates, participants, signal });
		throwIfAborted(signal);
		if (!confirmed) return candidates.map((candidate) => ({ participant: `${protocol}/${candidate.participantId}`, status: "declined" }));
		const caller = held ?? await this.acquireCaller(protocol, callerParticipantId, registration);
		const start: CollaboratorStart = { ctx, protocol, registration, caller, projectRoot: realpathSync(ctx.cwd), signal };
		return this.launchAll(start, candidates, participants);
	}

	/** The caller participant this Pi target already holds, or undefined when the start must acquire it. */
	private heldCaller(
		participants: ClientParticipantStatus[],
		protocol: string,
		participantId: string,
		registration: LiveClientRegistration,
	): ClientParticipantStatus | undefined {
		const caller = findByName(participants, protocol, participantId);
		if (!caller) return undefined;
		if (caller.state === "ended") {
			throw new HostedRuntimeClientError("conflict", "Ended caller identities require explicit /runtime collaborate revival.");
		}
		if (caller.state !== "held") return undefined;
		if (caller.holderTargetKey !== registration.targetKey) {
			const detail = `Current collaborator identity ${protocol}/${participantId} is held by another Pi target.`;
			throw new HostedRuntimeClientError("conflict", detail);
		}
		const known = this.session.store.identity;
		const recorded = known?.participantKey === caller.participantKey && known.generation === caller.generation;
		if (!recorded) {
			this.session.store.persistIdentity({
				protocol,
				participantId,
				participantKey: caller.participantKey,
				generation: caller.generation,
				disposition: "held",
			});
		}
		return caller;
	}

	private async acquireCaller(
		protocol: string,
		participantId: string,
		registration: LiveClientRegistration,
	): Promise<ClientParticipantStatus> {
		const params = { ...auth(registration), protocol, participantId, revive: false };
		const acquired = parseAcquireResult(await this.client.call("participant.acquire", params));
		this.session.store.persistIdentity({
			protocol,
			participantId,
			participantKey: acquired.participant.participantKey,
			generation: acquired.participant.generation,
			disposition: "held",
		});
		return acquired.participant;
	}

	private async launchAll(
		start: CollaboratorStart,
		candidates: ResolvedCollaboratorCandidate[],
		participants: ClientParticipantStatus[],
	): Promise<CollaboratorManageResult[]> {
		const results = Array<CollaboratorManageResult>(candidates.length);
		await runBounded(candidates.length, start.signal, async (index) => {
			const candidate = candidates[index];
			if (!candidate) return;
			const participant = `${start.protocol}/${candidate.participantId}`;
			try {
				const paneId = await this.launch(start, candidate, findByName(participants, start.protocol, candidate.participantId));
				results[index] = { participant, status: "started", paneId };
			} catch (error) {
				results[index] = {
					participant,
					status: start.signal?.aborted ? "cancelled" : "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		});
		candidates.forEach((candidate, index) => {
			if (!results[index]) results[index] = { participant: `${start.protocol}/${candidate.participantId}`, status: "cancelled" };
		});
		return results;
	}

	private async launch(
		start: CollaboratorStart,
		candidate: ResolvedCollaboratorCandidate,
		existing: ClientParticipantStatus | undefined,
	): Promise<string> {
		const spec = DRIVERS[candidate.driver];
		const plan = this.native.plan(start.protocol, candidate.participantId, start.projectRoot);
		const current = this.session.scope(start.ctx, start.registration);
		this.native.beginLaunch(plan.targetKey);
		try {
			return await this.launchAgent({ start, candidate, existing, spec, plan, current });
		} finally {
			this.native.finishLaunch(plan.targetKey);
		}
	}

	/** Worktree, tab, `herdr agent start`, bind, record — and a best-effort stop of whatever started when one step fails. */
	private async launchAgent(request: CollaboratorLaunchRequest): Promise<string> {
		const { start, candidate, existing, spec, plan } = request;
		throwIfAborted(start.signal);
		const worktreePath = candidate.profile === "workspace-write"
			? await this.ensureWorktree(start, candidate.participantId)
			: undefined;
		const launchCwd = worktreePath ?? start.projectRoot;
		if (standingDown(existing)) await this.replaceStoodDown(existing, start.registration);
		const tab = await createCollaboratorTab(this.pi, launchCwd, candidate.participantId, tabEnvironment(spec, start, candidate));
		let sessionFile: string | undefined;
		try {
			if (worktreePath) await waitForHerdrPaneCwd(this.pi, tab, launchCwd, start.signal);
			this.session.requireCurrentScope(request.current);
			const mcp = spec.bind && worktreePath ? await this.native.messagingConfiguration(plan, candidate.persona?.prompt) : undefined;
			if (mcp) notifyNativePrompt(start.ctx, tab.paneId);
			if (!spec.bind) sessionFile = this.createCollaboratorSession(start.projectRoot, launchCwd, candidate);
			const input = { profile: candidate.profile, cwd: launchCwd, sessionFile, model: candidate.model, persona: candidate.persona, mcp };
			const agent = await this.native.startAgent({ agentName: plan.agentName, spec, tab, argv: driverLaunchArgv(candidate.driver, input) });
			this.session.requireCurrentScope(request.current);
			await this.bindLaunched(request, { tab, cwd: launchCwd, agentSession: agent.agentSession, messagingConfigured: mcp !== undefined });
			start.ctx.ui.notify(`Collaborator ${start.protocol}/${candidate.participantId} started in ${tab.paneId}.`, "info");
			return tab.paneId;
		} catch (error) {
			await this.stopStarted(tab, sessionFile);
			throw error;
		}
	}

	private async bindLaunched(request: CollaboratorLaunchRequest, started: StartedCollaborator): Promise<void> {
		const { start, candidate, existing, spec, plan } = request;
		const driver = spec.bind;
		if (!driver) return;
		if (!candidate.profile) throw new HostedRuntimeClientError("conflict", "Native collaborator launch requires a resolved profile.");
		await this.native.bindLaunched({
			ctx: start.ctx,
			registration: start.registration,
			plan,
			driver,
			profile: candidate.profile,
			protocol: start.protocol,
			participantId: candidate.participantId,
			projectRoot: start.projectRoot,
			cwd: started.cwd,
			tab: started.tab,
			agentSession: started.agentSession,
			callerParticipantKey: start.caller.participantKey,
			expectedCallerGeneration: start.caller.generation,
			expectedParticipantGeneration: existing?.generation,
			messagingConfigured: started.messagingConfigured,
		});
	}

	/** Best effort: a failed launch leaves no tab, no prepared session and no persisted authority behind. */
	private async stopStarted(tab: CollaboratorTab, sessionFile: string | undefined): Promise<void> {
		try {
			await this.pi.exec("herdr", ["tab", "close", tab.tabId], { timeout: 5_000 });
			if (sessionFile) rmSync(sessionFile, { force: true });
		} catch {}
	}

	private async ensureWorktree(start: CollaboratorStart, participantId: string): Promise<string> {
		const params = {
			...auth(start.registration),
			callerParticipantKey: start.caller.participantKey,
			expectedCallerGeneration: start.caller.generation,
			protocol: start.protocol,
			participantId,
		};
		return text(strictObject(await this.client.call("worktree.ensure", params), "Collaborator worktree").path);
	}

	private createCollaboratorSession(projectRoot: string, cwd: string, candidate: ResolvedCollaboratorCandidate): string {
		const sessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const sessionCwd = realpathSync(cwd);
		const directory = join(this.session.root, "collaborator-sessions");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const sessionFile = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		const record: HostedSessionRecord = { version: 3, launch: piCollaboratorLaunch(candidate) };
		if (sessionCwd !== projectRoot) record.worktree = { projectRoot, worktreePath: sessionCwd };
		const entries: Array<SessionHeader | CustomEntry<HostedSessionRecord>> = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: sessionCwd },
			{ type: "custom", customType: HOSTED_SESSION_ENTRY, data: record, id: randomUUID(), parentId: null, timestamp },
		];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
		return sessionFile;
	}

	private async changeCollaborators(
		action: "stand_down" | "stop",
		requestedProtocol: string | undefined,
		candidates: CollaboratorCandidate[],
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<CollaboratorManageResult[]> {
		return this.exclusively(async () => {
			throwIfAborted(signal);
			if (!ctx.hasUI) {
				throw new HostedRuntimeClientError("host_unavailable", "Collaborator lifecycle confirmation requires an interactive Pi session.");
			}
			if (!ctx.isProjectTrusted()) {
				throw new HostedRuntimeClientError("untrusted", "Collaborator lifecycle changes require a trusted project.");
			}
			const protocol = collaboratorName(requestedProtocol ?? this.session.store.identity?.protocol, "protocol");
			const registration = await this.session.requireRegistration(ctx);
			const targets = await this.resolveChangeTargets(protocol, candidates, registration);
			const actionable = action === "stand_down" ? targets.filter((participant) => participant.state === "held") : targets;
			const results = Array<CollaboratorManageResult>(targets.length);
			if (action === "stand_down") targets.forEach((participant, index) => {
				if (participant.state !== "vacant") return;
				results[index] = { participant: `${protocol}/${participant.participantId}`, status: "already_vacant" };
			});
			if (actionable.length === 0) return results;
			if (!await confirmChange(action, protocol, actionable, ctx, signal)) {
				fillRemaining(results, targets, protocol, "declined");
				return results;
			}
			await runBounded(actionable.length, signal, async (index) => {
				const participant = actionable[index];
				if (!participant) return;
				results[targets.indexOf(participant)] = await this.changeParticipant(action, protocol, participant, registration, signal);
			});
			fillRemaining(results, targets, protocol, "cancelled");
			return results;
		});
	}

	private async resolveChangeTargets(
		protocol: string,
		candidates: CollaboratorCandidate[],
		registration: LiveClientRegistration,
	): Promise<ClientParticipantStatus[]> {
		const participantIds = candidates.map((candidate) => collaboratorName(candidate.participantId, "participant ID"));
		if (new Set(participantIds).size !== participantIds.length) {
			throw new HostedRuntimeClientError("conflict", "Collaborator participant IDs must be unique.");
		}
		const participants = await this.session.listParticipants(registration);
		return participantIds.map((participantId) => {
			const participant = participants.find((candidate) => candidate.protocol === protocol && candidate.participantId === participantId);
			if (!participant) throw new HostedRuntimeClientError("not_found", `No ${protocol}/${participantId} participant exists.`);
			if (participant.state === "ended") throw new HostedRuntimeClientError("conflict", `Participant ${protocol}/${participantId} has ended.`);
			return participant;
		});
	}

	private async changeParticipant(
		action: "stand_down" | "stop",
		protocol: string,
		participant: ClientParticipantStatus,
		registration: LiveClientRegistration,
		signal?: AbortSignal,
	): Promise<CollaboratorManageResult> {
		const name = `${protocol}/${participant.participantId}`;
		try {
			const status = action === "stand_down"
				? await this.standDownParticipant(participant, registration)
				: await this.stopParticipant(participant, registration);
			return { participant: name, status };
		} catch (error) {
			return {
				participant: name,
				status: signal?.aborted ? "cancelled" : "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async standDownParticipant(participant: ClientParticipantStatus, registration: LiveClientRegistration): Promise<"stood_down"> {
		const params = {
			...auth(registration),
			participantKey: participant.participantKey,
			expectedGeneration: participant.generation,
			confirmed: true,
		};
		const changed = parseParticipant(await this.client.call("participant.stand_down_confirmed", params));
		const identity = this.session.store.identity;
		if (identity?.participantKey === changed.participantKey) {
			this.session.store.persistIdentity({ ...identity, generation: changed.generation, disposition: "vacant" });
		}
		return "stood_down";
	}

	private async stopParticipant(
		participant: ClientParticipantStatus,
		registration: LiveClientRegistration,
	): Promise<"stopped" | "already_stopped" | "unmanaged"> {
		const params = {
			...auth(registration),
			participantKey: participant.participantKey,
			expectedGeneration: participant.generation,
			confirmed: true,
		};
		const response = strictObject(await this.client.call("participant.stop_confirmed", params), "Collaborator stop result");
		const changed = parseParticipant(response.participant);
		const outcome = response.outcome;
		if (outcome !== "stopped" && outcome !== "already_stopped" && outcome !== "unmanaged") {
			throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid collaborator stop outcome.");
		}
		const identity = this.session.store.identity;
		if (identity?.participantKey === changed.participantKey && changed.state === "vacant") {
			this.session.store.persistIdentity({ ...identity, generation: changed.generation, disposition: "vacant" });
		}
		const control = participant.holderTargetKey ? this.session.store.agent(participant.holderTargetKey) : undefined;
		if (control && outcome !== "unmanaged") this.native.markStopped(control);
		return outcome;
	}

	private async replaceStoodDown(existing: ClientParticipantStatus, registration: LiveClientRegistration): Promise<void> {
		const params = {
			...auth(registration),
			participantKey: existing.participantKey,
			expectedGeneration: existing.generation,
			confirmed: true,
		};
		const stopped = strictObject(await this.client.call("participant.stop_confirmed", params), "Stood-down collaborator replacement");
		if (stopped.outcome !== "stopped" && stopped.outcome !== "already_stopped") {
			throw new HostedRuntimeClientError("conflict", "The exact stood-down collaborator process could not be replaced safely.");
		}
	}

	async manageWorktrees(input: CollaboratorWorktreeInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<SerializedValue> {
		throwIfAborted(signal);
		const identity = this.session.requireParticipantIdentity();
		if (identity.disposition !== "held" || !identity.participantKey || !identity.generation) {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity is not authoritatively held.");
		}
		const registration = await this.session.requireRegistration(ctx);
		if (input.action === "list") {
			return parseSerializedResponse(await this.client.call("worktree.list", auth(registration)), "Worktree listing");
		}
		if (!ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Worktree cleanup requires an interactive trusted Pi session.");
		const participantId = collaboratorName(input.participantId, "participant ID");
		const detail = `Force-remove the worktree of ${identity.protocol}/${participantId}`
			+ ` and delete branch runtime/collab/${identity.protocol}/${participantId}?`
			+ " Uncommitted or unmerged work in it is lost.";
		if (!await ctx.ui.confirm("Remove collaborator worktree?", detail, { signal })) return { declined: true };
		const params = {
			...auth(registration),
			callerParticipantKey: identity.participantKey,
			expectedCallerGeneration: identity.generation,
			protocol: identity.protocol,
			participantId,
			discardConfirmed: true,
		};
		return parseSerializedResponse(await this.client.call("worktree.remove", params), "Worktree removal");
	}
}

function piCollaboratorLaunch(candidate: ResolvedCollaboratorCandidate): CollaboratorLaunch {
	const launch: CollaboratorLaunch = { driver: "pi" };
	if (candidate.model) launch.model = candidate.model;
	if (candidate.profile) launch.profile = candidate.profile;
	if (candidate.persona) launch.persona = candidate.persona;
	return launch;
}

/** Self-registering drivers learn which collaborator identity to hold from their tab environment. */
function tabEnvironment(spec: DriverSpec, start: CollaboratorStart, candidate: ResolvedCollaboratorCandidate): string[] {
	if (spec.bind) return [];
	return [`${COLLABORATOR_ENV}=${start.protocol}:${candidate.participantId}`];
}

function notifyNativePrompt(ctx: ExtensionContext, paneId: string): void {
	const prompt = `Complete any native trust or permission prompt in ${paneId}.`
		+ " Runtime will not accept it for you; startup has a bounded timeout.";
	ctx.ui.notify(prompt, "info");
}

function standingDown(participant: ClientParticipantStatus | undefined): participant is ClientParticipantStatus {
	if (participant?.state !== "vacant") return false;
	return participant.lastTransition.cause === "stand_down";
}

function findByName(participants: ClientParticipantStatus[], protocol: string, participantId: string): ClientParticipantStatus | undefined {
	return participants.find((participant) => participant.protocol === protocol && participant.participantId === participantId);
}

function requestsOtherIdentity(input: CollaboratorManageInput, protocol: string, callerParticipantId: string): boolean {
	if (input.protocol && input.protocol !== protocol) return true;
	return Boolean(input.callerParticipantId) && input.callerParticipantId !== callerParticipantId;
}

function hasStartOnlyFields(participant: CollaboratorCandidate): boolean {
	return participant.driver !== undefined
		|| participant.model !== undefined
		|| participant.persona !== undefined
		|| participant.profile !== undefined;
}

function assertHerdrWorkspace(): void {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
		throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires this Pi session to run inside Herdr.");
	}
}

function assertInteractiveHerdrStart(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		throw new HostedRuntimeClientError("host_unavailable", "Collaborator start confirmation requires an interactive Pi session.");
	}
	if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator start requires a trusted project.");
	assertHerdrWorkspace();
}

function assertDistinctCandidates(candidates: ResolvedCollaboratorCandidate[], callerParticipantId: string): void {
	const participantIds = candidates.map((candidate) => candidate.participantId);
	if (new Set(participantIds).size !== participantIds.length) {
		throw new HostedRuntimeClientError("conflict", "Collaborator participant IDs must be unique.");
	}
	if (participantIds.includes(callerParticipantId)) {
		throw new HostedRuntimeClientError("conflict", "Caller and child collaborator identities must differ.");
	}
}

function assertStartableChildren(
	participants: ClientParticipantStatus[],
	protocol: string,
	candidates: ResolvedCollaboratorCandidate[],
): void {
	for (const candidate of candidates) {
		const existing = findByName(participants, protocol, candidate.participantId);
		if (existing?.state === "held") {
			throw new HostedRuntimeClientError("conflict", `Participant ${protocol}/${candidate.participantId} already has a holder.`);
		}
		if (existing?.state === "ended") {
			throw new HostedRuntimeClientError("conflict", `Ended collaborator ${protocol}/${candidate.participantId} requires explicit revival.`);
		}
	}
}

function confirmChange(
	action: "stand_down" | "stop",
	protocol: string,
	actionable: ClientParticipantStatus[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<boolean> {
	const summary = actionable.map((participant) => `${protocol}/${participant.participantId}`).join("\n");
	const detail = action === "stand_down"
		? "Vacate these collaborators and preserve their queued messages?"
		: "Vacate these collaborators, preserve queued messages, and terminate only their exact plugin-managed Herdr tabs?";
	const title = `${action === "stand_down" ? "Stand down" : "Stop"} Runtime collaborators?`;
	return ctx.ui.confirm(title, `${detail}\n\n${summary}`, { signal });
}

/** The one start dialog: caller, project, and every requested driver, model, persona, profile and worktree. */
function confirmStart(request: StartConfirmation): Promise<boolean> {
	const { ctx, protocol, callerParticipantId, candidates } = request;
	const projectRoot = realpathSync(ctx.cwd);
	const summary = candidates.map((candidate) => {
		const worktree = candidate.profile === "workspace-write" ? "yes" : "no";
		const replaces = standingDown(findByName(request.participants, protocol, candidate.participantId)) ? "yes" : "no";
		return `${protocol}/${candidate.participantId} — ${collaboratorConfiguration(candidate)},`
			+ ` isolated worktree ${worktree}, replace stood-down process ${replaces}`;
	}).join("\n");
	const caller = request.acquires
		? `Acquire ${protocol}/${callerParticipantId} and start`
		: `As ${protocol}/${callerParticipantId}, start`;
	const title = candidates.length === 1 ? "Start Runtime collaborator?" : "Start Runtime collaborators?";
	const detail = `${caller} ${candidates.length} collaborator(s) in no-focus Herdr tabs of project ${projectRoot},`
		+ ` with concurrency up to ${COLLABORATOR_CONCURRENCY}?\n\n${summary}`;
	return ctx.ui.confirm(title, detail, { signal: request.signal });
}

function fillRemaining(
	results: CollaboratorManageResult[],
	targets: ClientParticipantStatus[],
	protocol: string,
	status: CollaboratorManageResult["status"],
): void {
	targets.forEach((participant, index) => {
		if (!results[index]) results[index] = { participant: `${protocol}/${participant.participantId}`, status };
	});
}

/** Runs indexed work with bounded concurrency, surfacing the first worker rejection. */
async function runBounded(total: number, signal: AbortSignal | undefined, task: (index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < total) {
			if (signal?.aborted) return;
			await task(next++);
		}
	};
	const settled = await Promise.allSettled(Array.from({ length: Math.min(COLLABORATOR_CONCURRENCY, total) }, worker));
	const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;
}
