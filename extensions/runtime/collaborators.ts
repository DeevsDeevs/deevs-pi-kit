import { createHash, randomUUID } from "node:crypto";
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
	HostedCollaboratorStartError,
	READ_ONLY_COLLABORATOR_TOOLS,
	resolveCollaboratorCandidate,
	usesNativeUserConfiguration,
	WORKSPACE_WRITE_COLLABORATOR_TOOLS,
	type CollaboratorCandidate,
	type CollaboratorToolBlock,
	type ResolvedCollaboratorCandidate,
} from "./collaborator-policy.ts";
import { delay, shellQuote, throwIfAborted } from "./herdr.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile } from "./hosted-types.ts";
import { NativeAgentService } from "./native-agents.ts";
import {
	auth,
	errorCode,
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
import type { CollaboratorLaunch, CollaboratorPersona, ParticipantIdentity } from "./session-record.ts";
import { COLLABORATOR_ENV, HOSTED_SESSION_ENTRY, type HostedSessionRecord } from "./session-restore.ts";

const COLLABORATOR_CONCURRENCY = 4;
const COLLABORATOR_BATCH_LIMIT = 12;
const PI_HANDSHAKE_ATTEMPTS = 150;

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

interface CollaboratorStartInput {
	participantId: string;
	protocol?: string;
	callerParticipantId?: string;
	driver?: HostedCollaboratorDriver;
	model?: string;
	persona?: string;
	profile?: HostedCollaboratorProfile;
}

interface CollaboratorStartResult {
	started: boolean;
	participant: string;
	paneId?: string;
}

export type CollaboratorWorktreeInput =
	| { action: "list" }
	| { action: "cleanup"; participantId: string };

interface CollaboratorLaunchRequest {
	ctx: ExtensionContext;
	protocol: string;
	participantId: string;
	allowRevive: boolean;
	caller: ClientParticipantStatus | undefined;
	candidate: ResolvedCollaboratorCandidate;
	signal?: AbortSignal;
}

interface PiHandshakeRequest {
	ctx: ExtensionContext;
	registration: LiveClientRegistration;
	protocol: string;
	participantId: string;
	targetKey: string;
	paneId: string;
	existing: ClientParticipantStatus | undefined;
	signal?: AbortSignal;
}

interface CollaboratorLaunchOptions {
	model?: string;
	profile?: HostedCollaboratorProfile;
	persona?: CollaboratorPersona;
}

interface StartCallerNames {
	identity: ParticipantIdentity | undefined;
	protocol: string;
	callerParticipantId: string;
}

interface ResolvedCaller {
	identity: ParticipantIdentity | undefined;
	protocol: string;
	callerParticipantId: string;
	caller: ClientParticipantStatus | undefined;
	expectedCaller: ClientParticipantStatus | undefined;
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
		if (input.action === "start") return this.manageStart(input, ctx, signal);
		if (input.callerParticipantId || input.participants.some(hasStartOnlyFields)) {
			const detail = "Only collaborator starts accept caller identity, driver, model, persona, or profile fields.";
			throw new HostedRuntimeClientError("invalid_request", detail);
		}
		return this.changeCollaborators(input.action, input.protocol, input.participants, ctx, signal);
	}

	private async manageStart(
		input: CollaboratorManageInput,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<CollaboratorManageResult[]> {
		const single = input.participants.length === 1 ? input.participants[0] : undefined;
		if (single) {
			const result = await this.start({ ...single, protocol: input.protocol, callerParticipantId: input.callerParticipantId }, ctx, signal);
			return [{ participant: result.participant, status: result.started ? "started" : "declined", paneId: result.paneId }];
		}
		const identity = this.session.requireParticipantIdentity();
		if (input.protocol && collaboratorName(input.protocol, "protocol") !== identity.protocol) {
			throw new HostedRuntimeClientError("conflict", `Current collaborator identity uses protocol ${identity.protocol}.`);
		}
		if (input.callerParticipantId && collaboratorName(input.callerParticipantId, "caller participant ID") !== identity.participantId) {
			throw new HostedRuntimeClientError("conflict", `Current collaborator identity is ${identity.protocol}/${identity.participantId}.`);
		}
		return this.startBatch(input.participants, ctx, signal);
	}

	private start(input: CollaboratorStartInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorStartResult> {
		return this.exclusively(async () => this.startConfirmed(input, ctx, signal));
	}

	private startBatch(candidates: CollaboratorCandidate[], ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		return this.exclusively(async () => this.startBatchConfirmed(candidates, ctx, signal));
	}

	startFromCommand(ctx: ExtensionContext, protocol: string, participantId: string, candidate: ResolvedCollaboratorCandidate): Promise<void> {
		return this.exclusively(async () => {
			await this.launchCollaborator({ ctx, protocol, participantId, allowRevive: true, caller: undefined, candidate });
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

	private async startBatchConfirmed(
		candidates: CollaboratorCandidate[],
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<CollaboratorManageResult[]> {
		throwIfAborted(signal);
		if (candidates.length < 1 || candidates.length > COLLABORATOR_BATCH_LIMIT) {
			throw new HostedRuntimeClientError("invalid_request", "Batch collaborator start requires 1 to 12 candidates.");
		}
		assertInteractiveHerdrStart(ctx);
		const identity = this.session.requireParticipantIdentity();
		if (identity.disposition !== "held") {
			throw new HostedRuntimeClientError("conflict", "Batch collaborator start requires this Pi session to hold its collaborator identity.");
		}
		const normalized = candidates.map((candidate) => resolveCollaboratorCandidate(candidate));
		if (new Set(normalized.map((candidate) => candidate.participantId)).size !== normalized.length) {
			throw new HostedRuntimeClientError("conflict", "Batch collaborator participant IDs must be unique.");
		}
		if (normalized.some((candidate) => candidate.participantId === identity.participantId)) {
			throw new HostedRuntimeClientError("conflict", "Caller and child collaborator identities must differ.");
		}
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		const caller = findCaller(participants, identity);
		if (!caller || !batchCallerHolds(caller, identity, registration)) {
			const name = `${identity.protocol}/${identity.participantId}`;
			const detail = `Current collaborator identity ${name} is not authoritatively held by this Pi target.`;
			throw new HostedRuntimeClientError("conflict", detail);
		}
		assertStartableChildren(participants, identity.protocol, normalized);
		const confirmed = await confirmBatchStart(ctx, identity, normalized, participants, signal);
		throwIfAborted(signal);
		if (!confirmed) {
			return normalized.map((candidate) => ({ participant: `${identity.protocol}/${candidate.participantId}`, status: "declined" }));
		}
		return this.launchBatch(ctx, identity.protocol, caller, normalized, signal);
	}

	private async launchBatch(
		ctx: ExtensionContext,
		protocol: string,
		caller: ClientParticipantStatus,
		normalized: ResolvedCollaboratorCandidate[],
		signal?: AbortSignal,
	): Promise<CollaboratorManageResult[]> {
		const results = Array<CollaboratorManageResult>(normalized.length);
		await runBounded(normalized.length, signal, async (index) => {
			const candidate = normalized[index];
			if (!candidate) return;
			const participant = `${protocol}/${candidate.participantId}`;
			try {
				const request: CollaboratorLaunchRequest = {
					ctx,
					protocol,
					participantId: candidate.participantId,
					allowRevive: false,
					caller,
					candidate,
					signal,
				};
				const paneId = await this.launchCollaborator(request);
				results[index] = { participant, status: "started", paneId };
			} catch (error) {
				results[index] = {
					participant,
					status: signal?.aborted ? "cancelled" : "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		});
		normalized.forEach((candidate, index) => {
			if (!results[index]) results[index] = { participant: `${protocol}/${candidate.participantId}`, status: "cancelled" };
		});
		return results;
	}

	private async startConfirmed(
		input: CollaboratorStartInput,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<CollaboratorStartResult> {
		throwIfAborted(signal);
		assertInteractiveHerdrStart(ctx);
		const identity = this.session.store.identity;
		if (identity?.disposition === "ended") {
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity has ended; explicit revival is required.");
		}
		const protocol = collaboratorName(identity?.protocol ?? input.protocol, "protocol");
		const callerParticipantId = collaboratorName(identity?.participantId ?? input.callerParticipantId, "caller participant ID");
		const candidate = resolveCollaboratorCandidate(input);
		if (usesNativeUserConfiguration(candidate) && !ctx.hasUI) {
			throw new HostedRuntimeClientError("host_unavailable", "Normal native configuration requires explicit interactive confirmation.");
		}
		if (identity && requestsOtherIdentity(input, protocol, callerParticipantId)) {
			throw new HostedRuntimeClientError("conflict", `Current collaborator identity is ${protocol}/${callerParticipantId}.`);
		}
		if (candidate.participantId === callerParticipantId) {
			throw new HostedRuntimeClientError("conflict", "Caller and child collaborator identities must differ.");
		}
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		throwIfAborted(signal);
		const resolved = this.reconcileStartCaller({ identity, protocol, callerParticipantId }, participants, registration);
		const child = findByName(participants, protocol, candidate.participantId);
		if (child?.state === "held") throw new HostedRuntimeClientError("conflict", "Participant already has a holder.");
		if (child?.state === "ended") {
			throw new HostedRuntimeClientError("conflict", "Ended collaborator identities require explicit /runtime collaborator-start revival.");
		}
		const participantName = `${protocol}/${candidate.participantId}`;
		const confirmed = await confirmSingleStart(ctx, resolved, candidate, child, signal);
		throwIfAborted(signal);
		if (!confirmed) return { started: false, participant: participantName };
		const paneId = await this.acquireCallerAndLaunch(ctx, resolved, candidate, registration, signal);
		return { started: true, participant: participantName, paneId };
	}

	/** Reconciles the persisted caller identity with what Runtime reports before any child is started. */
	private reconcileStartCaller(
		names: StartCallerNames,
		participants: ClientParticipantStatus[],
		registration: LiveClientRegistration,
	): ResolvedCaller {
		const { identity, protocol, callerParticipantId } = names;
		const byKey = identity?.participantKey ? findByKey(participants, identity.participantKey) : undefined;
		const caller = byKey ?? findByName(participants, protocol, callerParticipantId);
		const identityMatches = caller?.protocol === protocol && caller.participantId === callerParticipantId;
		if (identity && caller && !identityMatches) {
			this.session.store.persistIdentity({ protocol, participantId: callerParticipantId, disposition: "vacant" });
			throw new HostedRuntimeClientError("conflict", "Current collaborator identity key does not match its protocol and participant ID.");
		}
		if (caller?.state === "ended") {
			this.session.store.persistIdentity({
				protocol,
				participantId: callerParticipantId,
				participantKey: caller.participantKey,
				generation: caller.generation,
				disposition: "ended",
			});
			throw new HostedRuntimeClientError("conflict", "Ended caller identities require explicit /runtime collaborate revival.");
		}
		const expectedCaller = this.reconcileHeldCaller(identity, caller, identityMatches, names, registration);
		return { identity, protocol, callerParticipantId, caller, expectedCaller };
	}

	private reconcileHeldCaller(
		identity: ParticipantIdentity | undefined,
		caller: ClientParticipantStatus | undefined,
		identityMatches: boolean,
		names: StartCallerNames,
		registration: LiveClientRegistration,
	): ClientParticipantStatus | undefined {
		const { protocol, callerParticipantId } = names;
		if (caller?.state === "held") {
			if (!identityMatches || caller.holderTargetKey !== registration.targetKey) {
				const detail = `Current collaborator identity ${protocol}/${callerParticipantId} is held by another Pi target.`;
				throw new HostedRuntimeClientError("conflict", detail);
			}
			if (identity?.disposition !== "held" || identity.participantKey !== caller.participantKey || identity.generation !== caller.generation) {
				this.session.store.persistIdentity({
					protocol,
					participantId: callerParticipantId,
					participantKey: caller.participantKey,
					generation: caller.generation,
					disposition: "held",
				});
			}
			return caller;
		}
		if (identity?.disposition !== "held") return undefined;
		const vacated: ParticipantIdentity = { protocol, participantId: callerParticipantId, disposition: "vacant" };
		if (identityMatches && caller) {
			vacated.participantKey = caller.participantKey;
			vacated.generation = caller.generation;
		}
		this.session.store.persistIdentity(vacated);
		const detail = `Current collaborator identity ${protocol}/${callerParticipantId} is not held by this Pi target.`;
		throw new HostedRuntimeClientError("conflict", detail);
	}

	/** Acquires the caller identity when the session had none, rolling it back when the child never came up. */
	private async acquireCallerAndLaunch(
		ctx: ExtensionContext,
		resolved: ResolvedCaller,
		candidate: ResolvedCollaboratorCandidate,
		registration: LiveClientRegistration,
		signal: AbortSignal | undefined,
	): Promise<string | undefined> {
		const { protocol, callerParticipantId, expectedCaller } = resolved;
		let acquiredCaller: ParticipantIdentity | undefined;
		let rollbackCaller = false;
		try {
			let launchCaller = expectedCaller;
			if (!expectedCaller) {
				const params = { ...auth(registration), protocol, participantId: callerParticipantId, revive: false };
				const acquired = parseAcquireResult(await this.client.call("participant.acquire", params));
				acquiredCaller = {
					protocol,
					participantId: callerParticipantId,
					participantKey: acquired.participant.participantKey,
					generation: acquired.participant.generation,
					disposition: "held",
				};
				rollbackCaller = acquired.transitioned;
				launchCaller = acquired.participant;
				this.session.store.persistIdentity(acquiredCaller);
				throwIfAborted(signal);
			}
			const request: CollaboratorLaunchRequest = {
				ctx,
				protocol,
				participantId: candidate.participantId,
				allowRevive: false,
				caller: launchCaller,
				candidate,
				signal,
			};
			return await this.launchCollaborator(request);
		} catch (error) {
			const childMayBeLive = error instanceof HostedCollaboratorStartError && error.childMayBeLive;
			if (acquiredCaller?.participantKey && rollbackCaller && !childMayBeLive) await this.rollbackCaller(acquiredCaller, registration);
			throw error;
		}
	}

	private async rollbackCaller(acquired: ParticipantIdentity, registration: LiveClientRegistration): Promise<void> {
		try {
			const params = { ...auth(registration), participantKey: acquired.participantKey, expectedGeneration: acquired.generation };
			const participant = parseParticipant(await this.client.call("participant.stand_down", params));
			this.session.store.persistIdentity({ ...acquired, generation: participant.generation, disposition: "vacant" });
		} catch (error) {
			const detail = `Collaborator launch failed and caller rollback also failed: ${error instanceof Error ? error.message : String(error)}`;
			throw new HostedRuntimeClientError("internal", detail);
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

	/** Re-proves caller and child state, then dispatches to the Pi or native launcher. */
	private async launchCollaborator(request: CollaboratorLaunchRequest): Promise<string | undefined> {
		const { ctx, protocol, participantId, candidate, signal } = request;
		throwIfAborted(signal);
		assertHerdrWorkspace();
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Collaborator start requires a trusted project.");
		const registration = await this.session.requireRegistration(ctx);
		const participants = await this.session.listParticipants(registration);
		if (request.caller) this.assertCallerUnchanged(request.caller, participants, registration);
		const existing = findByName(participants, protocol, participantId);
		throwIfAborted(signal);
		if (existing?.state === "held") throw new HostedRuntimeClientError("conflict", "Participant already has a holder.");
		if (existing?.state === "ended") {
			if (!request.allowRevive) {
				throw new HostedRuntimeClientError("conflict", "Ended collaborator identities require explicit /runtime collaborator-start revival.");
			}
			const revival = `Start a ${candidate.driver} collaborator and revive ${protocol}/${participantId}?`;
			if (!await ctx.ui.confirm("Revive collaborator identity?", revival)) return undefined;
		}
		if (existing?.state === "vacant" && existing.lastTransition.cause === "stand_down") await this.replaceStoodDown(existing, registration);
		const worktreePath = candidate.profile === "workspace-write"
			? await this.ensureWorktree(registration, protocol, participantId, request.caller)
			: undefined;
		if (candidate.driver !== "pi") {
			return this.native.launch({ ...request, registration, existing, worktreePath, signal });
		}
		return this.launchPiCollaborator(request, registration, existing, worktreePath);
	}

	private assertCallerUnchanged(
		expectedCaller: ClientParticipantStatus,
		participants: ClientParticipantStatus[],
		registration: LiveClientRegistration,
	): void {
		const caller = participants.find((participant) => participant.participantKey === expectedCaller.participantKey);
		const unchanged = caller?.protocol === expectedCaller.protocol
			&& caller.participantId === expectedCaller.participantId
			&& caller.state === "held"
			&& caller.holderTargetKey === registration.targetKey
			&& caller.generation === expectedCaller.generation;
		if (caller && unchanged) return;
		const sameName = caller?.protocol === expectedCaller.protocol && caller.participantId === expectedCaller.participantId;
		this.session.store.persistIdentity(caller && sameName
			? {
				protocol: caller.protocol,
				participantId: caller.participantId,
				participantKey: caller.participantKey,
				generation: caller.generation,
				disposition: callerDisposition(caller, registration),
			}
			: { protocol: expectedCaller.protocol, participantId: expectedCaller.participantId, disposition: "vacant" });
		const name = `${expectedCaller.protocol}/${expectedCaller.participantId}`;
		const detail = `Caller identity ${name} changed while launch confirmation was pending.`;
		throw new HostedRuntimeClientError("conflict", detail);
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

	private async launchPiCollaborator(
		request: CollaboratorLaunchRequest,
		registration: LiveClientRegistration,
		existing: ClientParticipantStatus | undefined,
		worktreePath: string | undefined,
	): Promise<string | undefined> {
		const { ctx, protocol, participantId, candidate, signal } = request;
		const bootstrap = `${protocol}:${participantId}${existing?.state === "ended" ? ":revive" : ""}`;
		const sessionId = randomUUID();
		const projectRoot = realpathSync(ctx.cwd);
		const launchCwd = worktreePath ?? projectRoot;
		const targetKey = `pi_${createHash("sha256").update(projectRoot).update("\0").update(sessionId).digest("hex")}`;
		const sessionFile = this.createCollaboratorSession(projectRoot, launchCwd, sessionId, piCollaboratorLaunch(candidate));
		let tabId: string | undefined;
		let paneId: string | undefined;
		let tabCreated = false;
		let childMayBeLive = false;
		try {
			throwIfAborted(signal);
			const created = await this.pi.exec("herdr", piTabArgs(launchCwd, participantId, bootstrap), { timeout: 5_000 });
			if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the collaborator tab.");
			tabCreated = true;
			const result = strictObject(strictObject(JSON.parse(created.stdout), "Herdr response").result, "Herdr result");
			const rootPane = strictObject(result.root_pane, "Herdr root pane");
			try { paneId = text(rootPane.pane_id); } catch {}
			try { tabId = text(strictObject(result.tab, "Herdr tab").tab_id); } catch {}
			if (!paneId || !tabId) {
				throw new HostedRuntimeClientError("invalid_response", "Herdr did not return the created collaborator tab and root pane IDs.");
			}
			throwIfAborted(signal);
			childMayBeLive = true;
			await this.dispatchPiStartup(paneId, sessionFile, candidate);
			throwIfAborted(signal);
			return await this.awaitPiIdentity({ ctx, registration, protocol, participantId, targetKey, paneId, existing, signal });
		} catch (error) {
			if (childMayBeLive) {
				throw new HostedCollaboratorStartError(errorCode(error), error instanceof Error ? error.message : String(error), true);
			}
			if (tabCreated && !tabId && !paneId) {
				const detail = "Herdr created collaborator resources without returning an authoritative tab or pane ID;"
					+ ` session ${sessionFile} was preserved for recovery.`;
				throw new HostedCollaboratorStartError("invalid_response", detail, false);
			}
			throw error;
		} finally {
			const hasAllocatedResources = Boolean(tabId || paneId) || !tabCreated;
			if (!childMayBeLive && hasAllocatedResources) {
				await this.cleanupFailedCollaborator(tabId, paneId, sessionFile);
			}
		}
	}

	private async dispatchPiStartup(paneId: string, sessionFile: string, candidate: ResolvedCollaboratorCandidate): Promise<void> {
		const profileTools = collaboratorProfileTools(candidate.profile);
		const tools = profileTools ? ` --tools ${shellQuote(profileTools.join(","))}` : "";
		const model = candidate.model ? ` --model ${shellQuote(candidate.model)}` : "";
		const command = `exec pi --approve --session ${shellQuote(sessionFile)}${tools}${model}`;
		const started = await this.pi.exec("herdr", ["pane", "run", paneId, command], { timeout: 5_000 });
		if (started.code !== 0) {
			const detail = `Herdr could not dispatch Pi collaborator startup in ${paneId}; its tab and session were preserved.`;
			throw new HostedRuntimeClientError("host_unavailable", detail);
		}
	}

	/** Waits for the child Pi to prove its own identity handshake against Runtime. */
	private async awaitPiIdentity(request: PiHandshakeRequest): Promise<string> {
		const { ctx, registration, protocol, participantId, targetKey, paneId, existing, signal } = request;
		for (let attempt = 0; attempt < PI_HANDSHAKE_ATTEMPTS; attempt++) {
			throwIfAborted(signal);
			let participant: ClientParticipantStatus | undefined;
			try {
				participant = findByName(await this.session.listParticipants(registration), protocol, participantId);
			} catch (error) {
				const cause = error instanceof Error ? error.message : String(error);
				const detail = `Collaborator identity handshake became unavailable after Pi started in ${paneId};`
					+ ` its tab and session were preserved: ${cause}`;
				throw new HostedRuntimeClientError("unavailable", detail);
			}
			const settled = participant?.state === "held"
				&& participant.holderLive
				&& participant.holderTargetKey === targetKey
				&& participant.generation !== existing?.generation;
			if (settled) {
				ctx.ui.notify(`Collaborator ${protocol}/${participantId} started in ${paneId}.`, "info");
				return paneId;
			}
			await delay(100);
		}
		const detail = `Pi started in ${paneId}, but its identity handshake did not settle; the tab and session were preserved for recovery.`;
		throw new HostedRuntimeClientError("unavailable", detail);
	}

	private createCollaboratorSession(projectRoot: string, cwd: string, sessionId: string, launch: CollaboratorLaunch): string {
		const timestamp = new Date().toISOString();
		const sessionCwd = realpathSync(cwd);
		const directory = join(this.session.root, "collaborator-sessions");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const sessionFile = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		const record: HostedSessionRecord = { version: 3, launch };
		if (sessionCwd !== projectRoot) record.worktree = { projectRoot, worktreePath: sessionCwd };
		const entries: Array<SessionHeader | CustomEntry<HostedSessionRecord>> = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: sessionCwd },
			{ type: "custom", customType: HOSTED_SESSION_ENTRY, data: record, id: randomUUID(), parentId: null, timestamp },
		];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
		return sessionFile;
	}

	private async ensureWorktree(
		registration: LiveClientRegistration,
		protocol: string,
		participantId: string,
		caller: ClientParticipantStatus | undefined,
	): Promise<string> {
		if (!caller) throw new HostedRuntimeClientError("conflict", "Workspace-write launch requires an authoritatively held caller generation.");
		const params = {
			...auth(registration),
			callerParticipantKey: caller.participantKey,
			expectedCallerGeneration: caller.generation,
			protocol,
			participantId,
		};
		return text(strictObject(await this.client.call("worktree.ensure", params), "Collaborator worktree").path);
	}

	private async cleanupFailedCollaborator(tabId: string | undefined, paneId: string | undefined, sessionFile: string): Promise<void> {
		const resource = tabId ? { type: "tab", id: tabId } : paneId ? { type: "pane", id: paneId } : undefined;
		if (resource) {
			const closed = await this.pi.exec("herdr", [resource.type, "close", resource.id], { timeout: 5_000 });
			if (closed.code !== 0) {
				throw new HostedRuntimeClientError("host_unavailable", `Herdr could not clean up failed collaborator ${resource.type} ${resource.id}.`);
			}
		}
		rmSync(sessionFile, { force: true });
	}
}

function piCollaboratorLaunch(options: CollaboratorLaunchOptions): CollaboratorLaunch {
	const launch: CollaboratorLaunch = { driver: "pi" };
	if (options.model) launch.model = options.model;
	if (options.profile) launch.profile = options.profile;
	if (options.persona) launch.persona = options.persona;
	return launch;
}

function collaboratorProfileTools(profile: HostedCollaboratorProfile | undefined): readonly string[] | undefined {
	if (profile === "read-only") return READ_ONLY_COLLABORATOR_TOOLS;
	if (profile === "workspace-write") return WORKSPACE_WRITE_COLLABORATOR_TOOLS;
	return undefined;
}

function piTabArgs(launchCwd: string, participantId: string, bootstrap: string): string[] {
	const workspaceId = process.env.HERDR_WORKSPACE_ID ?? "";
	return [
		"tab", "create", "--workspace", workspaceId, "--cwd", launchCwd,
		"--label", `collaborator:${participantId}`, "--env", `${COLLABORATOR_ENV}=${bootstrap}`, "--no-focus",
	];
}

function callerDisposition(caller: ClientParticipantStatus, registration: LiveClientRegistration): ParticipantIdentity["disposition"] {
	if (caller.state === "ended") return "ended";
	return caller.state === "held" && caller.holderTargetKey === registration.targetKey ? "held" : "vacant";
}

function findByName(participants: ClientParticipantStatus[], protocol: string, participantId: string): ClientParticipantStatus | undefined {
	return participants.find((participant) => participant.protocol === protocol && participant.participantId === participantId);
}

function findByKey(participants: ClientParticipantStatus[], participantKey: string): ClientParticipantStatus | undefined {
	return participants.find((participant) => participant.participantKey === participantKey);
}

function requestsOtherIdentity(input: CollaboratorStartInput, protocol: string, callerParticipantId: string): boolean {
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

function findCaller(participants: ClientParticipantStatus[], identity: ParticipantIdentity): ClientParticipantStatus | undefined {
	const byKey = identity.participantKey ? findByKey(participants, identity.participantKey) : undefined;
	return byKey ?? findByName(participants, identity.protocol, identity.participantId);
}

function batchCallerHolds(caller: ClientParticipantStatus, identity: ParticipantIdentity, registration: LiveClientRegistration): boolean {
	return caller.protocol === identity.protocol
		&& caller.participantId === identity.participantId
		&& caller.state === "held"
		&& caller.holderTargetKey === registration.targetKey
		&& caller.generation === identity.generation;
}

function assertStartableChildren(
	participants: ClientParticipantStatus[],
	protocol: string,
	normalized: ResolvedCollaboratorCandidate[],
): void {
	for (const candidate of normalized) {
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

function confirmBatchStart(
	ctx: ExtensionContext,
	identity: ParticipantIdentity,
	normalized: ResolvedCollaboratorCandidate[],
	participants: ClientParticipantStatus[],
	signal?: AbortSignal,
): Promise<boolean> {
	const projectRoot = realpathSync(ctx.cwd);
	const summary = normalized.map((candidate) => {
		const prior = findByName(participants, identity.protocol, candidate.participantId);
		const worktree = candidate.profile === "workspace-write" ? "yes" : "no";
		const replaces = prior?.state === "vacant" && prior.lastTransition.cause === "stand_down" ? "yes" : "no";
		return `${identity.protocol}/${candidate.participantId} — ${collaboratorConfiguration(candidate)}, project ${projectRoot},`
			+ ` isolated worktree ${worktree}, replace stood-down process ${replaces}`;
	}).join("\n");
	const detail = `As ${identity.protocol}/${identity.participantId}, start ${normalized.length} collaborators`
		+ ` with concurrency up to 4 in no-focus Herdr tabs?\n\n${summary}`;
	return ctx.ui.confirm("Start Runtime collaborators?", detail, { signal });
}

function confirmSingleStart(
	ctx: ExtensionContext,
	resolved: ResolvedCaller,
	candidate: ResolvedCollaboratorCandidate,
	child: ClientParticipantStatus | undefined,
	signal?: AbortSignal,
): Promise<boolean> {
	const { protocol, callerParticipantId, expectedCaller, identity } = resolved;
	const callerAction = expectedCaller
		? `As ${protocol}/${callerParticipantId}, start`
		: identity ? `Reacquire ${protocol}/${callerParticipantId} and start` : `Acquire ${protocol}/${callerParticipantId} and start`;
	const projectRoot = realpathSync(ctx.cwd);
	const worktree = candidate.profile === "workspace-write" ? "yes" : "no";
	const stoodDown = child?.state === "vacant" && child.lastTransition.cause === "stand_down";
	const replaces = stoodDown ? ", replacing its exact stood-down process" : "";
	const detail = `${callerAction} ${protocol}/${candidate.participantId} using ${collaboratorConfiguration(candidate)},`
		+ ` project ${projectRoot}, isolated worktree ${worktree}${replaces}, in a no-focus Herdr tab?`;
	return ctx.ui.confirm("Start Runtime collaborator?", detail, { signal });
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
