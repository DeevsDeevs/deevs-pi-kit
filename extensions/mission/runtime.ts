import { createHash, randomUUID, type Hash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainCheckpoints } from "../chains/checkpoint.ts";
import { getSubagentService } from "../subagents/registry.ts";
import { SubagentAdmissionReservedError, type SubagentService } from "../subagents/service.ts";
import { getJobManager } from "../jobs/registry.ts";
import type { JobRecord } from "../jobs/types.ts";
import type { DelegateRun } from "../subagents/runtime-types.ts";
import { runtimeEvents } from "../shared/runtime-events.ts";
import { MissionState } from "./state.ts";
import { missionRoot } from "./artifacts.ts";
import { MAX_MISSION_REVIEW_ADJUDICATIONS } from "./types.ts";
import type {
	MissionCompleteInput,
	MissionCurrent,
	MissionProgressInput,
	MissionProgressRecord,
	MissionReviewAdmission,
	MissionReviewCriticalImpact,
	MissionReviewFinding,
	MissionReviewRevision,
	MissionReviewSeverity,
	MissionReviewStatus,
	MissionReviewVerdict,
	MissionUpdateInput,
	MissionUsage,
} from "./types.ts";

const REVIEW_QUIET_WINDOW_MS = 100;
const ACTIVE_RUNTIME_STATUSES = ["starting", "running", "stopping"];

const LIMIT_WRAPUP_GUIDANCE = "Do not start substantive work. Record a concise progress/blocker/next-step handoff, settle "
	+ "active children, and save the due Chain checkpoint. Complete only if the evidence gate was already satisfied.";
const STALE_WAKE_GUARD = "This Mission continuation wake is stale after a pause/objective/generation change. Do not perform "
	+ "substantive work; report the stale wake and settle immediately.";
const MISSION_AUTHORIZATION_NOTE = "Active Mission authorization permits reversible best judgment and autonomous continuation, "
	+ "but never bypasses tool approval, credentials, safety, or irreversible boundaries.";
const CONTINUATION_GUIDANCE = "Choose the highest-leverage next action toward the full objective; do not shrink scope to "
	+ "fit one turn, and work until a natural turn boundary. After starting background work, continue any runnable independent "
	+ "work instead of waiting merely to keep the turn open; terminal delivery wakes idle Pi automatically. Make best judgments "
	+ "without routine questions. Stop for credentials, safety, irreversible operations, explicit approval boundaries, terminal "
	+ "error, or a genuine repeated blocker. Record milestone evidence with mission_progress. Completion requires validation, "
	+ "independent review convergence, child settlement, Chain checkpoint, and a requirement evidence audit.";
const RESUMABLE_MISSION_GUIDANCE = "Do not silently continue Mission work. If the current user explicitly asks to continue/resume "
	+ "or directly resolves this pause/blocker, call mission_resume with that concrete reason before substantive work. Otherwise "
	+ "honor the suspension and report the exact resume target.";
const LIMITED_MISSION_GUIDANCE = "Do not resume or perform substantive Mission work. This limit requires an explicit Mission/budget "
	+ "decision from the user.";
const MISSING_FINGERPRINT_BLOCKER = "Mission workspace could not be fingerprinted; ensure explicit Mission paths exist, stay "
	+ "inside cwd, and resolve to Git repositories.";
const WORKSPACE_RESOLUTION_FAILURE = "could not resolve and fingerprint the Mission Git workspace; ensure explicit Mission "
	+ "paths exist, stay inside cwd, and resolve to Git repositories";
const CORRECTION_BLOCKING_RULE = "A blocker/major finding must name a Runtime-enforced changed path and include either an "
	+ "accepted requirementIndex or a typed criticalImpact of security or data_loss.";
const INITIAL_BLOCKING_RULE = "A blocker/major finding must name a path in the typed Mission workspace and include either "
	+ "its violated requirementIndex or a typed criticalImpact of security or data_loss.";

interface MissionAgentMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

interface ActiveSubagentWork {
	runs: DelegateRun[];
	groupIds: string[];
	launchReservations: number;
}

/** The exact review candidate a fresh reviewer admission was accepted for. */
interface AdmittedReviewCandidate {
	current: MissionCurrent;
	candidateId: string;
}

/** Runtime-enforced paths and revisions one reviewer run may inspect. */
interface ReviewAdmissionScope {
	paths: string[];
	correctionReview: boolean;
	correction?: MissionCorrectionScope;
	initialRevisions?: MissionReviewRevision[];
}

interface MissionRequirementAudit {
	requirementIndex: number;
	evidence: string;
}

interface MissionSystemPrompt {
	systemPrompt: string;
}

function isCommitSha(value: string): boolean {
	return /^[0-9a-f]{40,64}$/.test(value);
}

function escapesRoot(relativePath: string): boolean {
	return relativePath === ".." || relativePath.startsWith("../");
}

function isActiveRuntimeStatus(status: string): boolean {
	return ACTIVE_RUNTIME_STATUSES.includes(status);
}

/** Review dispositions that hold the worktree: a reviewer is running or is about to start. */
function reviewHoldsWorktree(status: MissionReviewStatus): boolean {
	return status === "starting" || status === "running" || status === "due";
}

function missionIsFinished(mission: MissionCurrent): boolean {
	return mission.status === "complete" || mission.status === "ended";
}

function missionAwaitsContinuation(mission: MissionCurrent): boolean {
	return mission.status === "active" && !mission.review.admission.initialBaselinePending;
}

function reviewIsDue(mission: MissionCurrent): boolean {
	return mission.status === "active" && mission.review.admission.status === "due";
}

/** The reviewer run id reconciliation may still adopt, or undefined when no run is recoverable. */
function recoverableReviewRunId(mission: MissionCurrent): string | undefined {
	if (mission.status !== "active") return undefined;
	if (mission.review.admission.status !== "running") return undefined;
	return mission.review.admission.runId;
}

function sessionCanContinue(ctx: ExtensionContext): boolean {
	if (!ctx.isIdle()) return false;
	if (ctx.hasPendingMessages()) return false;
	return Boolean(ctx.sessionManager.getSessionFile());
}

function hasActiveSubagentWork(work: ActiveSubagentWork): boolean {
	if (work.runs.length) return true;
	if (work.groupIds.length) return true;
	return Boolean(work.launchReservations);
}

function worktreeChangedDuringTurn(before: string | undefined, after: string | undefined): boolean {
	if (before === undefined) return false;
	if (after === undefined) return false;
	return before !== after;
}

/** True once the objective, scope, or worktree no longer matches the candidate the reviewer was admitted for. */
function reviewCandidateDrifted(mission: MissionCurrent, fingerprint: string, candidateId: string): boolean {
	const candidate = mission.review.candidate;
	if (!candidate.worktreeFingerprint) return true;
	if (candidate.worktreeFingerprint !== fingerprint) return true;
	if (candidate.objectiveVersion !== (mission.objectiveVersion ?? 1)) return true;
	return candidate.id !== candidateId;
}

function isFingerprintableFile(info: Stats, totalBytes: number): boolean {
	if (!info.isFile()) return false;
	if (info.size > MAX_FINGERPRINT_FILE_BYTES) return false;
	return totalBytes + info.size <= MAX_FINGERPRINT_TOTAL_BYTES;
}

/** Review dispositions whose evidence is bound to one exact candidate rather than the last admitted workspace. */
function isCandidateBoundReview(status: MissionReviewStatus): boolean {
	return status === "starting"
		|| status === "running"
		|| status === "awaiting_adjudication"
		|| status === "changes_requested"
		|| status === "clear";
}

function wasAborted(messages: MissionAgentMessage[]): boolean {
	return messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
}

function hasSuccessfulValidation(progress: MissionProgressRecord, objectiveVersion: number): boolean {
	return progress.validation.some((item) => item.exitCode === 0 && item.objectiveVersion === objectiveVersion);
}

function auditBlockers(audit: MissionRequirementAudit[], requirementCount: number): string[] {
	const blockers: string[] = [];
	if (audit.some((item) => item.requirementIndex < 0 || item.requirementIndex >= requirementCount)) {
		blockers.push("Requirement audit contains an unknown requirementIndex.");
	}
	if (audit.some((item) => !item.evidence.trim())) blockers.push("Requirement audit contains empty evidence.");
	if (new Set(audit.map((item) => item.requirementIndex)).size !== audit.length) {
		blockers.push("Requirement audit contains duplicate requirementIndex entries.");
	}
	return blockers;
}

function reviewContinuationBlockers(admission: MissionReviewAdmission): string[] {
	const run = admission.runId ? `: ${admission.runId}` : "";
	switch (admission.status) {
		case "starting":
			return ["independent review admission is starting"];
		case "running":
			return [`independent review still running${run}`];
		case "due":
			return ["independent review is due"];
		case "awaiting_adjudication":
			return [`independent review is ready for adjudication${run}`];
		case "not_required":
		case "changes_requested":
		case "clear":
		case "skipped":
			return [];
		default: {
			const exhaustive: never = admission.status;
			throw new Error(`Unhandled Mission review status: ${String(exhaustive)}`);
		}
	}
}

function formatAcceptedFinding(finding: MissionReviewFinding): string {
	const requirement = finding.requirementIndex ?? "none";
	const impact = finding.criticalImpact ?? "none";
	return `#${finding.index} requirement=${requirement} criticalImpact=${impact} path=${finding.path ?? "none"}: ${finding.summary}`;
}

function correctionReviewMode(scope: MissionCorrectionScope, accepted: MissionReviewFinding[], latestSummary: string | undefined): string {
	const revisions = scope.revisions.map((revision) => `${revision.root}:${revision.base}..${revision.head}`).join(", ");
	const findings = accepted.length
		? accepted.map(formatAcceptedFinding).join(" | ")
		: "legacy correction scope; use only the exact changed paths";
	return [
		"This is a bounded correction review.",
		"Prior adjudicated evidence remains authoritative for untouched areas.",
		`Review only these Runtime-enforced changed paths: ${scope.paths.join(", ")}.`,
		`Exact revisions: ${revisions}.`,
		`Accepted findings: ${findings}.`,
		`Latest correction record: ${latestSummary ?? "none"}.`,
	].join(" ");
}

function reviewerTask(current: MissionCurrent, scope: ReviewAdmissionScope, latestSummary: string | undefined): string {
	const paths = `Review only these typed Mission workspace paths: ${scope.paths.join(", ")}.`;
	const reviewMode = scope.correction
		? correctionReviewMode(scope.correction, current.review.findings.accepted ?? [], latestSummary)
		: "This is the initial full Mission review.";
	const blockingRule = scope.correctionReview ? CORRECTION_BLOCKING_RULE : INITIAL_BLOCKING_RULE;
	const requirements = current.requirements.map((requirement, index) => `[${index}] ${requirement}`).join(" | ");
	return [
		`Fresh independent Mission review. ${paths} ${reviewMode} Ignore unrelated pre-existing working-tree changes.`,
		`Mission: ${current.title}.`,
		`Objective: ${current.objective}.`,
		`Requirements: ${requirements}.`,
		`${blockingRule} Otherwise record it as minor/nit follow-up.`,
		"Call the schema-validated review_report tool exactly once, then summarize for the parent. Do not edit files.",
	].join(" ");
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
		this.state.append(this.pi, this.state.reviewEvent("not_required", {
			reason: "Initial workspace baseline persisted.",
			worktreeFingerprint: fingerprint,
		}));
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
		if (mission?.review.admission.status === "starting") {
			this.state.append(this.pi, this.state.reviewEvent("due", {
				reason: "explicit resume authorized reconciliation of ambiguous reviewer admission",
				candidateId: mission.review.candidate.id,
				admissionId: mission.review.admission.admissionId,
			}));
		}
		this.updateStatus();
		this.scheduleRecovery(ctx);
	}

	onProgress(input: MissionProgressInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		if (input.reviewVerdict) {
			const mission = this.state.read();
			const awaiting = mission?.review.admission.status === "awaiting_adjudication"
				&& Boolean(input.reviewRunId)
				&& input.reviewRunId === mission.review.admission.runId;
			if (!mission || !awaiting) throw new Error("Review adjudication requires the exact awaiting reviewer run id.");
			if (!input.reviewReason?.trim()) throw new Error("Review adjudication requires an evidence-based reason.");
			if (input.reviewVerdict !== mission.review.adjudication.suggestedVerdict) {
				const suggested = mission.review.adjudication.suggestedVerdict ?? "unknown";
				throw new Error(`Review adjudication must match the severity-derived verdict: ${suggested}.`);
			}
			const adjudicated = this.state.append(this.pi, this.state.reviewEvent(input.reviewVerdict, {
				runId: input.reviewRunId,
				reason: input.reviewReason,
				candidateId: mission.review.candidate.id,
			}));
			chainCheckpoints.current?.due(`Mission review adjudicated: ${input.reviewVerdict}`, "mission_milestone");
			this.blockOnCorrectionLimit(adjudicated);
		}
		this.updateStatus();
	}

	/** A correction cycle past its limit blocks the Mission until the user authorizes another round. */
	private blockOnCorrectionLimit(mission: MissionCurrent | undefined): void {
		if (mission?.review.admission.status !== "changes_requested") return;
		const correction = mission.review.correction;
		if (correction.count <= correction.limit) return;
		this.state.append(this.pi, this.state.statusEvent(
			"blocked",
			"review correction limit reached",
			`Correction cycle ${correction.count} requires explicit user authorization.`,
		));
	}

	async workspaceFingerprint(ctx: ExtensionContext): Promise<string | undefined> {
		this.restore(ctx);
		return worktreeFingerprint(this.pi, ctx.cwd, this.state.read());
	}

	async authorizeCompletion(ctx: ExtensionContext): Promise<string> {
		this.restore(ctx);
		const mission = this.state.read();
		const reviewStatus = mission?.review.admission.status ?? "not_required";
		if (
			!mission
			|| (reviewStatus !== "clear" && reviewStatus !== "skipped" && reviewStatus !== "not_required")
		) throw new Error("Mission completion cannot be authorized before review convergence.");
		const settlement = this.settlementBlockers();
		if (settlement.length) throw new Error(`Mission completion cannot be authorized while child work is unsettled: ${settlement.join("; ")}`);
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) throw new Error("Mission completion authorization requires an exact workspace fingerprint.");
		const candidateId = reviewCandidateId(mission, fingerprint);
		if (reviewStatus === "clear") {
			const adjudication = mission.review.adjudication;
			const converged = mission.review.candidate.worktreeFingerprint === fingerprint
				&& adjudication.adjudicatedCandidateId === candidateId
				&& adjudication.adjudicatedVerdict === "clear";
			if (!converged) throw new Error("Mission completion authorization requires review convergence for the current candidate.");
		}
		if (reviewStatus === "skipped" || reviewStatus === "not_required") {
			if (mission.review.candidate.admittedWorktreeFingerprint !== fingerprint) {
				throw new Error("Mission completion authorization requires the converged disposition to match the current workspace fingerprint.");
			}
		}
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
		const correctionCount = mission.review.correction.count;
		const correctionBlocked = mission.status === "blocked" && correctionCount > mission.review.correction.limit;
		this.state.append(this.pi, this.state.reviewPolicyEvent(correctionCount));
		if (correctionBlocked && !this.state.limitExceeded()) {
			const reason = "explicit user authorization allowed one additional review correction";
			this.state.append(this.pi, this.state.statusEvent("active", reason));
		}
		chainCheckpoints.current?.due(`Mission review correction cycle ${correctionCount} authorized`, "mission_control");
		this.updateStatus();
		void this.maybeContinue(ctx);
	}

	onObjectiveUpdated(_input: MissionUpdateInput, ctx: ExtensionContext): void {
		this.restore(ctx);
		chainCheckpoints.current?.due("Mission objective updated", "mission_control");
		const mission = this.state.read();
		if ((mission?.review.admission.supersessionCount ?? 0) >= 3) {
			this.state.append(this.pi, this.state.statusEvent(
				"blocked",
				"review candidate superseded three times",
				"Mission identity changed repeatedly before review convergence.",
			));
		} else this.scheduleRecovery(ctx);
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
		blockers.push(...auditBlockers(audit, mission.requirements.length));
		const validation = this.state.readProgress().flatMap((progress) => progress.validation);
		const objectiveVersion = mission.objectiveVersion ?? 1;
		if (!validation.some((item) => item.exitCode === 0 && item.objectiveVersion === objectiveVersion)) {
			blockers.push("No successful structured validation is recorded for the current objectiveVersion.");
		}
		if (!["clear", "skipped", "not_required"].includes(mission.review.admission.status ?? "not_required")) {
			blockers.push(`Independent review is ${mission.review.admission.status ?? "due"}.`);
		}
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) blockers.push(MISSING_FINGERPRINT_BLOCKER);
		else blockers.push(...this.completionCandidateBlockers(mission, fingerprint));
		if (chainCheckpoints.current && !chainCheckpoints.current.isSatisfied(mission.chain, mission.chainBranch)) {
			blockers.push(`The Mission Chain checkpoint ${mission.chain}@${mission.chainBranch} is not saved or explicitly waived.`);
		}
		return blockers;
	}

	/** Blockers for the user-authorized completion latch and the reviewed candidate the current worktree must match. */
	private completionCandidateBlockers(mission: MissionCurrent, fingerprint: string): string[] {
		const blockers: string[] = [];
		const candidateId = reviewCandidateId(mission, fingerprint);
		const latch = mission.review.completionLatch;
		if (latch.candidateId !== candidateId) {
			if (latch.candidateId) this.state.append(this.pi, this.state.completionLatchClearedEvent());
			blockers.push("Mission completion is not user-authorized for the current objective/scope/fingerprint candidate.");
		} else if (latch.reviewStatus !== mission.review.admission.status) {
			blockers.push("Mission completion authorization does not match the current converged review disposition.");
		}
		const candidate = mission.review.candidate;
		const adjudication = mission.review.adjudication;
		const status = mission.review.admission.status;
		if (status === "clear") {
			const reviewedCandidate = fingerprint === candidate.worktreeFingerprint
				&& adjudication.adjudicatedCandidateId === candidateId
				&& adjudication.adjudicatedVerdict === "clear";
			if (!reviewedCandidate) blockers.push("Worktree differs from the severity-adjudicated reviewed candidate.");
		} else if (status === "not_required" || status === "skipped") {
			if (!candidate.admittedWorktreeFingerprint) blockers.push("No durable admitted workspace fingerprint is recorded.");
			else if (fingerprint !== candidate.admittedWorktreeFingerprint) {
				blockers.push("Worktree differs from the last durable admitted workspace fingerprint.");
			}
		}
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
		this.pi.on("turn_start", async (_event, ctx) => this.onTurnStart(ctx));
		this.pi.on("agent_end", (event, ctx) => {
			this.lastAgentMessages = [...event.messages];
			this.lastAbortWasSteered = this.currentRunSteered && wasAborted(this.lastAgentMessages);
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
		this.pi.on("before_agent_start", (event, ctx) => this.missionSystemPrompt(event.systemPrompt, ctx));
		this.pi.on("agent_settled", async (_event, ctx) => {
			this.continuationInFlight = false;
			this.restore(ctx);
			await this.onSettled(ctx);
		});
		this.pi.on("session_shutdown", () => this.onShutdown());
	}

	private async onTurnStart(ctx: ExtensionContext): Promise<void> {
		this.restore(ctx);
		const beforeTurn = this.state.read();
		if (beforeTurn?.review.admission.initialBaselinePending) {
			ctx.abort();
			return;
		}
		this.worktreeBeforeTurn = await this.reconcileWorkspaceFingerprint(ctx);
		const becameDue = beforeTurn?.review.admission.status !== "due" && this.state.read()?.review.admission.status === "due";
		if (becameDue) ctx.abort();
	}

	private missionSystemPrompt(systemPrompt: string, ctx: ExtensionContext): MissionSystemPrompt | undefined {
		this.restore(ctx);
		const mission = this.state.readAny();
		const ownershipConflict = this.state.readOwnershipConflict();
		if (!mission && ownershipConflict) {
			const transferred = `Mission ${ownershipConflict.missionId} was transferred to another Pi session.`
				+ " Do not continue its work or act on stale Mission wakes in this session.";
			return { systemPrompt: `${systemPrompt}\n\n${transferred}` };
		}
		if (!mission) return undefined;
		if (missionIsFinished(mission)) return undefined;
		if (mission.status !== "active") {
			return { systemPrompt: `${systemPrompt}\n\n${suspendedMissionContext(mission, this.state.readProgress().at(-1))}` };
		}
		const wakeGuard = latestMissionWakeIsStale(ctx, mission) ? `\n\n${STALE_WAKE_GUARD}` : "";
		return { systemPrompt: `${systemPrompt}\n\n${missionContext(mission, this.state.readUsage())}${wakeGuard}` };
	}

	private onShutdown(): void {
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
	}

	continuationBlockers(ctx: ExtensionContext): string[] {
		this.restore(ctx);
		const mission = this.state.readAny();
		if (!mission) return ["No Mission exists on this branch."];
		if (mission.status !== "active") return [`Mission status is ${mission.status}.`];
		const blockers: string[] = [];
		if (mission.review.admission.initialBaselinePending) blockers.push("initial workspace baseline is pending durable admission");
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
		blockers.push(...reviewContinuationBlockers(mission.review.admission));
		if (ctx.hasPendingMessages()) blockers.push("user messages are queued ahead of autonomous continuation");
		return blockers;
	}

	async maybeContinue(ctx: ExtensionContext): Promise<void> {
		this.restore(ctx);
		const mission = this.state.read();
		if (this.disposed || this.continuationInFlight) return;
		if (!mission || !missionAwaitsContinuation(mission)) return;
		if (!sessionCanContinue(ctx)) return;
		let activeSubagents: ActiveSubagentWork;
		try {
			activeSubagents = this.activeSubagentWork();
		} catch {
			return;
		}
		if (this.continuationIsBlocked(mission, activeSubagents)) return;
		const event = this.state.continuedEvent();
		this.state.append(this.pi, event);
		this.continuationInFlight = true;
		try {
			this.pi.sendMessage({
				customType: "mission",
				content: continuationMessage(mission),
				display: false,
				details: {
					version: 2,
					missionId: mission.missionId,
					generation: mission.generation,
					objectiveVersion: mission.objectiveVersion,
				},
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {
			this.continuationInFlight = false;
			this.scheduleRecovery(ctx, 1_000);
		}
	}

	private continuationIsBlocked(mission: MissionCurrent, activeSubagents: ActiveSubagentWork): boolean {
		if (this.state.budgetExceeded()) return true;
		if (hasActiveSubagentWork(activeSubagents)) return true;
		if (this.activeJobs().length) return true;
		const admission = mission.review.admission;
		// Block on "due" as well as "running": a continuation turn during the review-admission window would mutate the
		// worktree while a reviewer is about to start, guaranteeing a review failure and wasting a strike.
		if (reviewHoldsWorktree(admission.status)) return true;
		if (admission.status !== "awaiting_adjudication") return false;
		return (mission.lastContinuationAt ?? 0) >= (admission.updatedAt ?? mission.updatedAt);
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
				this.state.append(this.pi, this.state.statusEvent(
					"blocked",
					"workspace fingerprint unavailable during recovery",
					"Mission recovery cannot verify its durable candidate.",
				));
				this.updateStatus();
				return;
			}
			if (recoveredMission?.status === "active" && recoveredMission.review.admission.initialBaselinePending) {
				this.state.append(this.pi, this.state.reviewEvent("not_required", {
					reason: "Recovered initial workspace baseline persisted.",
					worktreeFingerprint: fingerprint,
				}));
			}
			this.bindReviewRecovery(ctx);
			const recovering = this.state.read();
			if (recovering?.review.admission.status === "starting" && !this.reviewAdmissionInFlight) {
				this.state.append(this.pi, this.state.statusEvent(
					"blocked",
					"review admission outcome is ambiguous",
					"A reserved reviewer may have started before the controller stopped; explicit user recovery is required.",
				));
				this.updateStatus();
				return;
			}
			const reviewSettled = await this.reconcileReview();
			if (reviewSettled) {
				if (this.state.read()?.review.admission.status === "awaiting_adjudication") await this.maybeContinue(ctx);
				return;
			}
			const shouldAdmitReview = this.reviewAdmissionRetry || this.state.read()?.review.admission.status === "due";
			this.reviewAdmissionRetry = false;
			if (shouldAdmitReview && await this.admitDueReview(ctx)) return;
			await this.maybeContinue(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx?.ui.notify?.(`Mission recovery deferred: ${message}`, "warning");
			this.scheduleRecovery(ctx, 5_000);
		}
	}

	private bindReviewRecovery(ctx: ExtensionContext): void {
		this.unsubscribeReview?.();
		this.unsubscribeReview = undefined;
		try {
			this.unsubscribeReview = getSubagentService().executor.onChange((run) => {
				const admission = this.state.read()?.review.admission;
				const terminal = !isActiveRuntimeStatus(run.runtime.status);
				const boundRun = admission?.status === "running" && admission.runId === run.spec.id;
				if (terminal && (boundRun || admission?.status === "due")) this.scheduleRecovery(ctx);
			});
		} catch {
			// Subagents may not be registered yet; the next lifecycle recovery retries binding.
		}
	}

	private async onSettled(ctx: ExtensionContext): Promise<void> {
		const mission = this.state.read();
		if (!mission || mission.status !== "active") return;
		const after = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (worktreeChangedDuringTurn(this.worktreeBeforeTurn, after)) {
			this.materialMutationSinceSettle = true;
			this.markReviewDue("worktree changed during turn");
		}
		this.worktreeBeforeTurn = undefined;
		if (this.settleInterruption()) return;

		const recentProgress = this.state.readProgressSinceContinuation();
		const latestProgress = recentProgress.at(-1);
		const objectiveVersion = mission.objectiveVersion ?? 1;
		const madeProgress = this.materialMutationSinceSettle
			|| recentProgress.some((progress) => hasSuccessfulValidation(progress, objectiveVersion));
		const blockerFingerprint = latestProgress?.blocked ? latestProgress.blockerId : undefined;
		this.state.append(this.pi, this.state.settledEvent({ blockerFingerprint, madeProgress }));
		this.materialMutationSinceSettle = false;
		const settled = this.state.read();
		if (!settled) {
			throw new Error("Mission state vanished during settle; the settled event was persisted without readable canonical state.");
		}
		if ((settled.blockerCount ?? 0) >= 3) {
			this.state.append(this.pi, this.state.statusEvent(
				"blocked",
				`same blocker recurred ${settled.blockerCount} autonomous turns`,
				latestProgress?.summary.slice(0, 500),
			));
			this.updateStatus();
			return;
		}
		if (this.settleBudgetLimit(ctx)) return;

		const chain = chainCheckpoints.current?.read();
		if (chain?.status === "due" && chain.dueCodes.includes("material_change")) {
			this.markReviewDue(chain.dueReasons.at(-1) ?? "material mutation");
		}
		if (await this.reconcileReview()) {
			if (this.state.read()?.review.admission.status === "awaiting_adjudication") await this.maybeContinue(ctx);
			return;
		}
		if (await this.admitDueReview(ctx)) return;
		await this.maybeContinue(ctx);
	}

	/** Records an explicit interruption or terminal provider error; true when Mission autonomy must stop here. */
	private settleInterruption(): boolean {
		const messages = this.lastAgentMessages;
		const interrupted = wasAborted(messages);
		const interruptedBySteer = interrupted && this.lastAbortWasSteered;
		const terminalError = messages.some((message) => message.role === "assistant" && message.stopReason === "error");
		this.lastAgentMessages = [];
		this.lastAbortWasSteered = false;
		if (interrupted && !interruptedBySteer) {
			this.state.append(this.pi, this.state.statusEvent("paused", "explicit interruption paused Mission autonomy"));
			this.updateStatus();
			return true;
		}
		if (terminalError) {
			this.state.append(this.pi, this.state.statusEvent("terminal_error", "provider/runtime error remained after Pi retry settlement"));
			this.updateStatus();
			return true;
		}
		return false;
	}

	/** True when a budget/usage limit stopped the Mission; requests one bounded wrap-up turn when Pi is idle. */
	private settleBudgetLimit(ctx: ExtensionContext): boolean {
		const limit = this.state.budgetExceeded();
		if (!limit) return false;
		const status = limit === "token" || limit === "cost" ? "budget_limited" : "usage_limited";
		const limited = this.state.append(this.pi, this.state.statusEvent(status, `${limit} limit exhausted`));
		this.updateStatus();
		if (limited && ctx.isIdle() && !ctx.hasPendingMessages()) {
			this.pi.sendMessage({
				customType: "mission",
				content: `Mission ${limit} limit reached. ${LIMIT_WRAPUP_GUIDANCE}`,
				display: false,
				details: { version: 2, kind: "limit_wrapup", missionId: limited.missionId, limit },
			}, { triggerTurn: true, deliverAs: "followUp" });
		}
		return true;
	}

	private async reconcileWorkspaceFingerprint(ctx: ExtensionContext): Promise<string | undefined> {
		const mission = this.state.read();
		if (!mission || mission.status !== "active") return undefined;
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) return undefined;
		const candidateId = reviewCandidateId(mission, fingerprint);
		const latchedCandidateId = mission.review.completionLatch.candidateId;
		if (latchedCandidateId && latchedCandidateId !== candidateId) this.state.append(this.pi, this.state.completionLatchClearedEvent());
		const admitted = isCandidateBoundReview(mission.review.admission.status)
			? mission.review.candidate.worktreeFingerprint
			: mission.review.candidate.admittedWorktreeFingerprint;
		if (admitted && admitted !== fingerprint) {
			if (mission.review.admission.status === "awaiting_adjudication") {
				this.supersedeReview("workspace changed after independent review settled", candidateId, fingerprint);
			} else this.markReviewDue("workspace changed since the last admitted fingerprint");
			return fingerprint;
		}
		const admittedFingerprint = mission.review.candidate.admittedWorktreeFingerprint;
		const recordsFingerprint = admittedFingerprint !== fingerprint
			&& (!admittedFingerprint || mission.review.admission.status === "clear");
		if (recordsFingerprint) this.state.append(this.pi, this.state.workspaceFingerprintEvent(fingerprint));
		return fingerprint;
	}

	private markReviewDue(reason: string): void {
		const mission = this.state.read();
		if (!mission || mission.status !== "active") return;
		if (reviewHoldsWorktree(mission.review.admission.status)) return;
		this.state.append(this.pi, this.state.reviewEvent("due", { reason }));
		if (this.ctx) this.scheduleRecovery(this.ctx);
		this.updateStatus();
	}

	private async admitDueReview(ctx: ExtensionContext): Promise<boolean> {
		const mission = this.state.read();
		if (!mission || !reviewIsDue(mission)) return false;
		if (await this.priorReviewerStillRunning(ctx, mission)) return true;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
		const fingerprint = await worktreeFingerprint(this.pi, ctx.cwd, mission);
		if (!fingerprint) {
			this.failReview(mission, "could not fingerprint candidate before review admission");
			return true;
		}
		const dueCandidateId = reviewCandidateId(mission, fingerprint);
		if (mission.review.candidate.id && mission.review.candidate.id !== dueCandidateId) {
			this.restartReviewQuietWindow(ctx, mission, dueCandidateId, fingerprint);
			return true;
		}
		if (!mission.review.admission.notBeforeAt) {
			this.state.append(this.pi, this.state.reviewEvent("due", {
				reason: mission.review.admission.reason,
				notBeforeAt: Date.now() + REVIEW_QUIET_WINDOW_MS,
				candidateId: dueCandidateId,
				admissionId: mission.review.admission.admissionId,
				worktreeFingerprint: fingerprint,
			}));
			this.scheduleRecovery(ctx, REVIEW_QUIET_WINDOW_MS);
			return true;
		}
		if (Date.now() < mission.review.admission.notBeforeAt) {
			this.scheduleRecovery(ctx, mission.review.admission.notBeforeAt - Date.now());
			return true;
		}
		if (!this.reviewerCapacityReady(ctx, mission)) return true;
		await this.startReview(ctx, mission);
		return true;
	}

	private async priorReviewerStillRunning(ctx: ExtensionContext, mission: MissionCurrent): Promise<boolean> {
		const runId = mission.review.admission.runId;
		const admissionId = mission.review.admission.admissionId;
		if (!runId || !admissionId) return false;
		const service = getSubagentService();
		let priorRun: DelegateRun | undefined;
		try { priorRun = service.executor.get(runId); }
		catch { priorRun = await service.executor.restoreAdmission(ctx.cwd, admissionId); }
		if (!priorRun || !isActiveRuntimeStatus(priorRun.runtime.status)) return false;
		this.scheduleRecovery(ctx, 1_000);
		return true;
	}

	private restartReviewQuietWindow(ctx: ExtensionContext, mission: MissionCurrent, candidateId: string, fingerprint: string): void {
		const admission = mission.review.admission;
		if (admission.outcome === "superseded" && admission.runId && admission.admissionId) {
			this.state.append(this.pi, this.state.reviewEvent("due", {
				reason: "prior candidate reviewer settled; replacement quiet window started",
				candidateId,
				worktreeFingerprint: fingerprint,
				notBeforeAt: Date.now() + REVIEW_QUIET_WINDOW_MS,
			}));
			this.scheduleRecovery(ctx);
		} else this.supersedeReview("candidate changed during the review quiet window", candidateId, fingerprint);
	}

	private reviewerCapacityReady(ctx: ExtensionContext, mission: MissionCurrent): boolean {
		try {
			const service = getSubagentService();
			if (service.restorationComplete?.() === false) {
				this.scheduleRecovery(ctx, 100);
				return false;
			}
			const active = this.activeSubagentWork();
			const admissionId = mission.review.admission.admissionId;
			const recoveredRun = admissionId && active.runs.length === 1 && active.runs[0]?.spec.admissionKey === admissionId;
			if (active.runs.length && !recoveredRun) return false;
			return !active.groupIds.length && !active.launchReservations && !this.activeJobs().length;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.failReview(mission, `could not verify reviewer admission capacity: ${message}`);
			return false;
		}
	}

	private async startReview(ctx: ExtensionContext, mission: MissionCurrent): Promise<void> {
		this.state.loadFromSession(ctx);
		if (!this.state.readOwner()) throw new Error("Mission review admission requires a canonical persisted session owner.");
		const admitted = this.state.read() ?? mission;
		const service = this.reviewAdmissionService(ctx, admitted);
		if (!service) return;
		if (!this.reviewAdmissionCapacityFree(ctx, service, admitted)) return;
		const workspace = await resolveMissionWorkspace(this.pi, ctx.cwd, admitted.paths);
		const fingerprint = workspace
			? await workspaceFingerprint(this.pi, ctx.cwd, workspace, missionIgnoredPaths(ctx.cwd))
			: undefined;
		if (!workspace || !fingerprint) {
			this.failReview(admitted, WORKSPACE_RESOLUTION_FAILURE);
			return;
		}
		const candidate = this.admitReviewCandidate(admitted, fingerprint);
		if (!candidate) return;
		const [soleWorkspace] = workspace;
		const reviewCwd = workspace.length === 1 && soleWorkspace ? soleWorkspace.root : ctx.cwd;
		const scope = await this.resolveReviewScope(ctx, candidate.current, workspace, reviewCwd);
		if (!scope) return;
		await this.launchReviewer(ctx, service, candidate, fingerprint, reviewCwd, scope);
	}

	private reviewAdmissionService(ctx: ExtensionContext, mission: MissionCurrent): SubagentService | undefined {
		try {
			return getSubagentService();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.failReviewAdmission(ctx, mission, `review admission failed: ${message}`);
			return undefined;
		}
	}

	private failReviewAdmission(ctx: ExtensionContext, mission: MissionCurrent, reason: string): void {
		this.failReview(mission, reason);
		this.reviewAdmissionRetry = this.state.read()?.review.admission.status === "due";
		this.scheduleRecovery(ctx, 1_000);
	}

	private reviewAdmissionCapacityFree(ctx: ExtensionContext, service: SubagentService, mission: MissionCurrent): boolean {
		try {
			if (service.restorationComplete?.() === false) {
				this.scheduleRecovery(ctx, 1_000);
				return false;
			}
			const listed = service.list();
			const activeRuns = listed.runs.filter((run) => isActiveRuntimeStatus(run.runtime.status));
			const admissionId = mission.review.admission.admissionId;
			const recoveredRun = admissionId && activeRuns.length === 1 && activeRuns[0]?.spec.admissionKey === admissionId;
			if (activeRuns.length && !recoveredRun) return false;
			if (listed.groups.some((group) => group.status === "running")) return false;
			if (service.activeLaunchReservations?.()) return false;
			if (this.activeJobs().length) return false;
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.failReviewAdmission(ctx, mission, `review admission failed: ${message}`);
			return false;
		}
	}

	private admitReviewCandidate(mission: MissionCurrent, fingerprint: string): AdmittedReviewCandidate | undefined {
		let current = this.state.read();
		if (!current || current.review.admission.status !== "due") return undefined;
		if (current.objectiveVersion !== mission.objectiveVersion) return undefined;
		const candidateId = reviewCandidateId(current, fingerprint);
		const candidate = current.review.candidate;
		const candidateChanged = (candidate.id && candidate.id !== candidateId)
			|| (candidate.worktreeFingerprint && candidate.worktreeFingerprint !== fingerprint);
		if (candidateChanged) {
			this.supersedeReview("candidate changed during final review admission", candidateId, fingerprint);
			return undefined;
		}
		const latchedCandidateId = current.review.completionLatch.candidateId;
		if (latchedCandidateId && latchedCandidateId !== candidateId) {
			this.state.append(this.pi, this.state.completionLatchClearedEvent());
			const cleared = this.state.read();
			if (!cleared) return undefined;
			current = cleared;
		}
		if (this.replayAdmittedCandidate(current, candidateId, fingerprint)) return undefined;
		if (this.adjudicationHistoryBlocksReview(current)) return undefined;
		return { current, candidateId };
	}

	/** Suppresses a duplicate reviewer launch for a candidate this Mission already adjudicated or authorized. */
	private replayAdmittedCandidate(current: MissionCurrent, candidateId: string, fingerprint: string): boolean {
		const adjudication = current.review.adjudication;
		const adjudicated = adjudication.adjudicatedCandidateId === candidateId && adjudication.adjudicatedVerdict
			? { candidateId, verdict: adjudication.adjudicatedVerdict }
			: undefined;
		const prior = adjudication.history.find((item) => item.candidateId === candidateId) ?? adjudicated;
		if (prior) {
			this.state.append(this.pi, this.state.reviewEvent(prior.verdict, {
				runId: current.review.admission.runId,
				reason: "Duplicate review admission suppressed for the unchanged adjudicated candidate.",
				worktreeFingerprint: fingerprint,
				candidateId,
				replayAdjudication: true,
			}));
			this.updateStatus();
			return true;
		}
		const latch = current.review.completionLatch;
		const authorized = latch.reviewStatus === "skipped" || latch.reviewStatus === "not_required";
		if (latch.candidateId === candidateId && authorized && latch.reviewStatus) {
			this.state.append(this.pi, this.state.reviewEvent(latch.reviewStatus, {
				reason: "Duplicate review admission suppressed for the unchanged user-authorized completion candidate.",
				worktreeFingerprint: fingerprint,
				candidateId,
			}));
			this.updateStatus();
			return true;
		}
		return false;
	}

	private adjudicationHistoryBlocksReview(current: MissionCurrent): boolean {
		const adjudication = current.review.adjudication;
		if (adjudication.historyComplete !== true) {
			this.state.append(this.pi, this.state.statusEvent(
				"blocked",
				"review adjudication history completeness is unknown",
				"A new reviewer was not launched because legacy state cannot prove that this candidate was never reviewed.",
			));
			this.updateStatus();
			return true;
		}
		if (adjudication.history.length >= MAX_MISSION_REVIEW_ADJUDICATIONS) {
			this.state.append(this.pi, this.state.statusEvent(
				"blocked",
				"review adjudication history capacity reached",
				"A new reviewer was not launched because doing so could require forgetting an already reviewed candidate.",
			));
			this.updateStatus();
			return true;
		}
		return false;
	}

	private async resolveReviewScope(
		ctx: ExtensionContext,
		current: MissionCurrent,
		workspace: MissionWorkspaceRoot[],
		reviewCwd: string,
	): Promise<ReviewAdmissionScope | undefined> {
		const ignoredPaths = missionIgnoredPaths(ctx.cwd);
		const correctionReview = isCorrectionReview(current);
		const correction = correctionReview
			? await correctionReviewScope(this.pi, ctx.cwd, reviewCwd, workspace, ignoredPaths, current.review.correction.acceptedRevisions)
			: undefined;
		const initialRevisions = correctionReview
			? undefined
			: await reviewedWorkspaceRevisions(this.pi, ctx.cwd, reviewCwd, workspace, ignoredPaths);
		const scopeMissing = correctionReview ? !correction : !initialRevisions;
		if (scopeMissing) {
			this.state.append(this.pi, this.state.statusEvent(
				"blocked",
				"independent review requires one exact clean candidate commit",
				"Commit the bounded candidate before review so Runtime can persist and enforce exact reviewed heads and correction topology.",
			));
			this.updateStatus();
			return undefined;
		}
		return { paths: reviewPaths(reviewCwd, workspace), correctionReview, correction, initialRevisions };
	}

	private async launchReviewer(
		ctx: ExtensionContext,
		service: SubagentService,
		candidate: AdmittedReviewCandidate,
		fingerprint: string,
		reviewCwd: string,
		scope: ReviewAdmissionScope,
	): Promise<void> {
		const current = candidate.current;
		const admission = current.review.admission;
		const reserved = current.review.candidate.id === candidate.candidateId
			&& current.review.candidate.worktreeFingerprint === fingerprint;
		if (admission.admissionId && !reserved) {
			if (service.restorationComplete?.() === false) {
				this.scheduleRecovery(ctx, 1_000);
				return;
			}
			const prior = service.list().runs.find((run) => run.spec.admissionKey === admission.admissionId);
			if (prior && isActiveRuntimeStatus(prior.runtime.status)) return;
		}
		const admissionId = reserved && admission.admissionId ? admission.admissionId : `review_${randomUUID()}`;
		this.state.append(this.pi, this.state.reviewEvent("starting", {
			reason: admission.reason,
			worktreeFingerprint: fingerprint,
			candidateId: candidate.candidateId,
			admissionId,
			scopePaths: scope.correction?.paths ?? scope.paths,
			scopeRevisions: scope.correction?.revisions ?? scope.initialRevisions,
		}));
		this.reviewAdmissionInFlight = true;
		const task = reviewerTask(current, scope, this.state.readProgress().at(-1)?.summary);
		const run = await this.startReviewerRun(ctx, service, candidate, admissionId, reviewCwd, task);
		if (!run) return;
		if ("children" in run) {
			this.ctx?.ui.notify?.("Mission reviewer unexpectedly launched a group; the durable admission remains reserved.", "warning");
			this.scheduleRecovery(ctx);
			return;
		}
		const latest = this.state.read();
		const sameCandidate = latest?.review.admission.status === "starting"
			&& latest.review.candidate.id === candidate.candidateId
			&& latest.objectiveVersion === current.objectiveVersion;
		if (!sameCandidate) {
			this.scheduleRecovery(ctx);
			return;
		}
		this.bindReviewerRun(ctx, service, run, candidate, fingerprint, admissionId);
	}

	private async startReviewerRun(
		ctx: ExtensionContext,
		service: SubagentService,
		candidate: AdmittedReviewCandidate,
		admissionId: string,
		reviewCwd: string,
		task: string,
	) {
		try {
			return await service.start({
				agent: "reviewer",
				task,
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
			const sameAttempt = latest?.review.admission.status === "starting"
				&& latest.review.admission.admissionId === admissionId
				&& latest.review.candidate.id === candidate.candidateId
				&& latest.objectiveVersion === candidate.current.objectiveVersion
				&& latest.generation === candidate.current.generation;
			const message = error instanceof Error ? error.message : String(error);
			if (!sameAttempt) this.scheduleRecovery(ctx);
			else if (error instanceof SubagentAdmissionReservedError) {
				this.ctx?.ui.notify?.(`Mission reviewer launch outcome is ambiguous: ${error.message}`, "warning");
				this.scheduleRecovery(ctx);
			} else this.failReview(latest, `independent reviewer launch failed: ${message}`);
			return undefined;
		} finally {
			this.reviewAdmissionInFlight = false;
		}
	}

	private bindReviewerRun(
		ctx: ExtensionContext,
		service: SubagentService,
		run: DelegateRun,
		candidate: AdmittedReviewCandidate,
		fingerprint: string,
		admissionId: string,
	): void {
		try {
			this.state.append(this.pi, this.state.reviewEvent("running", {
				runId: run.spec.id,
				reason: candidate.current.review.admission.reason,
				worktreeFingerprint: fingerprint,
				candidateId: candidate.candidateId,
				admissionId,
			}));
			this.updateStatus();
			let boundRun = run;
			try {
				const latest = service.executor.get?.(run.spec.id);
				if (latest?.spec.id === run.spec.id) boundRun = latest;
			} catch { /* The returned launch record remains authoritative for immediate settlement. */ }
			if (!isActiveRuntimeStatus(boundRun.runtime.status)) this.scheduleRecovery(ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx?.ui.notify?.(`Mission reviewer started but binding its run failed: ${message}`, "warning");
			this.scheduleRecovery(ctx);
		}
	}

	private async reconcileReview(): Promise<boolean> {
		const mission = this.state.read();
		// Only an active Mission may transition review state; reviewEvent()/failReview() call requireActive()
		// and would throw on a paused/blocked Mission whose reviewer settled after the pause.
		if (!mission) return false;
		const reviewRunId = recoverableReviewRunId(mission);
		if (!reviewRunId) return false;
		const service = getSubagentService();
		if (service.restorationComplete?.() === false) {
			if (this.ctx) this.scheduleRecovery(this.ctx, 1_000);
			return false;
		}
		const preflightFingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd, mission) : undefined;
		const preflight = this.state.read();
		if (!isSameReviewCandidate(mission, preflight)) return true;
		if (!preflightFingerprint) {
			this.failReview(preflight, "could not fingerprint reviewed worktree before run recovery");
			return true;
		}
		const preflightCandidateId = reviewCandidateId(preflight, preflightFingerprint);
		if (preflightFingerprint !== preflight.review.candidate.worktreeFingerprint || preflightCandidateId !== preflight.review.candidate.id) {
			return this.recoverFromStalePreflight(preflight, service, preflightCandidateId, preflightFingerprint);
		}
		let run: DelegateRun;
		try {
			run = service.executor.get(reviewRunId);
		} catch (error) {
			if (service.restorationComplete?.() === false) {
				if (this.ctx) this.scheduleRecovery(this.ctx, 1_000);
				return false;
			}
			this.failReview(mission, `independent review run lost: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		if (isActiveRuntimeStatus(run.runtime.status)) return false;
		const fingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd, mission) : undefined;
		const latest = this.state.read();
		if (!isSameReviewCandidate(mission, latest)) return true;
		if (!fingerprint) {
			this.failReview(latest, "could not fingerprint reviewed worktree");
			return true;
		}
		const candidateId = reviewCandidateId(latest, fingerprint);
		if (reviewCandidateDrifted(latest, fingerprint, candidateId)) {
			this.supersedeReview("objective, scope, or worktree changed while independent review was running", candidateId, fingerprint);
			return true;
		}
		if (run.runtime.status !== "completed") {
			this.failReview(latest, run.runtime.error || "independent review failed");
			return true;
		}
		return this.reconcileReviewReport(mission, run, fingerprint);
	}

	private async recoverFromStalePreflight(
		preflight: MissionCurrent,
		service: SubagentService,
		preflightCandidateId: string,
		preflightFingerprint: string,
	): Promise<boolean> {
		let priorRun: DelegateRun | undefined;
		const runId = preflight.review.admission.runId;
		try { priorRun = runId ? service.executor.get(runId) : undefined; }
		catch {
			const admissionId = preflight.review.admission.admissionId;
			if (admissionId && this.ctx) priorRun = await service.executor.restoreAdmission(this.ctx.cwd, admissionId);
		}
		if (priorRun && isActiveRuntimeStatus(priorRun.runtime.status)) {
			if (this.ctx) this.scheduleRecovery(this.ctx, 1_000);
			return false;
		}
		this.supersedeReview("candidate changed after the prior reviewer settled", preflightCandidateId, preflightFingerprint);
		return true;
	}

	private async reconcileReviewReport(mission: MissionCurrent, run: DelegateRun, fingerprint: string): Promise<boolean> {
		const scopePaths = mission.review.candidate.scopePaths;
		if (!scopePaths?.length) {
			this.state.append(this.pi, this.state.reviewEvent("due", { reason: "independent review scope evidence is missing; relaunch required" }));
			if (this.ctx) this.scheduleRecovery(this.ctx);
			this.updateStatus();
			return true;
		}
		const scopeKind: ReviewScopeKind = isCorrectionReview(mission) ? "exact_paths" : "owned_prefixes";
		const report = await readReviewReport(run, mission.requirements.length, scopePaths, mission.review.findings.accepted, scopeKind);
		const finalFingerprint = this.ctx ? await worktreeFingerprint(this.pi, this.ctx.cwd, mission) : undefined;
		const latest = this.state.read();
		if (!isSameReviewCandidate(mission, latest)) return true;
		if (!finalFingerprint) {
			this.failReview(latest, "could not revalidate reviewed worktree after report read");
			return true;
		}
		if (finalFingerprint !== fingerprint) {
			const supersededId = reviewCandidateId(latest, finalFingerprint);
			this.supersedeReview("worktree changed while reading the independent review report", supersededId, finalFingerprint);
			return true;
		}
		if (!report) {
			this.failReview(latest, "independent reviewer did not submit a valid review_report artifact");
			return true;
		}
		this.state.append(this.pi, this.state.reviewEvent("awaiting_adjudication", {
			runId: run.spec.id,
			reason: "Independent review settled; parent must adjudicate the severity-derived result.",
			suggestedVerdict: report.verdict,
			worktreeFingerprint: fingerprint,
			candidateId: reviewCandidateId(latest, finalFingerprint),
			highestSeverity: report.highestSeverity,
			blockingFindingCount: report.blockingFindingCount,
			backlogFindingCount: report.backlogFindingCount,
			findings: report.findings,
			scopePaths: mission.review.candidate.scopePaths,
			scopeRevisions: mission.review.candidate.scopeRevisions,
		}));
		this.updateStatus();
		return true;
	}

	private supersedeReview(reason: string, candidateId?: string, fingerprint?: string): void {
		const shouldBlock = (this.state.read()?.review.admission.supersessionCount ?? 0) >= 2;
		this.state.append(this.pi, this.state.reviewEvent("due", {
			reason,
			outcome: "superseded",
			candidateId,
			worktreeFingerprint: fingerprint,
			notBeforeAt: Date.now() + REVIEW_QUIET_WINDOW_MS,
		}));
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

	private activeJobs(): JobRecord[] {
		const jobs = getJobManager()?.list() ?? [];
		return jobs.filter((job) => ["starting", "running", "stopping"].includes(job.runtime.status));
	}

	private activeSubagentWork(excludeId?: string): ActiveSubagentWork {
		const service = getSubagentService();
		const listed = service.list();
		return {
			runs: listed.runs.filter((run) => run.spec.id !== excludeId && isActiveRuntimeStatus(run.runtime.status)),
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
		const indicator = reviewStatusIndicator(mission.review.admission.status);
		if (indicator) {
			this.ctx.ui.setStatus("mission", theme?.fg(indicator.color, indicator.text) ?? indicator.text);
			return;
		}
		const usage = this.state.readUsage();
		if (mission.tokenBudget && usage.totalTokens / mission.tokenBudget >= 0.8) {
			const text = `mission ${compact(usage.totalTokens)}/${compact(mission.tokenBudget)}`;
			this.ctx.ui.setStatus("mission", theme?.fg("warning", text) ?? text);
			return;
		}
		this.ctx.ui.setStatus("mission", undefined);
	}
}

interface ReviewStatusIndicator {
	color: "accent" | "error" | "warning";
	text: string;
}

function reviewStatusIndicator(status: MissionReviewStatus): ReviewStatusIndicator | undefined {
	switch (status) {
		case "due":
		case "awaiting_adjudication":
			return { color: "warning", text: "review!" };
		case "starting":
		case "running":
			return { color: "accent", text: "review" };
		case "changes_requested":
			return { color: "error", text: "review!" };
		case "not_required":
		case "clear":
		case "skipped":
			return undefined;
		default: {
			const exhaustive: never = status;
			throw new Error(`Unhandled Mission review status: ${String(exhaustive)}`);
		}
	}
}

function continuationMessage(mission: MissionCurrent): string {
	const admission = mission.review.admission;
	const outcome = admission.outcome ? ` (${admission.outcome})` : "";
	const reason = admission.reason ? ` — ${admission.reason}` : "";
	return [
		`Mission continuation ${mission.generation}/${mission.objectiveVersion ?? 1}.`,
		`Objective: ${mission.objective}`,
		`Requirements: ${mission.requirements.map((item) => `• ${item}`).join(" ")}`,
		`Review: ${admission.status ?? "not_required"}${outcome}${reason}.`,
		...(admission.status === "awaiting_adjudication" ? [reviewEvidence(mission)] : []),
		CONTINUATION_GUIDANCE,
	].join("\n");
}

function reviewEvidence(mission: MissionCurrent): string {
	return [
		`Review evidence: run=${mission.review.admission.runId ?? "missing"};`,
		`derivedVerdict=${mission.review.adjudication.suggestedVerdict ?? "unknown"};`,
		`highestSeverity=${mission.review.findings.highestSeverity ?? "none"};`,
		`blocking=${mission.review.findings.blockingCount};`,
		`backlog=${mission.review.findings.backlogCount}.`,
		"Retrieve bounded report evidence with subagent_wait on the exact run ID.",
	].join(" ");
}

function missionContext(mission: MissionCurrent, usage: MissionUsage): string {
	const usageText = `${usage.totalTokens} tokens / $${usage.totalCostUsd.toFixed(4)}`;
	const state = `State: ${mission.status}; review ${mission.review.admission.status ?? "not_required"}; usage ${usageText}.`;
	return [
		`Active Mission: ${mission.title}`,
		`Objective v${mission.objectiveVersion ?? 1}: ${mission.objective}`,
		state,
		MISSION_AUTHORIZATION_NOTE,
	].join("\n");
}

function suspendedMissionContext(mission: MissionCurrent, progress: MissionProgressRecord | undefined): string {
	const resumable = ["paused", "blocked", "terminal_error"].includes(mission.status);
	return [
		`Mission control state: ${mission.status.toUpperCase()} — ${mission.title}`,
		`Reason: ${mission.lastReason ?? "not recorded"}${mission.lastSummary ? ` · ${mission.lastSummary}` : ""}`,
		`Resume target: ${mission.chain}@${mission.chainBranch}; artifacts .missions/${mission.slug}.`,
		...(progress?.remaining.length ? [`Recorded next work: ${progress.remaining.join(" | ")}`] : []),
		resumable ? RESUMABLE_MISSION_GUIDANCE : LIMITED_MISSION_GUIDANCE,
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
	return details.missionId !== mission.missionId
		|| details.generation !== mission.generation
		|| details.objectiveVersion !== mission.objectiveVersion;
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
	return mission.review.correction.count > 0 || mission.review.adjudication.history.length > 0;
}

interface ReviewFindingContext {
	requirementCount: number;
	scopePaths: string[];
	scopeKind: ReviewScopeKind;
	acceptedFindings: MissionReviewFinding[] | undefined;
	acceptedRequirements: Set<number>;
}

interface ValidatedReviewReport {
	findings: Array<PersistedReviewFinding | null>;
}

async function readReviewReport(
	run: DelegateRun,
	requirementCount: number,
	scopePaths: string[],
	acceptedFindings: MissionReviewFinding[] | undefined,
	scopeKind: ReviewScopeKind,
): Promise<DerivedReviewReport | undefined> {
	const report = await readPersistedReviewReport(run);
	if (!report) return undefined;
	const acceptedRequirements = new Set(
		(acceptedFindings ?? []).flatMap((finding) => finding.requirementIndex === undefined ? [] : [finding.requirementIndex]),
	);
	const context: ReviewFindingContext = { requirementCount, scopePaths, scopeKind, acceptedFindings, acceptedRequirements };
	const findings: MissionReviewFinding[] = [];
	for (const [index, finding] of report.findings.entries()) {
		const parsed = parseReviewFinding(finding, index, context);
		if (!parsed) return undefined;
		findings.push(parsed);
	}
	if (scopeKind === "exact_paths") {
		for (const finding of acceptedFindings ?? []) {
			const blocking = finding.severity === "blocker" || finding.severity === "major";
			if (!blocking || (finding.path !== undefined && scopePaths.includes(finding.path))) continue;
			findings.push({ ...finding, index: findings.length });
		}
	}
	return deriveReviewReport(findings);
}

async function readPersistedReviewReport(run: DelegateRun): Promise<ValidatedReviewReport | undefined> {
	try {
		const source = await readFile(join(run.spec.artifactsDir, "review-report.json"), "utf8");
		// SAFETY: The persisted report remains untrusted; every consumed field is validated before domain construction.
		const report = JSON.parse(source) as PersistedReviewReport | null;
		if (!report || report.constructor !== Object || report.version !== 1) return undefined;
		if (report.verdict !== "clear" && report.verdict !== "changes_requested") return undefined;
		if (!isPersistedString(report.overallExplanation)) return undefined;
		if (!Array.isArray(report.findings) || report.findings.length > 1_000) return undefined;
		return { findings: report.findings };
	} catch {
		return undefined;
	}
}

function parseReviewFinding(
	finding: PersistedReviewFinding | null,
	index: number,
	context: ReviewFindingContext,
): MissionReviewFinding | undefined {
	if (!finding || finding.constructor !== Object || !isPersistedString(finding.summary)) return undefined;
	if (finding.path !== undefined && !isPersistedString(finding.path)) return undefined;
	const criticalImpact = finding.criticalImpact === "security" || finding.criticalImpact === "data_loss"
		? finding.criticalImpact
		: undefined;
	if (finding.criticalImpact !== undefined && criticalImpact === undefined) return undefined;
	const submitted = reviewSeverity(finding.severity);
	const line = optionalInteger(finding.line, 1);
	const requirementIndex = optionalInteger(finding.requirementIndex, 0);
	if (!submitted) return undefined;
	if (finding.line !== undefined && line === undefined) return undefined;
	if (finding.requirementIndex !== undefined && requirementIndex === undefined) return undefined;
	const path = isPersistedString(finding.path) ? normalizeReviewPath(finding.path) : undefined;
	if (finding.path !== undefined && !path) return undefined;
	const blocking = submitted === "blocker" || submitted === "major";
	const requirementLinked = requirementIndex !== undefined && requirementIndex < context.requirementCount;
	const demote = (!requirementLinked && !criticalImpact)
		|| !isAcceptedFinding(requirementIndex, criticalImpact, context)
		|| !isFindingWithinScope(path, context);
	const parsed: MissionReviewFinding = {
		index,
		severity: blocking && demote ? "minor" : submitted,
		summary: finding.summary.slice(0, 4_000),
	};
	if (path) parsed.path = path;
	if (line !== undefined) parsed.line = line;
	if (requirementIndex !== undefined) parsed.requirementIndex = requirementIndex;
	if (criticalImpact) parsed.criticalImpact = criticalImpact;
	return parsed;
}

function isAcceptedFinding(
	requirementIndex: number | undefined,
	criticalImpact: MissionReviewCriticalImpact | undefined,
	context: ReviewFindingContext,
): boolean {
	if (context.acceptedFindings === undefined || context.acceptedFindings.length === 0) return true;
	if (requirementIndex !== undefined && context.acceptedRequirements.has(requirementIndex)) return true;
	return criticalImpact !== undefined;
}

function isFindingWithinScope(path: string | undefined, context: ReviewFindingContext): boolean {
	if (path === undefined) return false;
	return context.scopePaths.some((scopePath) => context.scopeKind === "exact_paths"
		? path === scopePath
		: scopePath === "." || path === scopePath || path.startsWith(`${scopePath}/`));
}

function deriveReviewReport(findings: MissionReviewFinding[]): DerivedReviewReport {
	const severities = findings.map((finding) => finding.severity);
	const blockingFindingCount = severities.filter((severity) => severity === "blocker" || severity === "major").length;
	return {
		verdict: blockingFindingCount > 0 ? "changes_requested" : "clear",
		highestSeverity: REVIEW_SEVERITIES.find((severity) => severities.includes(severity)),
		blockingFindingCount,
		backlogFindingCount: severities.length - blockingFindingCount,
		findings,
	};
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
	const safe = Boolean(normalized)
		&& !normalized.startsWith("/")
		&& !normalized.includes("\\")
		&& !normalized.split("/").includes("..");
	return safe ? normalized : undefined;
}

function reviewCandidateId(mission: MissionCurrent, fingerprint: string): string {
	const input = JSON.stringify({
		version: 1,
		objectiveVersion: mission.objectiveVersion ?? 1,
		paths: [...mission.paths].sort(),
		fingerprint,
	});
	return `candidate_${createHash("sha256").update(input).digest("hex")}`;
}

/**
 * True when `other` is still the exact review attempt reconcileReview() started from:
 * same run, candidate, objective, and generation as `mission`.
 */
function isSameReviewCandidate(mission: MissionCurrent, other: MissionCurrent | undefined): other is MissionCurrent {
	return other?.status === "active"
		&& other.review.admission.status === "running"
		&& other.review.admission.runId === mission.review.admission.runId
		&& other.review.candidate.id === mission.review.candidate.id
		&& other.review.candidate.worktreeFingerprint === mission.review.candidate.worktreeFingerprint
		&& other.objectiveVersion === mission.objectiveVersion
		&& other.generation === mission.generation;
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

async function reviewedWorkspaceRevisions(
	pi: ExtensionAPI,
	cwd: string,
	reviewCwd: string,
	workspace: MissionWorkspaceRoot[],
	ignoredPaths: string[],
): Promise<MissionReviewRevision[] | undefined> {
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
		if (status.code !== 0 || status.stdout) return undefined;
		if (head.code !== 0 || !revisionRoot) return undefined;
		if (!isCommitSha(headCommit)) return undefined;
		revisions.push({ root: revisionRoot, base: headCommit, head: headCommit });
	}
	return revisions;
}

interface MissionCorrectionScope {
	paths: string[];
	revisions: MissionReviewRevision[];
}

function hasExpectedRevisionRoots(revisions: MissionReviewRevision[], expectedCount: number): boolean {
	const roots = new Set(revisions.map((revision) => revision.root));
	return revisions.length === expectedCount && roots.size === revisions.length;
}

async function correctionReviewScope(
	pi: ExtensionAPI,
	cwd: string,
	reviewCwd: string,
	workspace: MissionWorkspaceRoot[],
	ignoredPaths: string[],
	acceptedRevisions: MissionReviewRevision[] | undefined,
): Promise<MissionCorrectionScope | undefined> {
	const current = await reviewedWorkspaceRevisions(pi, cwd, reviewCwd, workspace, ignoredPaths);
	if (!current) return undefined;
	if (acceptedRevisions && !hasExpectedRevisionRoots(acceptedRevisions, current.length)) return undefined;
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
			if (legacyBase.code !== 0 || !isCommitSha(baseCommit)) return undefined;
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

// Exclude all Mission and Chain durable state: their snapshot/link writes mutate the tree every turn and
// would otherwise churn the fingerprint into a permanent review-due loop. Admission and completion must
// use the identical list or their fingerprints can never match.
function missionIgnoredPaths(cwd: string): string[] {
	return [missionRoot(cwd), join(cwd, ".chains")];
}

async function worktreeFingerprint(pi: ExtensionAPI, cwd: string, mission: MissionCurrent | undefined): Promise<string | undefined> {
	if (!mission) return undefined;
	const workspace = await resolveMissionWorkspace(pi, cwd, mission.paths);
	return workspace ? workspaceFingerprint(pi, cwd, workspace, missionIgnoredPaths(cwd)) : undefined;
}

async function workspaceFingerprint(
	pi: ExtensionAPI,
	cwd: string,
	workspace: MissionWorkspaceRoot[],
	ignoredPaths: string[],
): Promise<string | undefined> {
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
			// No positive sentinel for the pathless case: `:(top,literal).` matches nothing. An exclusion-only
			// pathspec means "everything except", and an empty pathspec means the whole repo.
			const gitPathspecs = [...literalScopes, ...exclusions];
			const pathspec = gitPathspecs.length ? ["--", ...gitPathspecs] : [];
			const [staged, flags, untracked] = await Promise.all([
				pi.exec("git", ["ls-files", "--cached", "--stage", "-z", ...pathspec], { cwd: root }),
				pi.exec("git", ["ls-files", "--cached", "-v", "-z", ...pathspec], { cwd: root }),
				pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], { cwd: root }),
			]);
			const listedBytes = staged.stdout.length + flags.stdout.length + untracked.stdout.length;
			if (
				staged.code !== 0
				|| flags.code !== 0
				|| untracked.code !== 0
				|| listedBytes > MAX_FINGERPRINT_PATH_BYTES
			) return undefined;
			const tracked = new Map<string, string>();
			for (const record of staged.stdout.split("\0").filter(Boolean)) {
				const match = /^(\d{6}) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(record);
				if (!match || match[2] !== "0" || tracked.has(match[3])) return undefined;
				tracked.set(match[3], match[1]);
			}
			const trackedFlags = new Map<string, string>();
			for (const record of flags.stdout.split("\0").filter(Boolean)) {
				if (record.length < 3 || record[1] !== " ") return undefined;
				trackedFlags.set(record.slice(2), record[0]);
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

async function hashWorkspacePath(
	hash: Hash,
	root: string,
	path: string,
	indexMode: string | undefined,
	totalBytes: number,
): Promise<number | undefined> {
	const target = resolve(root, path);
	const relativeTarget = relative(root, target).replaceAll("\\", "/");
	if (relativeTarget !== path) return undefined;
	if (escapesRoot(relativeTarget)) return undefined;
	const info = await lstat(target).catch(() => undefined);
	// An ordinary indexed path absent from the worktree is a deletion and contributes no final-tree
	// entry. Sparse and hidden index entries were rejected by the caller.
	if (!info) return indexMode ? 0 : undefined;
	hash.update(path).update("\0");
	if (info.isSymbolicLink()) {
		const link = await readlink(target).catch(() => undefined);
		if (link === undefined) return undefined;
		hash.update("120000\0").update(link).update("\0");
		return 0;
	}
	// Submodule worktrees require a separate recursive ownership model; fail closed rather than
	// fingerprinting only the gitlink while nested contents may be dirty.
	if (indexMode === "160000" || info.isDirectory()) return undefined;
	if (!isFingerprintableFile(info, totalBytes)) return undefined;
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
	if (!handle) return undefined;
	try {
		const opened = await handle.stat();
		if (!isFingerprintableFile(opened, totalBytes)) return undefined;
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
