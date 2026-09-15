import { realpathSync } from "node:fs";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
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
import { throwIfAborted } from "./herdr.ts";
import { type HostedCollaboratorProfile, isEnded, isHeld, isVacant, isWriter } from "./schemas/state.ts";
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
} from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";

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

export interface CollaboratorWorktreeInput {
	action: "list" | "cleanup";
	participantId?: string;
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

/** Owns collaborator lifecycle: listing, confirmed start/stand-down/stop, launches and worktrees. */
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
		if (!this.session.store.worktree) return "read-only";
		return isHeld(this.session.store.identity?.disposition) ? "workspace-write" : "read-only";
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
		const auto = this.session.store.auto;
		assertInteractiveHerdrStart(ctx, auto);
		const identity = this.session.store.identity;
		if (isEnded(identity?.disposition)) {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity has ended; explicit revival is required.");
		}
		if (!identity && !(input.protocol && input.callerParticipantId)) {
			const detail = "Pass protocol (this project's collaboration name) and callerParticipantId (your own name in it), or run /runtime collaborate <protocol> <id> first.";
			throw new HostedRuntimeClientError("invalid_request", detail);
		}
		const protocol = collaboratorName(identity?.protocol ?? input.protocol, "protocol");
		const callerParticipantId = collaboratorName(identity?.participantId ?? input.callerParticipantId, "caller participant ID");
		if (identity && requestsOtherIdentity(input, protocol, callerParticipantId)) {
			throw new HostedRuntimeClientError("conflict", `Current collaborator identity is ${protocol}/${callerParticipantId}.`);
		}
		const candidates = input.participants.map((participant) => resolveCollaboratorCandidate(participant));
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		throwIfAborted(signal);
		const held = await this.heldCaller(participants, protocol, callerParticipantId, registration, ctx, auto, signal);
		const acquires = held === undefined;
		const confirmed = auto || await confirmStart({ ctx, protocol, callerParticipantId, acquires, candidates, participants, signal });
		throwIfAborted(signal);
		if (!confirmed) return candidates.map((candidate) => ({ participant: `${protocol}/${candidate.participantId}`, status: "declined" }));
		const caller = held ?? await this.acquireCaller(protocol, callerParticipantId, registration);
		const start: CollaboratorStart = { ctx, protocol, registration, caller, projectRoot: realpathSync(ctx.cwd), signal };
		return this.launchAll(start, candidates, participants);
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
		if (!caller) return undefined;
		if (isEnded(caller.state)) {
			throw new HostedRuntimeClientError("conflict", "Ended caller identities require explicit /runtime collaborate revival.");
		}
		if (!isHeld(caller.state)) return undefined;
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
		const params = { ...auth(registration), participantKey: caller.participantKey, expectedGeneration: caller.generation, confirmed: true };
		const participant = parseParticipant(await this.client.call("participant.takeover", params));
		this.session.store.persistHeld(protocol, participantId, participant);
		ctx.ui.notify(`Took over ${protocol}/${participantId} from its offline Pi session.`, "info");
		return participant;
	}

	private async acquireCaller(
		protocol: string,
		participantId: string,
		registration: LiveClientRegistration,
	): Promise<ClientParticipantStatus> {
		const params = { ...auth(registration), protocol, participantId, revive: false };
		const acquired = parseAcquireResult(await this.client.call("participant.acquire", params));
		this.session.store.persistHeld(protocol, participantId, acquired.participant);
		return acquired.participant;
	}

	/** Twelve launches at most, each already gated by one confirmation and its own Herdr exec. */
	private launchAll(
		start: CollaboratorStart,
		candidates: ResolvedCollaboratorCandidate[],
		participants: ClientParticipantStatus[],
	): Promise<CollaboratorManageResult[]> {
		return Promise.all(candidates.map(async (candidate) => {
			const participant = `${start.protocol}/${candidate.participantId}`;
			try {
				const existing = findParticipant(participants, start.protocol, candidate.participantId);
				return { participant, status: "started" as const, paneId: await this.launcher.launch(start, candidate, existing) };
			} catch (error) {
				return { participant, status: outcome(start.signal), error: error instanceof Error ? error.message : String(error) };
			}
		}));
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
			const auto = this.session.store.auto;
			if (!auto && !ctx.hasUI) {
				throw new HostedRuntimeClientError("host_unavailable", "Collaborator lifecycle confirmation requires an interactive Pi session.");
			}
			if (!ctx.isProjectTrusted()) {
				throw new HostedRuntimeClientError("untrusted", "Collaborator lifecycle changes require a trusted project.");
			}
			const protocol = collaboratorName(requestedProtocol ?? this.session.store.identity?.protocol, "protocol");
			const registration = await this.session.requireRegistration(ctx);
			const targets = await this.resolveChangeTargets(protocol, candidates, registration);
			const skipped = action === "stand_down" ? targets.filter((participant) => !isHeld(participant.state)) : [];
			const actionable = targets.filter((participant) => !skipped.includes(participant));
			const vacated = skipped.map((participant) => settled(protocol, participant, "already_vacant"));
			if (actionable.length === 0) return vacated;
			if (!auto && !await confirmChange(action, protocol, actionable, ctx, signal)) {
				return [...vacated, ...actionable.map((participant) => settled(protocol, participant, "declined"))];
			}
			const changed = await Promise.all(actionable.map((participant) =>
				this.changeParticipant(action, protocol, participant, registration, signal)));
			return [...vacated, ...changed];
		});
	}

	private async resolveChangeTargets(
		protocol: string,
		candidates: CollaboratorCandidate[],
		registration: LiveClientRegistration,
	): Promise<ClientParticipantStatus[]> {
		const participantIds = candidates.map((candidate) => collaboratorName(candidate.participantId, "participant ID"));
		const participants = await this.session.listParticipants(registration);
		return participantIds.map((participantId) => {
			const participant = findParticipant(participants, protocol, participantId);
			if (!participant) throw new HostedRuntimeClientError("not_found", `No ${protocol}/${participantId} participant exists.`);
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
			return { participant: name, status: outcome(signal), error: error instanceof Error ? error.message : String(error) };
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
		if (identity?.participantKey === changed.participantKey && isVacant(changed.state)) {
			this.session.store.persistIdentity({ ...identity, generation: changed.generation, disposition: "vacant" });
		}
		const control = participant.holderTargetKey ? this.session.store.agent(participant.holderTargetKey) : undefined;
		if (control && outcome !== "unmanaged") this.native.markStopped(control);
		return outcome;
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
		const auto = this.session.store.auto;
		if (!auto && !ctx.hasUI) throw new HostedRuntimeClientError("host_unavailable", "Worktree cleanup requires an interactive trusted Pi session.");
		const participantId = collaboratorName(input.participantId, "participant ID");
		const detail = `Force-remove the worktree of ${identity.protocol}/${participantId}`
			+ ` and delete branch runtime/collab/${identity.protocol}/${participantId}?`
			+ " Uncommitted or unmerged work in it is lost.";
		if (!auto && !await ctx.ui.confirm("Remove collaborator worktree?", detail, { signal })) return { declined: true };
		const params = {
			...auth(registration),
			callerParticipantKey: identity.participantKey,
			expectedCallerGeneration: identity.generation,
			protocol: identity.protocol,
			participantId,
			discardConfirmed: true,
		};
		return parseWorktreeRemoval(await this.client.call("worktree.remove", params));
	}
}

function settled(
	protocol: string,
	participant: ClientParticipantStatus,
	status: CollaboratorManageResult["status"],
): CollaboratorManageResult {
	return { participant: `${protocol}/${participant.participantId}`, status };
}

/** A cancelled batch reports cancellation, not failure, for whatever its abort interrupted. */
function outcome(signal: AbortSignal | undefined): CollaboratorManageResult["status"] {
	return signal?.aborted ? "cancelled" : "failed";
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

function assertInteractiveHerdrStart(ctx: ExtensionContext, auto: boolean): void {
	if (!auto && !ctx.hasUI) {
		throw new HostedRuntimeClientError("host_unavailable", "Collaborator start confirmation requires an interactive Pi session.");
	}
	if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator start requires a trusted project.");
	assertHerdrWorkspace();
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

