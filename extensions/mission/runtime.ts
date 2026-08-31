import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainCheckpoints } from "../chains/checkpoint.ts";
import { getSubagentService } from "../subagents/registry.ts";
import { SubagentAdmissionReservedError } from "../subagents/service.ts";
import { getJobManager } from "../jobs/registry.ts";
import type { DelegateRun } from "../subagents/runtime-types.ts";
import { runtimeEvents } from "../shared/runtime-events.ts";
import { MissionState } from "./state.ts";
import { missionRoot } from "./artifacts.ts";
import { MAX_MISSION_REVIEW_ADJUDICATIONS } from "./types.ts";
import type { MissionCompleteInput, MissionCurrent, MissionProgressInput, MissionReviewFinding, MissionReviewRevision, MissionReviewSeverity, MissionReviewVerdict, MissionUpdateInput } from "./types.ts";

const REVIEW_QUIET_WINDOW_MS = 100;

interface MissionAgentMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

export class MissionRuntime {
	private ctx?: ExtensionContext;
	private continuationInFlight = false;
	private disposed = false;
	private lastAgentMessages: MissionAgentMessage[] = [];
	private currentRunSteered = false;
	private lastAbortWasSteered = false;
	private mutatingCalls = new Set<string>();
	private materialMutationSinceSettle = false;
	private worktreeBeforeTurn?: string;
	private recoveryTimer?: NodeJS.Timeout;
	private reviewAdmissionRetry = false;
	private reviewAdmissionInFlight = false;
	private unsubscribeReview?: () => void;

	private readonly pi: ExtensionAPI;
	readonly state: MissionState;

	constructor(pi: ExtensionAPI, state: MissionState) {
		this.pi = pi;
		this.state = state;
	}

	restore(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.state.loadFromSession(ctx);
		const mission = this.state.read();
		if (mission?.reviewStatus === "clear" && (!mission.reviewCandidateId || !mission.reviewAdjudicatedCandidateId || mission.reviewAdjudicatedVerdict !== "clear")) {
			if (mission.completionLatchCandidateId) this.state.append(this.pi, this.state.completionLatchClearedEvent());
			const legacyRelaunchAuthorized = mission.reviewAdjudicationHistoryComplete !== true
				&& !mission.reviewAdjudicatedCandidateId
				&& (mission.reviewAdjudications?.length ?? 0) === 0;
			this.state.append(this.pi, this.state.reviewEvent("due", { reason: "Legacy clear review lacks typed candidate metadata and must be reviewed again.", legacyRelaunchAuthorized: legacyRelaunchAuthorized ? true : undefined }));
		}
		this.updateStatus();
	}

	async onCreated(ctx: ExtensionContext): Promise<void> {
		this.restore(ctx);
		const mission = this.state.read();
		if (!mission) return;
		if (!this.state.readOwner()) {
			this.state.append(this.pi, this.state.statusEvent("blocked", "Mission creation lacks canonical persisted ownership."));
			this.updateStatus();
			throw new Error("Mission creation cannot admit a baseline without canonical persisted ownership.");
		}
		chainCheckpoints.current?.activate(mission.chain, mission.chainBranch);
		chainCheckpoints.current?.due("Mission created", "mission_control");
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) {
			this.state.append(this.pi, this.state.statusEvent("blocked", "Mission creation could not capture its initial workspace fingerprint."));
			this.updateStatus();
			throw new Error("Mission creation could not capture its initial workspace fingerprint.");
		}
		this.state.append(this.pi, this.state.reviewEvent("not_required", { reason: "Initial workspace baseline persisted.", worktreeFingerprint: fingerprint }));
		void this.maybeContinue(ctx);
	}

	onTakenOver(ctx: ExtensionContext, mission: MissionCurrent): void {
		this.restore(ctx);
		chainCheckpoints.current?.activate(mission.chain, mission.chainBranch);
		chainCheckpoints.current?.due("Mission taken over by a new session", "mission_control");
		this.updateStatus();
		this.scheduleRecovery(ctx);
	}

	onResumed(ctx: ExtensionContext): void {
		this.restore(ctx);
		const mission = this.state.read();
		if (mission?.reviewStatus === "starting") this.state.append(this.pi, this.state.reviewEvent("due", { reason: "explicit resume authorized reconciliation of ambiguous reviewer admission", candidateId: mission.reviewCandidateId, admissionId: mission.reviewAdmissionId }));
		this.updateStatus();
		this.scheduleRecovery(ctx);
	}

	onProgress(input: MissionProgressInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		if (input.reviewVerdict) {
			const mission = this.state.read();
			if (!mission || mission.reviewStatus !== "awaiting_adjudication" || !input.reviewRunId || input.reviewRunId !== mission.reviewRunId) {
				throw new Error("Review adjudication requires the exact awaiting reviewer run id.");
			}
			if (!input.reviewReason?.trim()) throw new Error("Review adjudication requires an evidence-based reason.");
			if (input.reviewVerdict !== mission.reviewSuggestedVerdict) throw new Error(`Review adjudication must match the severity-derived verdict: ${mission.reviewSuggestedVerdict ?? "unknown"}.`);
			const adjudicated = this.state.append(this.pi, this.state.reviewEvent(input.reviewVerdict, { runId: input.reviewRunId, reason: input.reviewReason, candidateId: mission.reviewCandidateId }));
			chainCheckpoints.current?.due(`Mission review adjudicated: ${input.reviewVerdict}`, "mission_milestone");
			if (adjudicated?.reviewStatus === "changes_requested" && (adjudicated.reviewCorrectionCount ?? 0) > (adjudicated.reviewCorrectionLimit ?? 3)) {
				this.state.append(this.pi, this.state.statusEvent("blocked", "review correction limit reached", `Correction cycle ${adjudicated.reviewCorrectionCount} requires explicit user authorization.`));
			}
		}
		this.updateStatus();
	}

	async workspaceFingerprint(ctx: ExtensionContext): Promise<string | undefined> {
		this.restore(ctx);
		return worktreeFingerprint(this.pi, ctx.cwd, this.state.read());
	}

	async authorizeCompletion(ctx: ExtensionContext): Promise<string> {
		this.restore(ctx);
		const mission = this.state.read();
		const reviewStatus = mission?.reviewStatus ?? "not_required";
		if (!mission || (reviewStatus !== "clear" && reviewStatus !== "skipped" && reviewStatus !== "not_required")) throw new Error("Mission completion cannot be authorized before review convergence.");
		const settlement = this.settlementBlockers();
		if (settlement.length) throw new Error(`Mission completion cannot be authorized while child work is unsettled: ${settlement.join("; ")}`);
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) throw new Error("Mission completion authorization requires an exact workspace fingerprint.");
		const candidateId = reviewCandidateId(mission, fingerprint);
		if (reviewStatus === "clear" && (mission.reviewWorktreeFingerprint !== fingerprint || mission.reviewAdjudicatedCandidateId !== candidateId || mission.reviewAdjudicatedVerdict !== "clear")) throw new Error("Mission completion authorization requires review convergence for the current candidate.");
		if ((reviewStatus === "skipped" || reviewStatus === "not_required") && mission.admittedWorktreeFingerprint !== fingerprint) throw new Error("Mission completion authorization requires the converged disposition to match the current workspace fingerprint.");
		this.state.append(this.pi, this.state.completionLatchEvent(candidateId, reviewStatus));
		return candidateId;
	}

	async completionCandidateId(ctx: ExtensionContext): Promise<string | undefined> {
		this.restore(ctx);
		const mission = this.state.read();
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		return mission && fingerprint ? reviewCandidateId(mission, fingerprint) : undefined;
	}

	authorizeReviewContinuation(ctx: ExtensionContext): void {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) throw new Error("No Mission exists on this branch.");
		const correctionCount = mission.reviewCorrectionCount ?? 0;
		const correctionBlocked = mission.status === "blocked" && correctionCount > (mission.reviewCorrectionLimit ?? 3);
		this.state.append(this.pi, this.state.reviewPolicyEvent(correctionCount));
		if (correctionBlocked && !this.state.limitExceeded()) this.state.append(this.pi, this.state.statusEvent("active", "explicit user authorization allowed one additional review correction"));
		chainCheckpoints.current?.due(`Mission review correction cycle ${correctionCount} authorized`, "mission_control");
		this.updateStatus();
		void this.maybeContinue(ctx);
	}

	onObjectiveUpdated(_input: MissionUpdateInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		chainCheckpoints.current?.due("Mission objective updated", "mission_control");
		const mission = this.state.read();
		if ((mission?.reviewSupersessionCount ?? 0) >= 3) this.state.append(this.pi, this.state.statusEvent("blocked", "review candidate superseded three times", "Mission identity changed repeatedly before review convergence."));
		else this.scheduleRecovery(ctx);
		this.updateStatus();
	}

	onCompleted(ctx: ExtensionContext, completedMission?: MissionCurrent, completionId?: string): void {
		if (completedMission) this.ctx = ctx;
		else this.restore(ctx);
		const mission = completedMission ?? this.state.readAny();
		if (!mission) return;
		chainCheckpoints.current?.due(mission.status === "ended" ? "Mission ended" : "Mission completed", "mission_control");
		runtimeEvents.record(this.pi, {
			type: "emit",
			event: {
				version: 1,
				id: completionId ? `terminal:${completionId}` : `terminal:${mission.missionId}:${mission.generation}`,
				dedupeKey: completionId ? `mission:${completionId}:terminal` : `mission:${mission.missionId}:${mission.generation}:terminal`,
				source: { kind: "mission", id: mission.missionId, generation: mission.generation ?? `legacy-${mission.missionId}` },
				type: "terminal",
				status: mission.status === "ended" ? "cancelled" : "completed",
				delivery: "record_only",
				createdAt: mission.updatedAt,
				summary: mission.lastSummary || mission.title,
			},
		});
		if (completedMission) ctx.ui.setStatus("mission", undefined);
		else this.updateStatus();
	}

	async validateCompletion(input: MissionCompleteInput, ctx: ExtensionContext, _directUserRequest = false): Promise<string[]> {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return ["No Mission exists on this branch."];
		const blockers = this.settlementBlockers();
		if (input.userRequested) return blockers;
		const audit = input.audit ?? [];
		for (const [requirementIndex, requirement] of mission.requirements.entries()) {
			const item = audit.find((candidate) => candidate.requirementIndex === requirementIndex && candidate.evidence.trim());
			if (!item) blockers.push(`Missing non-empty evidence record for requirement [${requirementIndex}]: ${requirement}`);
		}
		if (audit.some((item) => item.requirementIndex < 0 || item.requirementIndex >= mission.requirements.length)) blockers.push("Requirement audit contains an unknown requirementIndex.");
		if (audit.some((item) => !item.evidence.trim())) blockers.push("Requirement audit contains empty evidence.");
		if (new Set(audit.map((item) => item.requirementIndex)).size !== audit.length) blockers.push("Requirement audit contains duplicate requirementIndex entries.");
		const validation = this.state.readProgress().flatMap((progress) => progress.validation);
		if (!validation.some((item) => item.exitCode === 0 && item.objectiveVersion === (mission.objectiveVersion ?? 1))) blockers.push("No successful structured validation is recorded for the current objectiveVersion.");
		if (!["clear", "skipped", "not_required"].includes(mission.reviewStatus ?? "not_required")) blockers.push(`Independent review is ${mission.reviewStatus ?? "due"}.`);
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) blockers.push("Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories.");
		else {
			const candidateId = reviewCandidateId(mission, fingerprint);
			if (mission.completionLatchCandidateId !== candidateId) {
				if (mission.completionLatchCandidateId) this.state.append(this.pi, this.state.completionLatchClearedEvent());
				blockers.push("Mission completion is not user-authorized for the current objective/scope/fingerprint candidate.");
			} else if (mission.completionLatchReviewStatus !== (mission.reviewStatus ?? "not_required")) blockers.push("Mission completion authorization does not match the current converged review disposition.");
			if (mission.reviewStatus === "clear" && (fingerprint !== mission.reviewWorktreeFingerprint || mission.reviewAdjudicatedCandidateId !== candidateId || mission.reviewAdjudicatedVerdict !== "clear")) blockers.push("Worktree differs from the severity-adjudicated reviewed candidate.");
			else if (mission.reviewStatus === "not_required" || mission.reviewStatus === "skipped") {
				if (!mission.admittedWorktreeFingerprint) blockers.push("No durable admitted workspace fingerprint is recorded.");
				else if (fingerprint !== mission.admittedWorktreeFingerprint) blockers.push("Worktree differs from the last durable admitted workspace fingerprint.");
			}
		}
		if (chainCheckpoints.current && !chainCheckpoints.current.isSatisfied(mission.chain, mission.chainBranch)) blockers.push(`The Mission Chain checkpoint ${mission.chain}@${mission.chainBranch} is not saved or explicitly waived.`);
		return blockers;
	}

	register(): void {
		this.pi.on("session_start", (_event, ctx) => {
			this.disposed = false;
			this.restore(ctx);
			this.scheduleRecovery(ctx);
		});
		this.pi.on("session_tree", (_event, ctx) => {
			this.restore(ctx);
			this.scheduleRecovery(ctx);
		});
		this.pi.on("session_compact", (_event, ctx) => this.restore(ctx));
		this.pi.on("input", (event) => {
			if (event.streamingBehavior === "steer") this.currentRunSteered = event.source === "interactive" || event.source === "rpc";
		});
		this.pi.on("turn_start", async (_event, ctx) => {
			this.restore(ctx);
			const beforeTurn = this.state.read();
			if (beforeTurn?.initialBaselinePending) { ctx.abort(); return; }
			this.worktreeBeforeTurn = await this.reconcileWorkspaceFingerprint(ctx);
			if (beforeTurn?.reviewStatus !== "due" && this.state.read()?.reviewStatus === "due") ctx.abort();
		});
		this.pi.on("agent_end", (event, ctx) => {
			this.lastAgentMessages = [...event.messages];
			this.lastAbortWasSteered = this.currentRunSteered && this.lastAgentMessages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
			this.currentRunSteered = false;
			this.restore(ctx);
		});
		this.pi.on("tool_execution_start", (event) => {
			if (event.toolName === "edit" || event.toolName === "write") this.mutatingCalls.add(event.toolCallId);
		});
		this.pi.on("tool_execution_end", (event, ctx) => {
			if (!this.mutatingCalls.delete(event.toolCallId) || event.isError) return;
			this.materialMutationSinceSettle = true;
			this.restore(ctx);
			this.markReviewDue(`${event.toolName} changed files`);
		});
		this.pi.on("before_agent_start", (event, ctx) => {
			this.restore(ctx);
			const mission = this.state.readAny();
			const systemPrompt = event.systemPrompt;
			const ownershipConflict = this.state.readOwnershipConflict();
			if (!mission && ownershipConflict) return { systemPrompt: `${systemPrompt}\n\nMission ${ownershipConflict.missionId} was transferred to another Pi session. Do not continue its work or act on stale Mission wakes in this session.` };
			if (!mission || mission.status === "complete" || mission.status === "ended") return undefined;
			if (mission.status !== "active") return { systemPrompt: `${systemPrompt}\n\n${suspendedMissionContext(mission, this.state.readProgress().at(-1))}` };
			const staleWake = latestMissionWakeIsStale(ctx, mission);
			const wakeGuard = staleWake ? "\n\nThis Mission continuation wake is stale after a pause/objective/generation change. Do not perform substantive work; report the stale wake and settle immediately." : "";
			return { systemPrompt: `${systemPrompt}\n\n${missionContext(mission, this.state.readUsage())}${wakeGuard}` };
		});
		this.pi.on("agent_settled", async (_event, ctx) => {
			this.continuationInFlight = false;
			this.restore(ctx);
			await this.onSettled(ctx);
		});
		this.pi.on("session_shutdown", () => {
			this.disposed = true;
			this.continuationInFlight = false;
			if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
			this.recoveryTimer = undefined;
			this.reviewAdmissionRetry = false;
			this.reviewAdmissionInFlight = false;
			this.unsubscribeReview?.();
			this.unsubscribeReview = undefined;
			this.lastAgentMessages = [];
			this.currentRunSteered = false;
			this.lastAbortWasSteered = false;
			this.mutatingCalls.clear();
			this.materialMutationSinceSettle = false;
			this.worktreeBeforeTurn = undefined;
			this.ctx?.ui.setStatus("mission", undefined);
			this.ctx = undefined;
		});
	}

	continuationBlockers(ctx: ExtensionContext): string[] {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission || mission.status !== "active") return mission ? [`Mission status is ${mission.status}.`] : ["No Mission exists on this branch."];
		const blockers: string[] = [];
		if (mission.initialBaselinePending) blockers.push("initial workspace baseline is pending durable admission");
		const limit = this.state.budgetExceeded();
		if (limit) blockers.push(`${limit} limit is exhausted`);
		try {
			const active = this.activeSubagentWork();
			if (active.runs.length) blockers.push(`Subagents still running: ${active.runs.map((run) => run.spec.id).join(", ")}`);
			if (active.groupIds.length) blockers.push(`Subagent groups still running: ${active.groupIds.join(", ")}`);
			if (active.launchReservations) blockers.push(`${active.launchReservations} Subagent launch(es) still starting`);
		} catch {
			blockers.push("Subagent settlement cannot currently be verified");
		}
		const jobs = this.activeJobs();
		if (jobs.length) blockers.push(`Jobs still running: ${jobs.map((job) => job.spec.id).join(", ")}`);
		if (mission.reviewStatus === "starting") blockers.push("independent review admission is starting");
		else if (mission.reviewStatus === "running") blockers.push(`independent review still running${mission.reviewRunId ? `: ${mission.reviewRunId}` : ""}`);
		else if (mission.reviewStatus === "due") blockers.push("independent review is due");
		else if (mission.reviewStatus === "awaiting_adjudication") blockers.push(`independent review is ready for adjudication${mission.reviewRunId ? `: ${mission.reviewRunId}` : ""}`);
		if (ctx.hasPendingMessages()) blockers.push("user messages are queued ahead of autonomous continuation");
		return blockers;
	}

	async maybeContinue(ctx: ExtensionContext): Promise<void> {
		this.restore(ctx);
		const mission = this.state.read();
		if (this.disposed || !mission || mission.status !== "active" || mission.initialBaselinePending || this.continuationInFlight) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || !ctx.sessionManager.getSessionFile()) return;
		let activeSubagents: ReturnType<MissionRuntime["activeSubagentWork"]>;
		try {
			activeSubagents = this.activeSubagentWork();
		} catch {
			return;
		}
		// Block on "due" as well as "running": a continuation turn during the review-admission window would mutate the worktree while a reviewer is about to start, guaranteeing a review failure and wasting a strike.
		if (this.state.budgetExceeded() || activeSubagents.runs.length || activeSubagents.groupIds.length || activeSubagents.launchReservations || this.activeJobs().length || mission.reviewStatus === "starting" || mission.reviewStatus === "running" || mission.reviewStatus === "due" || (mission.reviewStatus === "awaiting_adjudication" && (mission.lastContinuationAt ?? 0) >= (mission.reviewUpdatedAt ?? mission.updatedAt))) return;
		const event = this.state.continuedEvent();
		this.state.append(this.pi, event);
		this.continuationInFlight = true;
		try {
			this.pi.sendMessage({
				customType: "mission",
				content: continuationMessage(mission),
				display: false,
				details: { version: 2, missionId: mission.missionId, generation: mission.generation, objectiveVersion: mission.objectiveVersion },
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {
			this.continuationInFlight = false;
			this.scheduleRecovery(ctx, 1_000);
		}
	}

	private scheduleRecovery(ctx: ExtensionContext, delayMs = 0): void {
		if (this.disposed) return;
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined;
			void this.recover(ctx);
		}, delayMs);
		this.recoveryTimer.unref?.();
	}

	private async recover(ctx: ExtensionContext): Promise<void> {
		if (this.disposed) return;
		try {
			this.restore(ctx);
			const fingerprint = await this.reconcileWorkspaceFingerprint(ctx);
			const recoveredMission = this.state.read();
			if (recoveredMission?.status === "active" && !fingerprint) {
				this.state.append(this.pi, this.state.statusEvent("blocked", "workspace fingerprint unavailable during recovery", "Mission recovery cannot verify its durable candidate."));
				this.updateStatus();
				return;
			}
			if (recoveredMission?.status === "active" && recoveredMission.initialBaselinePending) {
				this.state.append(this.pi, this.state.reviewEvent("not_required", { reason: "Recovered initial workspace baseline persisted.", worktreeFingerprint: fingerprint }));
			}
			this.bindReviewRecovery(ctx);
			const recovering = this.state.read();
			if (recovering?.reviewStatus === "starting" && !this.reviewAdmissionInFlight) {
				this.state.append(this.pi, this.state.statusEvent("blocked", "review admission outcome is ambiguous", "A reserved reviewer may have started before the controller stopped; explicit user recovery is required."));
				this.updateStatus();
				return;
			}
			const reviewSettled = await this.reconcileReview();
			if (reviewSettled) {
				if (this.state.read()?.reviewStatus === "awaiting_adjudication") await this.maybeContinue(ctx);
				return;
			}
			const shouldAdmitReview = this.reviewAdmissionRetry || this.state.read()?.reviewStatus === "due";
			this.reviewAdmissionRetry = false;
			if (shouldAdmitReview && await this.admitDueReview(ctx)) return;
			await this.maybeContinue(ctx);
		} catch (error) {
			this.ctx?.ui.notify?.(`Mission recovery deferred: ${error instanceof Error ? error.message : String(error)}`, "warning");
			this.scheduleRecovery(ctx, 5_000);
		}
	}

	private bindReviewRecovery(ctx: ExtensionContext): void {
		this.unsubscribeReview?.();
		this.unsubscribeReview = undefined;
		try {
			this.unsubscribeReview = getSubagentService().executor.onChange((run) => {
				const mission = this.state.read();
				const terminal = !["starting", "running", "stopping"].includes(run.runtime.status);
				if (terminal && ((mission?.reviewStatus === "running" && mission.reviewRunId === run.spec.id) || mission?.reviewStatus === "due")) this.scheduleRecovery(ctx);
			});
		} catch {
			// Subagents may not be registered yet; the next lifecycle recovery retries binding.
		}
	}

	private async onSettled(ctx: ExtensionContext): Promise<void> {
		let mission = this.state.read();
		if (!mission || mission.status !== "active") return;
		const after = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (this.worktreeBeforeTurn !== undefined && after !== undefined && this.worktreeBeforeTurn !== after) {
			this.materialMutationSinceSettle = true;
			this.markReviewDue("worktree changed during turn");
		}
		this.worktreeBeforeTurn = undefined;
		const interrupted = this.lastAgentMessages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
		const interruptedBySteer = interrupted && this.lastAbortWasSteered;
		const terminalError = this.lastAgentMessages.some((message) => message.role === "assistant" && message.stopReason === "error");
		this.lastAgentMessages = [];
		this.lastAbortWasSteered = false;
		if (interrupted && !interruptedBySteer) {
			this.state.append(this.pi, this.state.statusEvent("paused", "explicit interruption paused Mission autonomy"));
			this.updateStatus();
			return;
		}
		if (terminalError) {
			this.state.append(this.pi, this.state.statusEvent("terminal_error", "provider/runtime error remained after Pi retry settlement"));
			this.updateStatus();
			return;
		}

		const recentProgress = this.state.readProgressSinceContinuation();
		const latestProgress = recentProgress.at(-1);
		const blocker = latestProgress?.blocked ? latestProgress.blockerId : undefined;
		const madeProgress = this.materialMutationSinceSettle || recentProgress.some((progress) => progress.validation.some((validation) => validation.exitCode === 0 && validation.objectiveVersion === (mission!.objectiveVersion ?? 1)));
		this.state.append(this.pi, this.state.settledEvent({ blockerFingerprint: blocker, madeProgress }));
		this.materialMutationSinceSettle = false;
		mission = this.state.read()!;
		if ((mission.blockerCount ?? 0) >= 3) {
			this.state.append(this.pi, this.state.statusEvent("blocked", `same blocker recurred ${mission.blockerCount} autonomous turns`, latestProgress?.summary.slice(0, 500)));
			this.updateStatus();
			return;
		}

		const limit = this.state.budgetExceeded();
		if (limit) {
			const limited = this.state.append(this.pi, this.state.statusEvent(limit === "token" || limit === "cost" ? "budget_limited" : "usage_limited", `${limit} limit exhausted`));
			this.updateStatus();
			if (limited && ctx.isIdle() && !ctx.hasPendingMessages()) {
				this.pi.sendMessage({
					customType: "mission",
					content: `Mission ${limit} limit reached. Do not start substantive work. Record a concise progress/blocker/next-step handoff, settle active children, and save the due Chain checkpoint. Complete only if the evidence gate was already satisfied.`,
					display: false,
					details: { version: 2, kind: "limit_wrapup", missionId: limited.missionId, limit },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}
			return;
		}

		const chain = chainCheckpoints.current?.read();
		if (chain?.status === "due" && chain.dueCodes.includes("material_change")) this.markReviewDue(chain.dueReasons.at(-1) ?? "material mutation");
		if (await this.reconcileReview()) {
			if (this.state.read()?.reviewStatus === "awaiting_adjudication") await this.maybeContinue(ctx);
			return;
		}
		if (await this.admitDueReview(ctx)) return;
		await this.maybeContinue(ctx);
	}

	private async reconcileWorkspaceFingerprint(ctx: ExtensionContext): Promise<string | undefined> {
		const mission = this.state.read();
		if (!mission || mission.status !== "active") return undefined;
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) return undefined;
		const candidateId = reviewCandidateId(mission, fingerprint);
		if (mission.completionLatchCandidateId && mission.completionLatchCandidateId !== candidateId) this.state.append(this.pi, this.state.completionLatchClearedEvent());
		const candidateBoundReview = mission.reviewStatus === "starting" || mission.reviewStatus === "running" || mission.reviewStatus === "awaiting_adjudication" || mission.reviewStatus === "changes_requested" || mission.reviewStatus === "clear";
		const admitted = candidateBoundReview ? mission.reviewWorktreeFingerprint : mission.admittedWorktreeFingerprint;
		if (admitted && admitted !== fingerprint) {
			if (mission.reviewStatus === "awaiting_adjudication") this.supersedeReview("workspace changed after independent review settled", reviewCandidateId(mission, fingerprint), fingerprint);
			else this.markReviewDue("workspace changed since the last admitted fingerprint");
			return fingerprint;
		}
		if (mission.admittedWorktreeFingerprint !== fingerprint && (!mission.admittedWorktreeFingerprint || mission.reviewStatus === "clear")) {
			this.state.append(this.pi, this.state.workspaceFingerprintEvent(fingerprint));
		}
		return fingerprint;
	}

	private markReviewDue(reason: string): void {
		const mission = this.state.read();
		if (!mission || mission.status !== "active" || mission.reviewStatus === "starting" || mission.reviewStatus === "running" || mission.reviewStatus === "due") return;
		this.state.append(this.pi, this.state.reviewEvent("due", { reason }));
		if (this.ctx) this.scheduleRecovery(this.ctx);
		this.updateStatus();
	}

	private async admitDueReview(ctx: ExtensionContext): Promise<boolean> {
		let mission = this.state.read();
		if (!mission || mission.status !== "active" || mission.reviewStatus !== "due") return false;
		if (mission.reviewRunId && mission.reviewAdmissionId) {
			const service = getSubagentService();
			let priorRun: DelegateRun | undefined;
			try { priorRun = service.executor.get(mission.reviewRunId); }
			catch { priorRun = await service.executor.restoreAdmission(ctx.cwd, mission.reviewAdmissionId); }
			if (priorRun && ["starting", "running", "stopping"].includes(priorRun.runtime.status)) {
				this.scheduleRecovery(ctx, 1_000);
				return true;
			}
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) {
			this.failReview(mission, "could not fingerprint candidate before review admission");
			return true;
		}
		const dueCandidateId = reviewCandidateId(mission, fingerprint);
		if (mission.reviewCandidateId && mission.reviewCandidateId !== dueCandidateId) {
			if (mission.reviewOutcome === "superseded" && mission.reviewRunId && mission.reviewAdmissionId) {
				this.state.append(this.pi, this.state.reviewEvent("due", { reason: "prior candidate reviewer settled; replacement quiet window started", candidateId: dueCandidateId, worktreeFingerprint: fingerprint, notBeforeAt: Date.now() + REVIEW_QUIET_WINDOW_MS }));
				this.scheduleRecovery(ctx);
			} else this.supersedeReview("candidate changed during the review quiet window", dueCandidateId, fingerprint);
			return true;
		}
		if (!mission.reviewNotBeforeAt) {
			const notBeforeAt = Date.now() + REVIEW_QUIET_WINDOW_MS;
			this.state.append(this.pi, this.state.reviewEvent("due", { reason: mission.reviewReason, notBeforeAt, candidateId: dueCandidateId, admissionId: mission.reviewAdmissionId, worktreeFingerprint: fingerprint }));
			this.scheduleRecovery(ctx, REVIEW_QUIET_WINDOW_MS);
			return true;
		}
		if (Date.now() < mission.reviewNotBeforeAt) {
			this.scheduleRecovery(ctx, mission.reviewNotBeforeAt - Date.now());
			return true;
		}
		try {
			const service = getSubagentService();
			if (service.restorationComplete?.() === false) {
				this.scheduleRecovery(ctx, 100);
				return true;
			}
			const active = this.activeSubagentWork();
			const recoveredRun = mission.reviewAdmissionId && active.runs.length === 1 && active.runs[0]?.spec.admissionKey === mission.reviewAdmissionId;
			if ((active.runs.length && !recoveredRun) || active.groupIds.length || active.launchReservations || this.activeJobs().length) return true;
		} catch (error) {
			this.failReview(mission, `could not verify reviewer admission capacity: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		await this.startReview(ctx, mission);
		return true;
	}

	private async startReview(ctx: ExtensionContext, mission: MissionCurrent): Promise<void> {
		this.state.loadFromSession(ctx);
		if (!this.state.readOwner()) throw new Error("Mission review admission requires a canonical persisted session owner.");
		mission = this.state.read() ?? mission;
		let service;
		try {
			service = getSubagentService();
		} catch (error) {
			this.failReview(mission, `review admission failed: ${error instanceof Error ? error.message : String(error)}`);
			this.reviewAdmissionRetry = this.state.read()?.reviewStatus === "due";
			this.scheduleRecovery(ctx, 1_000);
			return;
		}
		try {
			if (service.restorationComplete?.() === false) {
				this.scheduleRecovery(ctx, 1_000);
				return;
			}
			const listed = service.list();
			const activeRuns = listed.runs.filter((run) => ["starting", "running", "stopping"].includes(run.runtime.status));
			const recoveredRun = mission.reviewAdmissionId && activeRuns.length === 1 && activeRuns[0]?.spec.admissionKey === mission.reviewAdmissionId;
			if ((activeRuns.length && !recoveredRun) || listed.groups.some((group) => group.status === "running") || (service.activeLaunchReservations?.() ?? 0) || this.activeJobs().length) return;
		} catch (error) {
			this.failReview(mission, `review admission failed: ${error instanceof Error ? error.message : String(error)}`);
			this.reviewAdmissionRetry = this.state.read()?.reviewStatus === "due";
			this.scheduleRecovery(ctx, 1_000);
			return;
		}
		const workspace = await resolveMissionWorkspace(this.pi, ctx.cwd, mission.paths);
		const reviewWorktreeFingerprint = workspace ? await workspaceFingerprint(this.pi, ctx.cwd, workspace, missionIgnoredPaths(ctx.cwd)) : undefined;
		if (!reviewWorktreeFingerprint || !workspace) {
			this.failReview(mission, "could not resolve and fingerprint the Mission Git workspace; ensure explicit Mission paths exist, stay inside cwd, and resolve to Git repositories");
			return;
		}
		let current = this.state.read();
		if (!current || current.reviewStatus !== "due" || current.objectiveVersion !== mission.objectiveVersion) return;
		const candidateId = reviewCandidateId(current, reviewWorktreeFingerprint);
		if ((current.reviewCandidateId && current.reviewCandidateId !== candidateId) || (current.reviewWorktreeFingerprint && current.reviewWorktreeFingerprint !== reviewWorktreeFingerprint)) {
			this.supersedeReview("candidate changed during final review admission", candidateId, reviewWorktreeFingerprint);
			return;
		}
		if (current.completionLatchCandidateId && current.completionLatchCandidateId !== candidateId) {
			this.state.append(this.pi, this.state.completionLatchClearedEvent());
			current = this.state.read()!;
		}
		const priorAdjudication = current.reviewAdjudications?.find((item) => item.candidateId === candidateId)
			?? (current.reviewAdjudicatedCandidateId === candidateId && current.reviewAdjudicatedVerdict ? { candidateId, verdict: current.reviewAdjudicatedVerdict } : undefined);
		if (priorAdjudication) {
			this.state.append(this.pi, this.state.reviewEvent(priorAdjudication.verdict, { runId: current.reviewRunId, reason: "Duplicate review admission suppressed for the unchanged adjudicated candidate.", worktreeFingerprint: reviewWorktreeFingerprint, candidateId, replayAdjudication: true }));
			this.updateStatus();
			return;
		}
		if (current.completionLatchCandidateId === candidateId && (current.completionLatchReviewStatus === "skipped" || current.completionLatchReviewStatus === "not_required")) {
			this.state.append(this.pi, this.state.reviewEvent(current.completionLatchReviewStatus, { reason: "Duplicate review admission suppressed for the unchanged user-authorized completion candidate.", worktreeFingerprint: reviewWorktreeFingerprint, candidateId }));
			this.updateStatus();
			return;
		}
		if (current.reviewAdjudicationHistoryComplete !== true && current.reviewLegacyRelaunchAuthorized !== true) {
			this.state.append(this.pi, this.state.statusEvent("blocked", "review adjudication history completeness is unknown", "A new reviewer was not launched because legacy state cannot prove that this candidate was never reviewed."));
			this.updateStatus();
			return;
		}
		if ((current.reviewAdjudications?.length ?? 0) >= MAX_MISSION_REVIEW_ADJUDICATIONS) {
			this.state.append(this.pi, this.state.statusEvent("blocked", "review adjudication history capacity reached", "A new reviewer was not launched because doing so could require forgetting an already reviewed candidate."));
			this.updateStatus();
			return;
		}
		const reviewCwd = workspace.length === 1 ? workspace[0]!.root : ctx.cwd;
		const paths = reviewPaths(reviewCwd, workspace);
		const scope = `Review only these typed Mission workspace paths: ${paths.join(", ")}.`;
		const correctionReview = isCorrectionReview(current);
		const correctionScope = correctionReview ? await correctionReviewScope(this.pi, ctx.cwd, reviewCwd, workspace, missionIgnoredPaths(ctx.cwd), current.reviewAcceptedRevisions) : undefined;
		const initialRevisions = correctionReview ? undefined : await reviewedWorkspaceRevisions(this.pi, ctx.cwd, reviewCwd, workspace, missionIgnoredPaths(ctx.cwd));
		if ((correctionReview && !correctionScope) || (!correctionReview && !initialRevisions)) {
			this.state.append(this.pi, this.state.statusEvent("blocked", "independent review requires one exact clean candidate commit", "Commit the bounded candidate before review so Runtime can persist and enforce exact reviewed heads and correction topology."));
			this.updateStatus();
			return;
		}
		const latestProgress = this.state.readProgress().at(-1);
		const accepted = current.reviewAcceptedFindings ?? [];
		const reviewMode = correctionReview
			? `This is a bounded correction review. Prior adjudicated evidence remains authoritative for untouched areas. Review only these Runtime-enforced changed paths: ${correctionScope!.paths.join(", ")}. Exact revisions: ${correctionScope!.revisions.map((revision) => `${revision.root}:${revision.base}..${revision.head}`).join(", ")}. Accepted findings: ${accepted.length ? accepted.map((finding) => `#${finding.index} requirement=${finding.requirementIndex ?? "none"} criticalImpact=${finding.criticalImpact ?? "none"} path=${finding.path ?? "none"}: ${finding.summary}`).join(" | ") : "legacy correction scope; use only the exact changed paths"}. Latest correction record: ${latestProgress?.summary ?? "none"}.`
			: "This is the initial full Mission review.";
		const blockingRule = correctionReview
			? "A blocker/major finding must name a Runtime-enforced changed path and include either an accepted requirementIndex or a typed criticalImpact of security or data_loss."
			: "A blocker/major finding must name a path in the typed Mission workspace and include either its violated requirementIndex or a typed criticalImpact of security or data_loss.";
		const sameReservedCandidate = current.reviewCandidateId === candidateId && current.reviewWorktreeFingerprint === reviewWorktreeFingerprint;
		if (current.reviewAdmissionId && !sameReservedCandidate) {
			if (service.restorationComplete?.() === false) {
				this.scheduleRecovery(ctx, 1_000);
				return;
			}
			const prior = service.list().runs.find((run) => run.spec.admissionKey === current.reviewAdmissionId);
			if (prior && ["starting", "running", "stopping"].includes(prior.runtime.status)) return;
		}
		const admissionId = sameReservedCandidate && current.reviewAdmissionId ? current.reviewAdmissionId : `review_${randomUUID()}`;
		this.state.append(this.pi, this.state.reviewEvent("starting", { reason: current.reviewReason, worktreeFingerprint: reviewWorktreeFingerprint, candidateId, admissionId, scopePaths: correctionScope?.paths ?? paths, scopeRevisions: correctionScope?.revisions ?? initialRevisions }));
		this.reviewAdmissionInFlight = true;
		let run;
		try {
			run = await service.start({
				agent: "reviewer",
				task: `Fresh independent Mission review. ${scope} ${reviewMode} Ignore unrelated pre-existing working-tree changes. Mission: ${current.title}. Objective: ${current.objective}. Requirements: ${current.requirements.map((requirement, index) => `[${index}] ${requirement}`).join(" | ")}. ${blockingRule} Otherwise record it as minor/nit follow-up. Call the schema-validated review_report tool exactly once, then summarize for the parent. Do not edit files.`,
				cwd: reviewCwd,
				context: "fresh",
				allowWrite: false,
				deliverTerminal: false,
				admissionKey: admissionId,
				background: true,
				wallMs: 10 * 60_000,
			}, ctx);
		} catch (error) {
			const latest = this.state.read();
			const sameAttempt = latest?.reviewStatus === "starting" && latest.reviewAdmissionId === admissionId && latest.reviewCandidateId === candidateId && latest.objectiveVersion === current.objectiveVersion && latest.generation === current.generation;
			if (!sameAttempt) this.scheduleRecovery(ctx);
			else if (error instanceof SubagentAdmissionReservedError) {
				this.ctx?.ui.notify?.(`Mission reviewer launch outcome is ambiguous: ${error.message}`, "warning");
				this.scheduleRecovery(ctx);
			} else this.failReview(latest, `independent reviewer launch failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		} finally {
			this.reviewAdmissionInFlight = false;
		}
		if ("children" in run) {
			this.ctx?.ui.notify?.("Mission reviewer unexpectedly launched a group; the durable admission remains reserved.", "warning");
			this.scheduleRecovery(ctx);
			return;
		}
		const reserved = this.state.read();
		if (!reserved || reserved.reviewStatus !== "starting" || reserved.reviewCandidateId !== candidateId || reserved.objectiveVersion !== current.objectiveVersion) {
			this.scheduleRecovery(ctx);
			return;
		}
		try {
			this.state.append(this.pi, this.state.reviewEvent("running", { runId: run.spec.id, reason: current.reviewReason, worktreeFingerprint: reviewWorktreeFingerprint, candidateId, admissionId }));
			this.updateStatus();
			let boundRun = run;
			try {
				const latest = service.executor.get?.(run.spec.id);
				if (latest?.spec.id === run.spec.id) boundRun = latest;
			} catch { /* The returned launch record remains authoritative for immediate settlement. */ }
			if (!["starting", "running", "stopping"].includes(boundRun.runtime.status)) this.scheduleRecovery(ctx);
		} catch (error) {
			this.ctx?.ui.notify?.(`Mission reviewer started but binding its run failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			this.scheduleRecovery(ctx);
		}
	}

	private async reconcileReview(): Promise<boolean> {
		const mission = this.state.read();
		// Only an active Mission may transition review state; reviewEvent()/failReview() call requireActive() and would throw on a paused/blocked Mission whose reviewer settled after the pause.
		if (!mission?.reviewRunId || mission.reviewStatus !== "running" || mission.status !== "active") return false;
		const service = getSubagentService();
		if (service.restorationComplete?.() === false) {
			if (this.ctx) this.scheduleRecovery(this.ctx, 1_000);
			return false;
		}
		const preflightFingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd, mission) : undefined;
		const preflight = this.state.read();
		const samePreflightAttempt = preflight?.status === "active" && preflight.reviewStatus === "running" && preflight.reviewRunId === mission.reviewRunId && preflight.reviewCandidateId === mission.reviewCandidateId && preflight.reviewWorktreeFingerprint === mission.reviewWorktreeFingerprint && preflight.objectiveVersion === mission.objectiveVersion && preflight.generation === mission.generation;
		if (!samePreflightAttempt) return true;
		if (!preflightFingerprint) {
			this.failReview(preflight!, "could not fingerprint reviewed worktree before run recovery");
			return true;
		}
		const preflightCandidateId = reviewCandidateId(preflight!, preflightFingerprint);
		if (preflightFingerprint !== preflight!.reviewWorktreeFingerprint || preflightCandidateId !== preflight!.reviewCandidateId) {
			let priorRun: DelegateRun | undefined;
			try { priorRun = service.executor.get(preflight!.reviewRunId!); }
			catch {
				if (preflight!.reviewAdmissionId && this.ctx) priorRun = await service.executor.restoreAdmission(this.ctx.cwd, preflight!.reviewAdmissionId);
			}
			if (priorRun && ["starting", "running", "stopping"].includes(priorRun.runtime.status)) {
				if (this.ctx) this.scheduleRecovery(this.ctx, 1_000);
				return false;
			}
			this.supersedeReview("candidate changed after the prior reviewer settled", preflightCandidateId, preflightFingerprint);
			return true;
		}
		let run: DelegateRun;
		try {
			run = service.executor.get(mission.reviewRunId);
		} catch (error) {
			if (service.restorationComplete?.() === false) {
				if (this.ctx) this.scheduleRecovery(this.ctx, 1_000);
				return false;
			}
			this.failReview(mission, `independent review run lost: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		if (["starting", "running", "stopping"].includes(run.runtime.status)) return false;
		const sameAttempt = (latest: MissionCurrent | undefined) => latest?.status === "active" && latest.reviewStatus === "running" && latest.reviewRunId === mission.reviewRunId && latest.reviewCandidateId === mission.reviewCandidateId && latest.reviewWorktreeFingerprint === mission.reviewWorktreeFingerprint && latest.objectiveVersion === mission.objectiveVersion && latest.generation === mission.generation;
		const fingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd, mission) : undefined;
		let latest = this.state.read();
		if (!sameAttempt(latest)) return true;
		if (!fingerprint) {
			this.failReview(latest!, "could not fingerprint reviewed worktree");
			return true;
		}
		const candidateId = reviewCandidateId(latest!, fingerprint);
		if (!latest!.reviewWorktreeFingerprint || fingerprint !== latest!.reviewWorktreeFingerprint || latest!.reviewCandidateObjectiveVersion !== (latest!.objectiveVersion ?? 1) || latest!.reviewCandidateId !== candidateId) {
			this.supersedeReview("objective, scope, or worktree changed while independent review was running", candidateId, fingerprint);
			return true;
		}
		if (run.runtime.status !== "completed") {
			this.failReview(latest!, run.runtime.error || "independent review failed");
			return true;
		}
		if (!mission.reviewScopePaths?.length) {
			this.state.append(this.pi, this.state.reviewEvent("due", { reason: "independent review scope evidence is missing; relaunch required" }));
			if (this.ctx) this.scheduleRecovery(this.ctx);
			this.updateStatus();
			return true;
		}
		const report = await readReviewReport(run, mission.requirements.length, mission.reviewScopePaths, mission.reviewAcceptedFindings, isCorrectionReview(mission) ? "exact_paths" : "owned_prefixes");
		const finalFingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd, mission) : undefined;
		latest = this.state.read();
		if (!sameAttempt(latest)) return true;
		if (!finalFingerprint) {
			this.failReview(latest!, "could not revalidate reviewed worktree after report read");
			return true;
		}
		if (finalFingerprint !== fingerprint) {
			this.supersedeReview("worktree changed while reading the independent review report", reviewCandidateId(latest!, finalFingerprint), finalFingerprint);
			return true;
		}
		if (!report) {
			this.failReview(latest!, "independent reviewer did not submit a valid review_report artifact");
			return true;
		}
		this.state.append(this.pi, this.state.reviewEvent("awaiting_adjudication", { runId: run.spec.id, reason: "Independent review settled; parent must adjudicate the severity-derived result.", suggestedVerdict: report.verdict, worktreeFingerprint: fingerprint, candidateId, highestSeverity: report.highestSeverity, blockingFindingCount: report.blockingFindingCount, backlogFindingCount: report.backlogFindingCount, findings: report.findings, scopePaths: mission.reviewScopePaths, scopeRevisions: mission.reviewScopeRevisions }));
		this.updateStatus();
		return true;
	}

	private supersedeReview(reason: string, candidateId?: string, fingerprint?: string): void {
		const shouldBlock = (this.state.read()?.reviewSupersessionCount ?? 0) >= 2;
		this.state.append(this.pi, this.state.reviewEvent("due", { reason, outcome: "superseded", candidateId, worktreeFingerprint: fingerprint, notBeforeAt: Date.now() + REVIEW_QUIET_WINDOW_MS }));
		if (shouldBlock) this.state.append(this.pi, this.state.statusEvent("blocked", "review candidate superseded three times", reason));
		else if (this.ctx) this.scheduleRecovery(this.ctx);
		this.updateStatus();
	}

	private failReview(_mission: MissionCurrent, reason: string): void {
		const shouldBlock = this.state.readReviewFailureCount() >= 2;
		this.state.append(this.pi, this.state.reviewEvent("due", { reason, outcome: "failed" }));
		if (shouldBlock) this.state.append(this.pi, this.state.statusEvent("blocked", "independent review failed three times", reason));
		else if (this.ctx) this.scheduleRecovery(this.ctx);
		this.updateStatus();
	}

	private activeJobs() {
		return getJobManager()?.list().filter((job) => ["starting", "running", "stopping"].includes(job.runtime.status)) ?? [];
	}

	private activeSubagentWork(excludeId?: string) {
		const service = getSubagentService();
		const listed = service.list();
		return {
			runs: listed.runs.filter((run) => run.spec.id !== excludeId && ["starting", "running", "stopping"].includes(run.runtime.status)),
			groupIds: listed.groups.filter((group) => group.status === "running").map((group) => group.id),
			launchReservations: service.activeLaunchReservations?.() ?? 0,
		};
	}

	private settlementBlockers(): string[] {
		const blockers: string[] = [];
		try {
			const active = this.activeSubagentWork();
			if (active.runs.length) blockers.push(`Child execution has not settled: ${active.runs.map((run) => run.spec.id).join(", ")}`);
			if (active.groupIds.length) blockers.push(`Subagent groups have not settled: ${active.groupIds.join(", ")}`);
			if (active.launchReservations) blockers.push(`Subagent launches have not settled: ${active.launchReservations}`);
		} catch (error) {
			blockers.push(`Cannot verify child settlement: ${error instanceof Error ? error.message : String(error)}`);
		}
		const activeJobs = this.activeJobs();
		if (activeJobs.length) blockers.push(`Jobs have not settled: ${activeJobs.map((job) => job.spec.id).join(", ")}`);
		return blockers;
	}

	private updateStatus(): void {
		if (!this.ctx) return;
		const mission = this.state.read();
		if (!mission) {
			this.ctx.ui.setStatus("mission", undefined);
			return;
		}
		const theme = this.ctx.ui.theme;
		if (mission.status !== "active") {
			const color = ["blocked", "terminal_error", "budget_limited", "usage_limited"].includes(mission.status) ? "error" : "warning";
			const text = `mission ${mission.status.replace("_", " ")}`;
			this.ctx.ui.setStatus("mission", theme?.fg(color, text) ?? text);
			return;
		}
		const review = mission.reviewStatus;
		if (review === "due") return this.ctx.ui.setStatus("mission", theme?.fg("warning", "review!") ?? "review!");
		if (review === "starting" || review === "running") return this.ctx.ui.setStatus("mission", theme?.fg("accent", "review") ?? "review");
		if (review === "awaiting_adjudication") return this.ctx.ui.setStatus("mission", theme?.fg("warning", "review!") ?? "review!");
		if (review === "changes_requested") return this.ctx.ui.setStatus("mission", theme?.fg("error", "review!") ?? "review!");
		const usage = this.state.readUsage();
		if (mission.tokenBudget && usage.totalTokens / mission.tokenBudget >= 0.8) {
			const text = `mission ${compact(usage.totalTokens)}/${compact(mission.tokenBudget)}`;
			return this.ctx.ui.setStatus("mission", theme?.fg("warning", text) ?? text);
		}
		this.ctx.ui.setStatus("mission", undefined);
	}
}

function continuationMessage(mission: MissionCurrent): string {
	return [
		`Mission continuation ${mission.generation}/${mission.objectiveVersion ?? 1}.`,
		`Objective: ${mission.objective}`,
		`Requirements: ${mission.requirements.map((item) => `• ${item}`).join(" ")}`,
		`Review: ${mission.reviewStatus ?? "not_required"}${mission.reviewOutcome ? ` (${mission.reviewOutcome})` : ""}${mission.reviewReason ? ` — ${mission.reviewReason}` : ""}.`,
		...(mission.reviewStatus === "awaiting_adjudication" ? [`Review evidence: run=${mission.reviewRunId ?? "missing"}; derivedVerdict=${mission.reviewSuggestedVerdict ?? "unknown"}; highestSeverity=${mission.reviewHighestSeverity ?? "none"}; blocking=${mission.reviewBlockingFindingCount ?? 0}; backlog=${mission.reviewBacklogFindingCount ?? 0}. Retrieve bounded report evidence with subagent_wait on the exact run ID.`] : []),
		"Choose the highest-leverage next action toward the full objective; do not shrink scope to fit one turn, and work until a natural turn boundary. After starting background work, continue any runnable independent work instead of waiting merely to keep the turn open; terminal delivery wakes idle Pi automatically. Make best judgments without routine questions. Stop for credentials, safety, irreversible operations, explicit approval boundaries, terminal error, or a genuine repeated blocker. Record milestone evidence with mission_progress. Completion requires validation, independent review convergence, child settlement, Chain checkpoint, and a requirement evidence audit.",
	].join("\n");
}

function missionContext(mission: MissionCurrent, usage: ReturnType<MissionState["readUsage"]>): string {
	return [`Active Mission: ${mission.title}`, `Objective v${mission.objectiveVersion ?? 1}: ${mission.objective}`, `State: ${mission.status}; review ${mission.reviewStatus ?? "not_required"}; usage ${usage.totalTokens} tokens / $${usage.totalCostUsd.toFixed(4)}.`, "Active Mission authorization permits reversible best judgment and autonomous continuation, but never bypasses tool approval, credentials, safety, or irreversible boundaries."].join("\n");
}

function suspendedMissionContext(mission: MissionCurrent, progress: ReturnType<MissionState["readProgress"]>[number] | undefined): string {
	const resumable = ["paused", "blocked", "terminal_error"].includes(mission.status);
	return [
		`Mission control state: ${mission.status.toUpperCase()} — ${mission.title}`,
		`Reason: ${mission.lastReason ?? "not recorded"}${mission.lastSummary ? ` · ${mission.lastSummary}` : ""}`,
		`Resume target: ${mission.chain}@${mission.chainBranch}; artifacts .missions/${mission.slug}.`,
		...(progress?.remaining.length ? [`Recorded next work: ${progress.remaining.join(" | ")}`] : []),
		resumable
			? "Do not silently continue Mission work. If the current user explicitly asks to continue/resume or directly resolves this pause/blocker, call mission_resume with that concrete reason before substantive work. Otherwise honor the suspension and report the exact resume target."
			: "Do not resume or perform substantive Mission work. This limit requires an explicit Mission/budget decision from the user.",
	].join("\n");
}

interface PersistedMissionWakeDetails {
	kind?: string | null;
	missionId?: string | null;
	generation?: string | null;
	objectiveVersion?: number | null;
}

interface PersistedMissionWakeEntry {
	type?: string | null;
	customType?: string | null;
	details?: PersistedMissionWakeDetails | null;
}

interface PersistedReviewFinding {
	severity?: string | null;
	summary?: string | null;
	path?: string | null;
	line?: number | null;
	requirementIndex?: number | null;
	criticalImpact?: string | null;
}

interface PersistedReviewReport {
	version?: number | null;
	verdict?: string | null;
	overallExplanation?: string | null;
	findings?: Array<PersistedReviewFinding | null> | null;
}

function latestMissionWakeIsStale(ctx: ExtensionContext, mission: MissionCurrent): boolean {
	const branch = ctx.sessionManager.getBranch();
	// SAFETY: Session entries are untrusted; all consumed wake fields are validated below before comparison.
	const entry = branch.at(-1) as PersistedMissionWakeEntry | undefined;
	if (entry?.type !== "custom_message" || entry.customType !== "mission") return false;
	const details = entry.details;
	if (!details || details.constructor !== Object) return true;
	if (details.kind === "limit_wrapup") return false;
	return details.missionId !== mission.missionId || details.generation !== mission.generation || details.objectiveVersion !== mission.objectiveVersion;
}

interface DerivedReviewReport {
	verdict: MissionReviewVerdict;
	highestSeverity?: MissionReviewSeverity;
	blockingFindingCount: number;
	backlogFindingCount: number;
	findings: MissionReviewFinding[];
}

const REVIEW_SEVERITIES: readonly MissionReviewSeverity[] = ["blocker", "major", "minor", "nit"];

type ReviewScopeKind = "owned_prefixes" | "exact_paths";

function isCorrectionReview(mission: MissionCurrent): boolean {
	return (mission.reviewCorrectionCount ?? 0) > 0 || (mission.reviewAdjudications?.length ?? 0) > 0;
}

async function readReviewReport(run: DelegateRun, requirementCount: number, scopePaths: string[], acceptedFindings: MissionReviewFinding[] | undefined, scopeKind: ReviewScopeKind): Promise<DerivedReviewReport | undefined> {
	try {
		// SAFETY: The persisted report remains untrusted; every consumed field is validated below before domain construction.
		const report = JSON.parse(await readFile(join(run.spec.artifactsDir, "review-report.json"), "utf8")) as PersistedReviewReport | null;
		if (!report || report.constructor !== Object || report.version !== 1 || (report.verdict !== "clear" && report.verdict !== "changes_requested") || !isPersistedString(report.overallExplanation) || !Array.isArray(report.findings) || report.findings.length > 1_000) return undefined;
		const acceptedRequirements = new Set((acceptedFindings ?? []).flatMap((finding) => finding.requirementIndex === undefined ? [] : [finding.requirementIndex]));
		const findings: MissionReviewFinding[] = [];
		for (const [index, finding] of report.findings.entries()) {
			if (!finding || finding.constructor !== Object || !isPersistedString(finding.summary) || (finding.path !== undefined && !isPersistedString(finding.path)) || (finding.criticalImpact !== undefined && finding.criticalImpact !== "security" && finding.criticalImpact !== "data_loss")) return undefined;
			const submitted = reviewSeverity(finding.severity);
			const line = optionalInteger(finding.line, 1);
			const requirementIndex = optionalInteger(finding.requirementIndex, 0);
			if (!submitted || (finding.line !== undefined && line === undefined) || (finding.requirementIndex !== undefined && requirementIndex === undefined)) return undefined;
			const path = isPersistedString(finding.path) ? normalizeReviewPath(finding.path) : undefined;
			if (finding.path !== undefined && !path) return undefined;
			const criticalImpact = finding.criticalImpact === "security" || finding.criticalImpact === "data_loss" ? finding.criticalImpact : undefined;
			const blocking = submitted === "blocker" || submitted === "major";
			const requirementLinked = requirementIndex !== undefined && requirementIndex < requirementCount;
			const accepted = acceptedFindings === undefined || acceptedFindings.length === 0 || (requirementIndex !== undefined && acceptedRequirements.has(requirementIndex)) || criticalImpact !== undefined;
			const withinScope = path !== undefined && scopePaths.some((scopePath) => scopeKind === "exact_paths" ? path === scopePath : scopePath === "." || path === scopePath || path.startsWith(`${scopePath}/`));
			const severity = blocking && (!requirementLinked && !criticalImpact || !accepted || !withinScope) ? "minor" : submitted;
			const parsed: MissionReviewFinding = { index, severity, summary: finding.summary.slice(0, 4_000) };
			if (path) parsed.path = path;
			if (line !== undefined) parsed.line = line;
			if (requirementIndex !== undefined) parsed.requirementIndex = requirementIndex;
			if (criticalImpact) parsed.criticalImpact = criticalImpact;
			findings.push(parsed);
		}
		if (scopeKind === "exact_paths") {
			for (const finding of acceptedFindings ?? []) {
				if ((finding.severity !== "blocker" && finding.severity !== "major") || (finding.path !== undefined && scopePaths.includes(finding.path))) continue;
				findings.push({ ...finding, index: findings.length });
			}
		}
		const severities = findings.map((finding) => finding.severity);
		const blockingFindingCount = severities.filter((severity) => severity === "blocker" || severity === "major").length;
		return {
			verdict: blockingFindingCount > 0 ? "changes_requested" : "clear",
			highestSeverity: REVIEW_SEVERITIES.find((severity) => severities.includes(severity)),
			blockingFindingCount,
			backlogFindingCount: severities.length - blockingFindingCount,
			findings,
		};
	} catch { return undefined; }
}

function reviewSeverity(value: string | null | undefined): MissionReviewSeverity | undefined {
	return value === "blocker" || value === "major" || value === "minor" || value === "nit" ? value : undefined;
}

function optionalInteger(value: number | null | undefined, minimum: number): number | undefined {
	return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : undefined;
}

function isPersistedString(value: string | null | undefined): value is string {
	return value !== undefined && value !== null && value.constructor === String;
}

function normalizeReviewPath(path: string): string | undefined {
	const normalized = path.replace(/^\.\//, "");
	return normalized && !normalized.startsWith("/") && !normalized.includes("\\") && !normalized.split("/").includes("..") ? normalized : undefined;
}

function reviewCandidateId(mission: MissionCurrent, fingerprint: string): string {
	const input = JSON.stringify({ version: 1, objectiveVersion: mission.objectiveVersion ?? 1, paths: [...mission.paths].sort(), fingerprint });
	return `candidate_${createHash("sha256").update(input).digest("hex")}`;
}

interface MissionWorkspaceRoot {
	root: string;
	scopes: string[];
}

const MAX_FINGERPRINT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FINGERPRINT_PATH_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINT_PATHS = 100_000;

async function resolveMissionWorkspace(pi: ExtensionAPI, cwd: string, paths: string[]): Promise<MissionWorkspaceRoot[] | undefined> {
	const pathless = paths.length === 0;
	const candidates = pathless ? [resolve(cwd)] : paths.map((item) => resolve(cwd, item));
	const canonicalCwd = await canonicalPath(resolve(cwd));
	if (!canonicalCwd) return undefined;
	const roots = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		const canonicalCandidate = await canonicalPath(candidate);
		if (!canonicalCandidate) return undefined;
		const ownedPath = relative(canonicalCwd, canonicalCandidate).replaceAll("\\", "/");
		if (ownedPath === ".." || ownedPath.startsWith("../")) return undefined;
		const canonicalStart = await nearestDirectory(canonicalCandidate);
		if (!canonicalStart) return undefined;
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalStart }).catch(() => undefined);
		if (!result || result.code !== 0 || !result.stdout.trim()) return undefined;
		const root = await realpath(resolve(result.stdout.trim())).catch(() => resolve(result.stdout.trim()));
		const scope = pathless ? "" : relative(root, canonicalCandidate).replaceAll("\\", "/");
		if (scope === ".." || scope.startsWith("../")) return undefined;
		const scopes = roots.get(root) ?? new Set<string>();
		if (!scope) scopes.clear();
		else if (scopes.size || !roots.has(root)) scopes.add(scope);
		roots.set(root, scopes);
	}
	return [...roots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([root, scopes]) => ({ root, scopes: [...scopes].sort() }));
}

async function canonicalPath(candidate: string): Promise<string | undefined> {
	return realpath(resolve(candidate)).catch(() => undefined);
}

async function nearestDirectory(candidate: string): Promise<string | undefined> {
	let current = candidate;
	while (true) {
		try {
			const info = await stat(current);
			return info.isDirectory() ? current : dirname(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

function reviewPaths(reviewCwd: string, workspace: MissionWorkspaceRoot[]): string[] {
	return workspace.flatMap(({ root, scopes }) => {
		const prefix = relative(reviewCwd, root).replaceAll("\\", "/");
		if (!scopes.length) return [prefix || "."];
		return scopes.map((scope) => [prefix, scope].filter(Boolean).join("/"));
	});
}

function reviewGitPathspec(canonicalCwd: string, cwd: string, root: string, scopes: string[], ignoredPaths: string[]): string[] {
	const exclusions = ignoredPaths.flatMap((ignored) => {
		const path = relative(root, resolve(canonicalCwd, relative(resolve(cwd), resolve(ignored)))).replaceAll("\\", "/");
		return path && path !== ".." && !path.startsWith("../") ? [`:(top,exclude,literal)${path}/`] : [];
	});
	const pathspecs = [...scopes.map((scope) => `:(literal)${scope}`), ...exclusions];
	return pathspecs.length ? ["--", ...pathspecs] : [];
}

async function reviewedWorkspaceRevisions(pi: ExtensionAPI, cwd: string, reviewCwd: string, workspace: MissionWorkspaceRoot[], ignoredPaths: string[]): Promise<MissionReviewRevision[] | undefined> {
	const canonicalCwd = await canonicalPath(cwd);
	if (!canonicalCwd) return undefined;
	const revisions: MissionReviewRevision[] = [];
	for (const { root, scopes } of workspace) {
		const pathspec = reviewGitPathspec(canonicalCwd, cwd, root, scopes, ignoredPaths);
		const [status, head] = await Promise.all([
			pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", ...pathspec], { cwd: root }),
			pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }),
		]);
		const headCommit = head.stdout.trim();
		const revisionRoot = normalizeReviewPath(relative(reviewCwd, root).replaceAll("\\", "/") || ".");
		if (status.code !== 0 || status.stdout || head.code !== 0 || !revisionRoot || !/^[0-9a-f]{40,64}$/.test(headCommit)) return undefined;
		revisions.push({ root: revisionRoot, base: headCommit, head: headCommit });
	}
	return revisions;
}

async function correctionReviewScope(pi: ExtensionAPI, cwd: string, reviewCwd: string, workspace: MissionWorkspaceRoot[], ignoredPaths: string[], acceptedRevisions: MissionReviewRevision[] | undefined): Promise<{ paths: string[]; revisions: MissionReviewRevision[] } | undefined> {
	const current = await reviewedWorkspaceRevisions(pi, cwd, reviewCwd, workspace, ignoredPaths);
	if (!current || (acceptedRevisions && (acceptedRevisions.length !== current.length || new Set(acceptedRevisions.map((revision) => revision.root)).size !== acceptedRevisions.length))) return undefined;
	const canonicalCwd = await canonicalPath(cwd);
	if (!canonicalCwd) return undefined;
	const paths = new Set<string>();
	const revisions: MissionReviewRevision[] = [];
	for (const [index, { root, scopes }] of workspace.entries()) {
		const head = current[index];
		if (!head) return undefined;
		let baseCommit: string;
		if (acceptedRevisions === undefined) {
			const legacyBase = await pi.exec("git", ["rev-parse", "--verify", "HEAD^"], { cwd: root });
			baseCommit = legacyBase.stdout.trim();
			if (legacyBase.code !== 0 || !/^[0-9a-f]{40,64}$/.test(baseCommit)) return undefined;
		} else {
			const accepted = acceptedRevisions.find((revision) => revision.root === head.root);
			if (!accepted) return undefined;
			baseCommit = accepted.head;
			const ancestor = await pi.exec("git", ["merge-base", "--is-ancestor", baseCommit, head.head], { cwd: root });
			if (ancestor.code !== 0) return undefined;
		}
		const pathspec = reviewGitPathspec(canonicalCwd, cwd, root, scopes, ignoredPaths);
		const changed = await pi.exec("git", ["diff", "--name-only", "--no-renames", "-z", baseCommit, head.head, ...pathspec], { cwd: root });
		if (changed.code !== 0 || changed.stdout.length > MAX_FINGERPRINT_PATH_BYTES) return undefined;
		const prefix = head.root === "." ? "" : head.root;
		for (const item of changed.stdout.split("\0").filter(Boolean)) {
			const path = normalizeReviewPath([prefix, item].filter(Boolean).join("/"));
			if (!path) return undefined;
			paths.add(path);
		}
		revisions.push({ root: head.root, base: baseCommit, head: head.head });
	}
	return paths.size && paths.size <= 1_000 ? { paths: [...paths].sort(), revisions } : undefined;
}

// Exclude all Mission and Chain durable state: their snapshot/link writes mutate the tree every turn and would otherwise churn the fingerprint into a permanent review-due loop. Admission and completion must use the identical list or their fingerprints can never match.
function missionIgnoredPaths(cwd: string): string[] {
	return [missionRoot(cwd), join(cwd, ".chains")];
}

async function worktreeFingerprint(pi: ExtensionAPI, cwd: string, mission: MissionCurrent | undefined): Promise<string | undefined> {
	if (!mission) return undefined;
	const workspace = await resolveMissionWorkspace(pi, cwd, mission.paths);
	return workspace ? workspaceFingerprint(pi, cwd, workspace, missionIgnoredPaths(cwd)) : undefined;
}

async function workspaceFingerprint(pi: ExtensionAPI, cwd: string, workspace: MissionWorkspaceRoot[], ignoredPaths: string[]): Promise<string | undefined> {
	try {
		const hash = createHash("sha256");
		const canonicalCwd = await canonicalPath(cwd);
		if (!canonicalCwd) return undefined;
		let totalBytes = 0;
		let totalPaths = 0;
		for (const { root, scopes } of workspace) {
			const literalScopes = scopes.map((scope) => `:(literal)${scope}`);
			const exclusions = ignoredPaths.flatMap((ignored) => {
				const canonicalIgnored = resolve(canonicalCwd, relative(resolve(cwd), resolve(ignored)));
				const path = relative(root, canonicalIgnored).replaceAll("\\", "/");
				return path && path !== ".." && !path.startsWith("../") ? [`:(top,exclude,literal)${path}/`] : [];
			});
			// No positive sentinel for the pathless case: `:(top,literal).` matches nothing. An exclusion-only pathspec means "everything except", and an empty pathspec means the whole repo.
			const gitPathspecs = [...literalScopes, ...exclusions];
			const pathspec = gitPathspecs.length ? ["--", ...gitPathspecs] : [];
			const [staged, flags, untracked] = await Promise.all([
				pi.exec("git", ["ls-files", "--cached", "--stage", "-z", ...pathspec], { cwd: root }),
				pi.exec("git", ["ls-files", "--cached", "-v", "-z", ...pathspec], { cwd: root }),
				pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], { cwd: root }),
			]);
			if (staged.code !== 0 || flags.code !== 0 || untracked.code !== 0 || staged.stdout.length + flags.stdout.length + untracked.stdout.length > MAX_FINGERPRINT_PATH_BYTES) return undefined;
			const tracked = new Map<string, string>();
			for (const record of staged.stdout.split("\0").filter(Boolean)) {
				const match = /^(\d{6}) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(record);
				if (!match || match[2] !== "0" || tracked.has(match[3]!)) return undefined;
				tracked.set(match[3]!, match[1]!);
			}
			const trackedFlags = new Map<string, string>();
			for (const record of flags.stdout.split("\0").filter(Boolean)) {
				if (record.length < 3 || record[1] !== " ") return undefined;
				trackedFlags.set(record.slice(2), record[0]!);
			}
			if (trackedFlags.size !== tracked.size || [...tracked].some(([path]) => trackedFlags.get(path) !== "H")) return undefined;
			const paths = [...new Set([...tracked.keys(), ...untracked.stdout.split("\0").filter(Boolean)])].sort();
			totalPaths += paths.length;
			if (totalPaths > MAX_FINGERPRINT_PATHS) return undefined;
			hash.update(relative(canonicalCwd, root) || ".").update("\0").update(scopes.join("\0")).update("\0content-tree\0");
			for (const path of paths) {
				const consumed = await hashWorkspacePath(hash, root, path, tracked.get(path), totalBytes);
				if (consumed === undefined) return undefined;
				totalBytes += consumed;
			}
		}
		return hash.digest("hex");
	} catch { return undefined; }
}

async function hashWorkspacePath(hash: Hash, root: string, path: string, indexMode: string | undefined, totalBytes: number): Promise<number | undefined> {
	const target = resolve(root, path);
	const relativeTarget = relative(root, target).replaceAll("\\", "/");
	if (relativeTarget !== path || relativeTarget === ".." || relativeTarget.startsWith("../")) return undefined;
	const info = await lstat(target).catch(() => undefined);
	// An ordinary indexed path absent from the worktree is a deletion and contributes no final-tree entry. Sparse and hidden index entries were rejected by the caller.
	if (!info) return indexMode ? 0 : undefined;
	hash.update(path).update("\0");
	if (info.isSymbolicLink()) {
		const link = await readlink(target).catch(() => undefined);
		if (link === undefined) return undefined;
		hash.update("120000\0").update(link).update("\0");
		return 0;
	}
	// Submodule worktrees require a separate recursive ownership model; fail closed rather than fingerprinting only the gitlink while nested contents may be dirty.
	if (indexMode === "160000" || info.isDirectory()) return undefined;
	if (!info.isFile() || info.size > MAX_FINGERPRINT_FILE_BYTES || totalBytes + info.size > MAX_FINGERPRINT_TOTAL_BYTES) return undefined;
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
	if (!handle) return undefined;
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > MAX_FINGERPRINT_FILE_BYTES || totalBytes + opened.size > MAX_FINGERPRINT_TOTAL_BYTES) return undefined;
		hash.update(opened.mode & 0o111 ? "100755\0" : "100644\0").update(String(opened.size)).update("\0");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (position < opened.size) {
			const length = Math.min(buffer.length, opened.size - position);
			const { bytesRead } = await handle.read(buffer, 0, length, position);
			if (bytesRead <= 0) return undefined;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		const final = await handle.stat();
		if (final.size !== opened.size || (final.mode & 0o111) !== (opened.mode & 0o111)) return undefined;
		hash.update("\0");
		return opened.size;
	} finally {
		await handle.close();
	}
}

function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(Math.round(value));
}
