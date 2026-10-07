import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { loadKitConfig, readCodexCatalog, type ModelContext } from "../shared/models.ts";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import { CollaboratorLauncher, standingDown, type CollaboratorStart } from "./collaborator-launch.ts";
import {
	collaboratorConfiguration,
	collaboratorName,
	collaboratorToolBlock,
	resolveCollaboratorCandidate,
	type CollaboratorCandidate,
	type CollaboratorToolBlock,
	type ResolvedCollaboratorCandidate,
} from "./collaborator-policy.ts";
import { RuntimeError } from "./errors.ts";
import { delay, throwIfAborted } from "./herdr.ts";
import { isAutonomous } from "../shared/autonomy.ts";
import { resolveCollaboratorRepo } from "./service/worktree.ts";
import { type HostedCollaboratorProfile, isHeld, isVacant, isWriter } from "./schemas/state.ts";
import { decodeHerdr, herdrResult, HerdrLiveAgentResultSchema, HerdrTabResultSchema } from "./schemas/herdr.ts";
import type { NativeAgentService } from "./native-agents.ts";
import {
	auth,
	findParticipant,
	parseAcquireResult,
	parseParticipant,
	parseWorktreeList,
	parseWorktreeRemoval,
	strictObject,
	type ClientParticipantStatus,
	type ClientWorktreeList,
	type ClientWorktreeRemoval,
	type LiveClientRegistration,
	type RegistrationAuth,
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import { AGENT_NAME } from "./schemas/common.ts";

/** The lead is main and its collaborators share one protocol per project, so neither needs naming. */
export const LEAD = "main";
const DEFAULT_PROTOCOL = "collab";
/** The foreground-wait rail: a stand-down never holds the lead longer than this for a final reply. */
const STAND_DOWN_GRACE_MS = 120_000;
const STAND_DOWN_POLL_MS = 1_000;

export interface CollaboratorManageResult {
	participant: string;
	status: "started" | "stood_down" | "already_vacant" | "failed" | "declined" | "cancelled";
	paneId?: string;
	driver?: string;
	profile?: string;
	error?: string;
}

interface WorktreeRemoveParams extends RegistrationAuth {
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	protocol: string;
	participantId: string;
	repo?: string;
	discardConfirmed: true;
}

export interface CollaboratorWorktreeInput {
	action: "list" | "cleanup";
	name?: string;
	repo?: string;
}

export type CollaboratorWorktreeResult = ClientWorktreeList | ClientWorktreeRemoval | { declined: true };

interface StartConfirmation {
	ctx: ExtensionContext;
	protocol: string;
	callerParticipantId: string;
	acquires: boolean;
	candidates: ResolvedCollaboratorCandidate[];
	participants: ClientParticipantStatus[];
	signal?: AbortSignal;
}

/** Owns collaborator lifecycle: listing, confirmed start and stand-down, launches and worktrees. */
export class CollaboratorService {
	private readonly session: RuntimeSession;
	private readonly native: NativeAgentService;
	private readonly launcher: CollaboratorLauncher;
	private manageActive = false;

	constructor(session: RuntimeSession, native: NativeAgentService) {
		this.session = session;
		this.native = native;
		this.launcher = new CollaboratorLauncher(session, native);
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
		if (!isWriter(configured)) return configured;
		if (!this.session.store.worktree?.worktreePath) return "read-only";
		return isHeld(this.session.store.identity?.disposition) ? "workspace-write" : "read-only";
	}

	start(participants: CollaboratorCandidate[], ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		return this.exclusively(() => this.startCollaborators(participants, ctx, signal));
	}

	/** Lets a reply in flight land, then vacates the collaborator and closes its tab; a later message resumes it. */
	standDown(participantId: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult> {
		return this.exclusively(async () => {
			throwIfAborted(signal);
			const auto = await assertLifecycleAllowed(ctx, "Collaborator stand-down");
			const protocol = this.session.store.identity?.protocol ?? DEFAULT_PROTOCOL;
			const registration = await this.session.requireRegistration(ctx);
			const participant = findParticipant(await this.session.listParticipants(registration), protocol, participantId);
			if (!participant) throw new HostedRuntimeClientError("not_found", `No collaborator named ${participantId}.`);
			if (!isHeld(participant.state)) return settled(participant, "already_vacant");
			const detail = "Let it land a reply in flight (up to 2 min), then vacate it and close its Herdr tab, keeping queued messages and its transcript?";
			if (!auto && !await ctx.ui.confirm("Stand down collaborator?", `${detail}\n\n${participantId}`, { signal })) return settled(participant, "declined");
			try {
				await this.standDownParticipant(participant, registration, signal);
				return settled(participant, "stood_down");
			} catch (error) {
				return { ...settled(participant, outcome(signal)), error: error instanceof Error ? error.message : String(error) };
			}
		});
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
		requested: CollaboratorCandidate[],
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<CollaboratorManageResult[]> {
		throwIfAborted(signal);
		const auto = await assertLifecycleAllowed(ctx, "Collaborator start");
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
			throw new HostedRuntimeClientError("host_unavailable", "Collaborator start requires this Pi session to run inside Herdr.");
		}
		const identity = this.session.store.identity;
		const protocol = identity?.protocol ?? DEFAULT_PROTOCOL;
		const callerParticipantId = identity?.participantId ?? LEAD;
		const models: ModelContext = {
			config: await loadKitConfig(ctx.cwd, getAgentDir()),
			registry: ctx.modelRegistry,
			lead: ctx.model ? { model: ctx.model, level: this.session.pi.getThinkingLevel() } : undefined,
			codex: readCodexCatalog(process.env.CODEX_HOME || join(homedir(), ".codex")),
		};
		const candidates = requested.map((participant) => resolveCollaboratorCandidate(participant, models));
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		const projectRoot = realpathSync(ctx.cwd);
		await Promise.all(candidates.map((candidate) => resolveCandidateRepo(candidate, projectRoot, findParticipant(participants, protocol, candidate.participantId))));
		throwIfAborted(signal);
		const held = await this.heldCaller(participants, protocol, callerParticipantId, registration, ctx, auto, signal);
		const acquires = held === undefined;
		const confirmed = auto || await confirmStart({ ctx, protocol, callerParticipantId, acquires, candidates, participants, signal });
		throwIfAborted(signal);
		if (!confirmed) return candidates.map((candidate) => ({ participant: candidate.participantId, status: "declined" }));
		const caller = held ?? await this.acquireCaller(protocol, callerParticipantId, registration);
		const start: CollaboratorStart = { ctx, protocol, registration, caller, projectRoot, signal };
		return this.launchAll(start, candidates, participants, requested);
	}

	/** The caller participant this Pi target already holds, or undefined when the start must acquire it. */
	private async heldCaller(
		participants: ClientParticipantStatus[],
		protocol: string,
		participantId: string,
		registration: LiveClientRegistration,
		ctx: ExtensionContext,
		auto: boolean,
		signal: AbortSignal | undefined,
	): Promise<ClientParticipantStatus | undefined> {
		const caller = findParticipant(participants, protocol, participantId);
		if (!caller || !isHeld(caller.state)) return undefined;
		if (caller.holderTargetKey !== registration.targetKey) {
			if (caller.holderLive) {
				throw new HostedRuntimeClientError("conflict", `Current collaborator identity ${protocol}/${participantId} is held by another live Pi target.`);
			}
			return this.takeOverCaller(protocol, participantId, caller, registration, ctx, auto, signal);
		}
		const known = this.session.store.identity;
		const recorded = known?.participantKey === caller.participantKey && known.generation === caller.generation;
		if (!recorded) this.session.store.persistHeld(protocol, participantId, caller);
		return caller;
	}

	/** A lead whose previous tab is gone leaves its name held by a dead target; the next lead takes it over instead of failing. */
	private async takeOverCaller(
		protocol: string,
		participantId: string,
		caller: ClientParticipantStatus,
		registration: LiveClientRegistration,
		ctx: ExtensionContext,
		auto: boolean,
		signal: AbortSignal | undefined,
	): Promise<ClientParticipantStatus> {
		const detail = `${protocol}/${participantId} is held by a Pi session that is no longer live. Take over generation ${caller.generation}?`;
		if (!auto && !await ctx.ui.confirm("Take over collaborator identity?", detail, { signal })) {
			throw new HostedRuntimeClientError("conflict", `${protocol}/${participantId} stays held by its offline Pi session.`);
		}
		const participant = parseParticipant(await this.client.call("participant.takeover", confirmed(registration, caller)));
		this.session.store.persistHeld(protocol, participantId, participant);
		ctx.ui.notify(`Took over ${protocol}/${participantId} from its offline Pi session.`, "info");
		return participant;
	}

	private async acquireCaller(
		protocol: string,
		participantId: string,
		registration: LiveClientRegistration,
	): Promise<ClientParticipantStatus> {
		const params = { ...auth(registration), protocol, participantId };
		const acquired = parseAcquireResult(await this.client.call("participant.acquire", params));
		this.session.store.persistHeld(protocol, participantId, acquired.participant);
		return acquired.participant;
	}

	/** Twelve launches at most, each already gated by one confirmation and its own Herdr exec. */
	private launchAll(
		start: CollaboratorStart,
		candidates: ResolvedCollaboratorCandidate[],
		participants: ClientParticipantStatus[],
		requested: CollaboratorCandidate[],
	): Promise<CollaboratorManageResult[]> {
		return Promise.all(candidates.map(async (candidate, index) => {
			const participant = candidate.participantId;
			try {
				const existing = findParticipant(participants, start.protocol, candidate.participantId);
				const tab = await this.launcher.launch(start, candidate, existing);
				const { nativeSession: _resumed, ...spec } = requested[index]!;
				this.session.store.persistStarted({ ...spec, tabId: tab.tabId });
				return { participant, status: "started" as const, paneId: tab.paneId, driver: candidate.driver, profile: candidate.profile };
			} catch (error) {
				return { participant, status: outcome(start.signal), error: error instanceof Error ? error.message : String(error) };
			}
		}));
	}

	/** Another target's collaborator keeps its mail authority until its reply in flight lands, then vacates and its tab closes. */
	private async standDownParticipant(
		participant: ClientParticipantStatus,
		registration: LiveClientRegistration,
		signal?: AbortSignal,
	): Promise<void> {
		const other = participant.holderTargetKey !== registration.targetKey;
		if (other) await this.awaitFinalReply(participant, registration, signal);
		await this.recordNativeSession(participant);
		const changed = parseParticipant(await this.client.call("participant.stand_down_confirmed", confirmed(registration, participant)));
		const identity = this.session.store.identity;
		if (identity?.participantKey === changed.participantKey) {
			this.session.store.persistIdentity({ ...identity, generation: changed.generation, disposition: "vacant" });
		}
		if (other) await this.stopParticipant({ ...changed, holderTargetKey: participant.holderTargetKey }, registration);
	}

	/** A Claude or Codex collaborator resumes its own session later; Herdr knows its id once it ran. */
	private async recordNativeSession(participant: ClientParticipantStatus): Promise<void> {
		const control = participant.holderTargetKey ? this.session.store.agent(participant.holderTargetKey) : undefined;
		const spec = this.session.store.started.get(participant.participantId);
		if (!control || !spec) return;
		const reported = await this.session.pi.exec("herdr", ["agent", "get", control.agentName], { timeout: 2_000 }).catch(() => undefined);
		try {
			const session = decodeHerdr(HerdrLiveAgentResultSchema, herdrResult(reported?.stdout ?? ""), "Herdr agent").agent.agent_session;
			// The id lands in the CLI's argv after --resume, so it must not read as a flag.
			if (session?.kind === "id" && session.source === control.agentSession.source && AGENT_NAME.test(session.value)) {
				this.session.store.persistStarted({ ...spec, nativeSession: session.value });
			}
		} catch {}
	}

	private async awaitFinalReply(participant: ClientParticipantStatus, registration: LiveClientRegistration, signal?: AbortSignal): Promise<void> {
		const params = { ...auth(registration), participantKey: participant.participantKey };
		const deadline = Date.now() + STAND_DOWN_GRACE_MS;
		while (Date.now() < deadline) {
			throwIfAborted(signal);
			const current = parseParticipant(await this.client.call("participant.get", params));
			if (current.generation !== participant.generation || !replyInFlight(current)) return;
			await delay(STAND_DOWN_POLL_MS);
		}
	}

	private async stopParticipant(participant: ClientParticipantStatus, registration: LiveClientRegistration): Promise<void> {
		const response = strictObject(await this.client.call("participant.stop_confirmed", confirmed(registration, participant)), "Collaborator stop result");
		const changed = parseParticipant(response.participant);
		const outcome = response.outcome;
		if (outcome !== "stopped" && outcome !== "already_stopped" && outcome !== "unmanaged") {
			throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid collaborator stop outcome.");
		}
		const identity = this.session.store.identity;
		if (identity?.participantKey === changed.participantKey && isVacant(changed.state)) {
			this.session.store.persistIdentity({ ...identity, generation: changed.generation, disposition: "vacant" });
		}
		const control = participant.holderTargetKey ? this.session.store.agent(participant.holderTargetKey) : undefined;
		if (control && outcome !== "unmanaged") this.native.markStopped(control);
		await this.closeTab(participant.participantId);
	}

	/** The tab the collaborator was started in closes, whatever Herdr reports about its agent, while Herdr still shows it as
	 * that collaborator's lone tab in this workspace: a persisted id can outlive its Herdr server and name someone else's tab. */
	private async closeTab(participantId: string): Promise<void> {
		const spec = this.session.store.started.get(participantId);
		if (!spec?.tabId) return;
		const { tabId, ...rest } = spec;
		this.session.store.persistStarted(rest);
		const shown = await this.session.pi.exec("herdr", ["tab", "get", tabId], { timeout: 2_000 }).catch(() => undefined);
		try {
			const tab = decodeHerdr(HerdrTabResultSchema, herdrResult(shown?.stdout ?? ""), "Herdr tab").tab;
			if (tab.label !== `collaborator:${participantId}` || tab.workspace_id !== process.env.HERDR_WORKSPACE_ID || tab.pane_count !== 1) return;
		} catch {
			return;
		}
		await this.session.pi.exec("herdr", ["tab", "close", tabId], { timeout: 5_000 }).catch(() => undefined);
	}

	async manageWorktrees(input: CollaboratorWorktreeInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorWorktreeResult> {
		throwIfAborted(signal);
		const identity = this.session.requireParticipantIdentity();
		if (!isHeld(identity.disposition) || !identity.participantKey || !identity.generation) {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity is not authoritatively held.");
		}
		const registration = await this.session.requireRegistration(ctx);
		if (input.action === "list") {
			return parseWorktreeList(await this.client.call("worktree.list", auth(registration)));
		}
		const auto = await assertLifecycleAllowed(ctx, "Worktree cleanup");
		const participantId = collaboratorName(input.name, "name");
		const detail = `Force-remove the worktree of ${identity.protocol}/${participantId}`
			+ ` and delete branch runtime/collab/${identity.protocol}/${participantId}?`
			+ " Uncommitted or unmerged work in it is lost.";
		if (!auto && !await ctx.ui.confirm("Remove collaborator worktree?", detail, { signal })) return { declined: true };
		const params: WorktreeRemoveParams = {
			...auth(registration),
			callerParticipantKey: identity.participantKey,
			expectedCallerGeneration: identity.generation,
			protocol: identity.protocol,
			participantId,
			discardConfirmed: true,
		};
		if (input.repo !== undefined) params.repo = input.repo;
		return parseWorktreeRemoval(await this.client.call("worktree.remove", params));
	}
}

function settled(participant: ClientParticipantStatus, status: CollaboratorManageResult["status"]): CollaboratorManageResult {
	return { participant: participant.participantId, status };
}

function confirmed(registration: LiveClientRegistration, participant: ClientParticipantStatus) {
	return { ...auth(registration), participantKey: participant.participantKey, expectedGeneration: participant.generation, confirmed: true };
}

/** Herdr's status and the mail counters say a reply may still come; a blocked or offline holder sends none. */
export function replyInFlight(status: ClientParticipantStatus): boolean {
	if (!status.holderLive || status.agentStatus === "blocked") return false;
	return status.agentStatus === "working" || status.awaitingReply === true;
}

/** A cancelled batch reports cancellation, not failure, for whatever its abort interrupted. */
function outcome(signal: AbortSignal | undefined): CollaboratorManageResult["status"] {
	return signal?.aborted ? "cancelled" : "failed";
}

/** A writer needs a repository before any dialog or tab; a restart reuses the repo the daemon recorded. */
async function resolveCandidateRepo(
	candidate: ResolvedCollaboratorCandidate,
	projectRoot: string,
	existing: ClientParticipantStatus | undefined,
): Promise<void> {
	if (candidate.repo === undefined && existing?.repo !== undefined) candidate.repo = existing.repo;
	if (candidate.repo === undefined && !isWriter(candidate.profile)) return;
	try {
		const repoRoot = await resolveCollaboratorRepo(projectRoot, candidate.repo, candidate.participantId);
		if (repoRoot !== projectRoot) candidate.repoRoot = repoRoot;
	} catch (error) {
		if (error instanceof RuntimeError) throw new HostedRuntimeClientError(error.code, error.message);
		throw error;
	}
}

/** Without autonomy a lifecycle change needs a dialog, so a UI; it always needs a trusted project. Returns autonomy. */
async function assertLifecycleAllowed(ctx: ExtensionContext, what: string): Promise<boolean> {
	const auto = await isAutonomous(ctx);
	if (!auto && !ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", `${what} confirmation requires an interactive Pi session.`);
	if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", `${what} requires a trusted project.`);
	return auto;
}

/** The one start dialog: caller, project, and every requested driver, model, persona, profile and worktree. */
function confirmStart(request: StartConfirmation): Promise<boolean> {
	const { ctx, protocol, callerParticipantId, candidates } = request;
	const projectRoot = realpathSync(ctx.cwd);
	const summary = candidates.map((candidate) => {
		const worktree = isWriter(candidate.profile) ? "yes" : "no";
		const replaces = standingDown(findParticipant(request.participants, protocol, candidate.participantId)) ? "yes" : "no";
		return `${protocol}/${candidate.participantId} — ${collaboratorConfiguration(candidate)},`
			+ ` isolated worktree ${worktree}, replace stood-down process ${replaces}`;
	}).join("\n");
	const caller = request.acquires
		? `Acquire ${protocol}/${callerParticipantId} and start`
		: `As ${protocol}/${callerParticipantId}, start`;
	const title = candidates.length === 1 ? "Start Runtime collaborator?" : "Start Runtime collaborators?";
	const detail = `${caller} ${candidates.length} collaborator(s) in no-focus Herdr tabs of project ${projectRoot}?\n\n${summary}`;
	return ctx.ui.confirm(title, detail, { signal: request.signal });
}

