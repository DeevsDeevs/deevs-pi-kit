import { randomUUID } from "node:crypto";
import { isAbsolute, normalize as normalizePath } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChainService } from "../chains/service.ts";
import { slugify } from "../chains/parser.ts";
import { missionDir } from "./artifacts.ts";
import { currentMissionOwner, listMissionSnapshots, readMissionSnapshot, withMissionLock, withMissionWorkspaceLock, writeMissionSnapshot } from "./persistence.ts";
import { MAX_MISSION_REVIEW_ADJUDICATIONS } from "./types.ts";
import type { MissionCreateInput, MissionCurrent, MissionEvent, MissionOwner, MissionProgressInput, MissionProgressRecord, MissionConvergedReviewStatus, MissionReviewFinding, MissionReviewOutcome, MissionReviewRevision, MissionReviewSeverity, MissionReviewStatus, MissionReviewVerdict, MissionSnapshot, MissionStatus, MissionTakeoverCandidate, MissionUpdateInput, MissionUsage, MissionValidationInput, MissionValidationRecord } from "./types.ts";

export const MISSION_CUSTOM_TYPE = "deevs-mission-state";
const DEFAULT_CHAIN_BRANCH = "main";
const MAX_REQUIREMENTS = 12;
const MAX_PATHS = 100;
export const DEFAULT_REVIEW_CORRECTION_LIMIT = 3;
const STATUS_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
	active: ["paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "complete", "ended", "cleared"],
	paused: ["active", "ended", "cleared"],
	blocked: ["active", "ended", "cleared"],
	terminal_error: ["active", "ended", "cleared"],
	budget_limited: ["active", "ended", "cleared"],
	usage_limited: ["active", "ended", "cleared"],
	complete: ["cleared"],
	ended: ["active", "cleared"],
	cleared: [],
};

export class MissionState {
	private current: MissionCurrent | undefined;
	private usage: MissionUsage = zeroUsage();
	private carriedUsage: MissionUsage = zeroUsage();
	private progress: MissionProgressRecord[] = [];
	private continuationProgressIndex = 0;
	private reviewFailureCount = 0;
	private usageComplete = true;
	private creationPending = false;
	private cwd?: string;
	private owner?: MissionOwner;
	private snapshotRevision?: number;
	private ownershipConflict?: { missionId: string; ownerSessionId: string };
	private persistenceError?: string;

	read(): MissionCurrent | undefined {
		if (!this.current || this.current.status === "cleared" || this.current.status === "complete" || this.current.status === "ended") return undefined;
		return { ...this.current };
	}

	readAny(): MissionCurrent | undefined {
		if (!this.current || this.current.status === "cleared") return undefined;
		return { ...this.current };
	}

	readUsage(): MissionUsage {
		return { ...this.usage };
	}

	readProgress(): MissionProgressRecord[] {
		return cloneProgress(this.progress);
	}

	readProgressSinceContinuation(): MissionProgressRecord[] {
		return cloneProgress(this.progress.slice(this.continuationProgressIndex));
	}

	readOwner(): MissionOwner | undefined {
		return this.owner ? { ...this.owner } : undefined;
	}

	readOwnershipConflict(): { missionId: string; ownerSessionId: string } | undefined {
		return this.ownershipConflict ? { ...this.ownershipConflict } : undefined;
	}

	readPersistenceError(): string | undefined {
		return this.persistenceError;
	}

	readReviewFailureCount(): number {
		return this.reviewFailureCount;
	}

	loadFromSession(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch() as Array<any>;
		const owner = currentMissionOwner(ctx);
		this.cwd = ctx.cwd;
		this.owner = owner;
		this.ownershipConflict = undefined;
		this.persistenceError = undefined;
		this.loadBranch(branch, ctx.cwd);
		if (!owner) return;
		const anchor = latestMissionAnchor(branch);
		try {
			const snapshots = listMissionSnapshots(ctx.cwd);
			const snapshot = anchor
				? snapshots.find((candidate) => candidate.mission.missionId === anchor.missionId && candidate.mission.slug === anchor.slug)
				: onlyOwnedMission(snapshots, owner.sessionId);
			if (snapshot) {
				if (snapshot.owner.sessionId !== owner.sessionId) {
					this.clearLoadedState();
					this.ownershipConflict = { missionId: snapshot.mission.missionId, ownerSessionId: snapshot.owner.sessionId };
					return;
				}
				this.restoreSnapshot(snapshot, branch, ctx.cwd);
				return;
			}
			if (anchor?.kind === "taken_over") {
				this.clearLoadedState();
				this.persistenceError = `Canonical Mission state is missing for ${anchor.missionId}.`;
				return;
			}
			if (!anchor && !this.current) {
				const foreign = snapshots.filter((candidate) => candidate.owner.sessionId !== owner.sessionId && !["complete", "ended", "cleared"].includes(candidate.mission.status));
				if (foreign.length === 1) this.ownershipConflict = { missionId: foreign[0]!.mission.missionId, ownerSessionId: foreign[0]!.owner.sessionId };
				else if (foreign.length > 1) this.persistenceError = `Multiple takeover candidates exist: ${foreign.map((candidate) => candidate.mission.missionId).join(", ")}`;
				if (foreign.length) return;
			}
			if (this.current) this.bootstrapSnapshot(owner);
		} catch (error) {
			this.clearLoadedState();
			this.persistenceError = error instanceof Error ? error.message : String(error);
		}
	}

	loadLegacyBranch(branch: Array<any>, cwd: string): void {
		this.cwd = cwd;
		this.owner = undefined;
		this.snapshotRevision = undefined;
		this.ownershipConflict = undefined;
		this.persistenceError = undefined;
		this.carriedUsage = zeroUsage();
		this.usageComplete = true;
		this.loadBranch(branch, cwd);
	}

	exportSnapshot(owner: MissionOwner, usageComplete = this.usageComplete): MissionSnapshot {
		if (!this.current) throw new Error("No Mission state is available to persist.");
		return {
			version: 1,
			revision: this.snapshotRevision ?? 0,
			owner: { ...owner },
			mission: { ...this.current },
			progress: cloneProgress(this.progress),
			continuationProgressIndex: this.continuationProgressIndex,
			carriedUsage: { ...this.carriedUsage },
			usage: { ...this.usage },
			reviewFailureCount: this.reviewFailureCount,
			usageComplete,
		};
	}

	takeover(pi: { appendEntry<T = unknown>(customType: string, data?: T): void }, candidate: MissionTakeoverCandidate, ctx: ExtensionContext, reason: string): MissionCurrent {
		const owner = currentMissionOwner(ctx);
		if (!owner) throw new Error("Mission takeover requires a persisted Pi session.");
		const explanation = reason.trim();
		if (!explanation) throw new Error("Mission takeover requires a reason.");
		this.loadFromSession(ctx);
		if (this.readAny()) throw new Error(`This session already controls Mission ${this.current!.missionId}.`);
		const source = candidate.snapshot;
		const cwd = ctx.cwd;
		const branch = ctx.sessionManager.getBranch() as Array<any>;
		const currentAggregate = aggregateUsage(branch);
		let taken!: MissionSnapshot;
		const transfer = () => withMissionLock(cwd, source.mission.slug, () => {
			const stored = readMissionSnapshot(cwd, source.mission.slug);
			if (stored && (stored.revision !== source.revision || stored.owner.sessionId !== source.owner.sessionId)) throw new Error("Mission ownership changed; inspect the latest controller before retrying takeover.");
			if (!stored && candidate.source === "snapshot") throw new Error("Mission canonical state disappeared before takeover.");
			const now = Date.now();
			const preservesReview = source.mission.reviewStatus === "clear" || source.mission.reviewStatus === "skipped" || source.mission.reviewStatus === "changes_requested";
			const mission: MissionCurrent = {
				...source.mission,
				status: takeoverStatus(source),
				updatedAt: now,
				artifactDir: missionDir(cwd, source.mission.slug),
				generation: randomUUID(),
				lastReason: explanation,
				baselineMainTokens: currentAggregate.mainTokens,
				baselineSubagentTokens: currentAggregate.subagentTokens,
				baselineMainCostUsd: currentAggregate.mainCostUsd,
				baselineSubagentCostUsd: currentAggregate.subagentCostUsd,
				reviewStatus: preservesReview ? source.mission.reviewStatus : "due",
				reviewReason: preservesReview ? source.mission.reviewReason : "Mission ownership changed; unresolved review requires recovery.",
				reviewRunId: source.mission.reviewStatus === "changes_requested" ? source.mission.reviewRunId : undefined,
				reviewFailure: undefined,
			};
			taken = {
				...source,
				revision: (stored?.revision ?? source.revision) + 1,
				owner,
				mission,
				continuationProgressIndex: source.progress.length,
				carriedUsage: { ...source.usage },
				usage: { ...source.usage },
				usageComplete: source.usageComplete,
				reviewFailureCount: 0,
			};
			writeMissionSnapshot(cwd, taken);
		});
		if (candidate.source === "legacy_session") {
			withMissionWorkspaceLock(cwd, () => {
				const existing = listMissionSnapshots(cwd).filter((snapshot) => !["complete", "ended", "cleared"].includes(snapshot.mission.status));
				if (existing.length) throw new Error(`A Mission already exists in this workspace: ${existing.map((snapshot) => snapshot.mission.missionId).join(", ")}.`);
				transfer();
			});
		} else transfer();
		this.ownershipConflict = undefined;
		this.persistenceError = undefined;
		this.restoreSnapshot(taken, branch, cwd);
		try {
			pi.appendEntry(MISSION_CUSTOM_TYPE, {
				kind: "taken_over",
				missionId: taken.mission.missionId,
				generation: taken.mission.generation,
				at: taken.mission.updatedAt,
				status: taken.mission.status,
				slug: taken.mission.slug,
				ownerSessionId: owner.sessionId,
				previousOwnerSessionId: source.owner.sessionId,
				reason: explanation,
			} satisfies MissionEvent);
		} catch {
			// Canonical ownership already transferred; the session mirror is repairable on reload.
		}
		return this.readAny()!;
	}

	private loadBranch(branch: Array<any>, cwd: string): void {
		const rolling = zeroUsage();
		let terminalUsage: MissionUsage | undefined;
		const seenSubagents = new Set<string>();
		this.clearLoadedState();
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === MISSION_CUSTOM_TYPE) {
				const rawEvent = entry.data as MissionEvent | undefined;
				if (!rawEvent?.missionId || rawEvent.kind === "taken_over") continue;
				const event = rawEvent.kind === "created" && rawEvent.baselineMainTokens === undefined
					? { ...rawEvent, baselineMainTokens: rolling.mainTokens, baselineSubagentTokens: rolling.subagentTokens, baselineMainCostUsd: rolling.mainCostUsd, baselineSubagentCostUsd: rolling.subagentCostUsd }
					: rawEvent;
				this.applyEvent(event);
				if (event.reviewOutcome === "failed") this.reviewFailureCount++;
				const status = (this.current as MissionCurrent | undefined)?.status;
				if (["complete", "ended", "cleared", "budget_limited"].includes(status ?? "")) terminalUsage = { ...rolling };
				continue;
			}
			addUsageFromEntry(rolling, entry, seenSubagents);
		}
		const current = this.current as MissionCurrent | undefined;
		if (current) current.artifactDir = missionDir(cwd, current.slug);
		const terminal = current && ["complete", "ended", "cleared", "budget_limited"].includes(current.status);
		this.usage = current ? usageFromAggregate(terminal ? terminalUsage ?? rolling : rolling, current) : zeroUsage();
	}

	private clearLoadedState(): void {
		this.current = undefined;
		this.usage = zeroUsage();
		this.carriedUsage = zeroUsage();
		this.progress = [];
		this.continuationProgressIndex = 0;
		this.reviewFailureCount = 0;
		this.usageComplete = true;
		this.snapshotRevision = undefined;
	}

	private restoreSnapshot(snapshot: MissionSnapshot, branch: Array<any>, cwd: string, includeBranchUsage = true): void {
		this.current = { ...snapshot.mission, artifactDir: missionDir(cwd, snapshot.mission.slug) };
		this.progress = cloneProgress(snapshot.progress);
		this.continuationProgressIndex = snapshot.continuationProgressIndex;
		this.reviewFailureCount = snapshot.reviewFailureCount;
		this.usageComplete = snapshot.usageComplete;
		this.carriedUsage = { ...snapshot.carriedUsage };
		this.snapshotRevision = snapshot.revision;
		this.owner = { ...snapshot.owner };
		const terminal = ["complete", "ended", "cleared", "budget_limited"].includes(snapshot.mission.status);
		this.usage = terminal || !includeBranchUsage
			? { ...snapshot.usage }
			: addUsage(this.carriedUsage, usageFromAggregate(aggregateUsage(branch), this.current));
	}

	private bootstrapSnapshot(owner: MissionOwner): void {
		if (!this.current || !this.cwd) return;
		withMissionWorkspaceLock(this.cwd, () => {
			const existing = listMissionSnapshots(this.cwd!).filter((snapshot) => !["complete", "ended", "cleared"].includes(snapshot.mission.status) && snapshot.mission.missionId !== this.current!.missionId);
			if (existing.length) throw new Error(`A Mission is already controlled in this workspace: ${existing.map((snapshot) => snapshot.mission.missionId).join(", ")}.`);
			withMissionLock(this.cwd!, this.current!.slug, () => {
				const stored = readMissionSnapshot(this.cwd!, this.current!.slug);
				if (stored) {
					if (stored.owner.sessionId !== owner.sessionId) throw new Error("Mission is already controlled by another Pi session.");
					this.restoreSnapshot(stored, [], this.cwd!, false);
					return;
				}
				const snapshot = this.exportSnapshot(owner);
				snapshot.revision = 1;
				writeMissionSnapshot(this.cwd!, snapshot);
				this.snapshotRevision = 1;
			});
		});
	}

	async create(input: MissionCreateInput, ctx: ExtensionContext): Promise<MissionEvent> {
		if (this.persistenceError) throw new Error(this.persistenceError);
		if (this.ownershipConflict) throw new Error(`Mission ${this.ownershipConflict.missionId} is controlled by another session; take it over or finish it before creating a replacement.`);
		const existing = this.readAny();
		if (this.creationPending || (existing && existing.status !== "complete" && existing.status !== "ended")) throw new Error(`Mission already exists${existing ? `: ${existing.title}` : " or is being created"}. End or clear it before creating another.`);
		this.creationPending = true;
		try {
			assertInputLimits(input.requirements, input.paths);
			const objective = input.objective.trim();
			if (!objective) throw new Error("Mission objective must not be empty.");
			const requirements = normalizeRequirements(input.requirements?.length ? input.requirements : inferRequirements(objective));
			const title = normalizeTitle(input.title) || deriveMissionTitle(objective, requirements);
			const baseSlug = slugify(title).slice(0, 42) || "mission";
			const chain = input.chain?.trim() || await chooseDefaultChain(ctx.cwd, title, baseSlug);
			const now = Date.now();
			const missionId = `m_${now.toString(36)}_${randomUUID().slice(0, 6)}`;
			const slug = `${baseSlug}-${missionId.slice(-6)}`;
			const baseline = aggregateUsage(ctx.sessionManager.getBranch() as Array<any>);
			return {
				kind: "created",
				missionId,
				at: now,
				objective,
				title,
				requirements,
				status: "active",
				slug,
				chain,
				chainBranch: input.chainBranch?.trim() || DEFAULT_CHAIN_BRANCH,
				artifactDir: missionDir(ctx.cwd, slug),
				paths: normalizePaths(input.paths),
				tokenBudget: positiveNumber(input.tokenBudget, "tokenBudget"),
				costBudgetUsd: positiveNumber(input.costBudgetUsd ?? 1_000, "costBudgetUsd"),
				baselineMainTokens: baseline.mainTokens,
				baselineSubagentTokens: baseline.subagentTokens,
				baselineMainCostUsd: baseline.mainCostUsd,
				baselineSubagentCostUsd: baseline.subagentCostUsd,
				generation: randomUUID(),
				objectiveVersion: 1,
				turnBudget: positiveInteger(input.turnBudget, "turnBudget"),
				wallDeadlineAt: input.wallDeadlineMs === undefined ? undefined : now + positiveNumber(input.wallDeadlineMs, "wallDeadlineMs")!,
				reviewStatus: "due",
				initialBaselinePending: true,
				reviewUpdatedAt: now,
				reviewReason: "Mission creation requires a durable initial workspace baseline.",
				reviewAdjudicationHistoryComplete: true,
				reviewCorrectionCount: 0,
				reviewCorrectionLimit: DEFAULT_REVIEW_CORRECTION_LIMIT,
				blockerCount: 0,
				turnCount: 0,
			};
		} catch (error) {
			this.creationPending = false;
			throw error;
		}
	}

	append(pi: { appendEntry<T = unknown>(customType: string, data?: T): void }, event: MissionEvent): MissionCurrent | undefined {
		try {
			if (!this.cwd || !this.owner) {
				pi.appendEntry(MISSION_CUSTOM_TYPE, event);
				this.applyEvent(event);
				if (event.reviewOutcome === "failed") this.reviewFailureCount++;
				return this.readAny();
			}
			const persist = () => withMissionLock(this.cwd!, event.slug ?? this.current?.slug ?? "", () => {
				const stored = readMissionSnapshot(this.cwd!, event.slug ?? this.current!.slug);
				if (event.kind === "created" && stored) throw new Error(`Mission artifact state already exists: ${event.slug}`);
				const currentUsage = this.usage;
				if (event.kind !== "created") {
					if (!stored || stored.owner.sessionId !== this.owner!.sessionId) throw new Error("Mission is controlled by another Pi session.");
					if (stored.revision !== this.snapshotRevision) throw new Error("Mission state changed concurrently; reload before retrying.");
					this.restoreSnapshot(stored, [], this.cwd!, false);
					this.usage = currentUsage;
				}
				if (stored?.revision === Number.MAX_SAFE_INTEGER) throw new Error("Mission state revision space is exhausted.");
				// Apply to in-memory state, then commit to disk. If the durable write fails, roll the in-memory state back so read()/readAny() never report an event that was never persisted.
				this.applyEvent(event);
				if (event.reviewOutcome === "failed") this.reviewFailureCount++;
				try {
					const snapshot = this.exportSnapshot(this.owner!);
					snapshot.revision = (stored?.revision ?? 0) + 1;
					writeMissionSnapshot(this.cwd!, snapshot);
					this.snapshotRevision = snapshot.revision;
				} catch (error) {
					if (stored) { this.restoreSnapshot(stored, [], this.cwd!, false); this.usage = currentUsage; }
					else this.clearLoadedState();
					throw error;
				}
			});
			// Resuming an `ended` Mission re-enters the active set, so it needs the same single-active-Mission admission as creation; `ended` is otherwise filtered out of the workspace exclusivity check.
			const needsWorkspaceAdmission = event.kind === "created" || (event.kind === "status_changed" && event.status === "active" && this.current?.status === "ended");
			if (needsWorkspaceAdmission) {
				const selfId = event.missionId ?? this.current?.missionId;
				withMissionWorkspaceLock(this.cwd, () => {
					const existing = listMissionSnapshots(this.cwd!).filter((snapshot) => snapshot.mission.missionId !== selfId && !["complete", "ended", "cleared"].includes(snapshot.mission.status));
					if (existing.length) throw new Error(`A Mission already exists in this workspace: ${existing.map((snapshot) => snapshot.mission.missionId).join(", ")}.`);
					persist();
				});
			} else persist();
			pi.appendEntry(MISSION_CUSTOM_TYPE, event);
			return this.readAny();
		} finally {
			if (event.kind === "created") this.creationPending = false;
		}
	}

	statusEvent(status: MissionStatus, reason?: string, summary?: string): MissionEvent {
		const mission = this.requireCurrent();
		if (!STATUS_TRANSITIONS[mission.status].includes(status)) throw new Error(`Mission cannot transition from ${mission.status} to ${status}.`);
		return { kind: status === "complete" ? "completed" : "status_changed", missionId: mission.missionId, generation: mission.generation, at: Date.now(), status, reason, summary };
	}

	continuedEvent(): MissionEvent {
		const mission = this.requireActive();
		return { kind: "continued", missionId: mission.missionId, generation: mission.generation, at: Date.now(), status: mission.status, turnCount: (mission.turnCount ?? 0) + 1 };
	}

	objectiveUpdateEvent(input: MissionUpdateInput): MissionEvent {
		const mission = this.requireMutable();
		assertInputLimits(input.requirements, input.paths);
		const objective = input.objective?.trim().replace(/\s+/g, " ") || mission.objective;
		const requirements = input.requirements?.length ? normalizeRequirements(input.requirements) : mission.requirements;
		const paths = input.paths !== undefined ? normalizePaths(input.paths) : mission.paths;
		const identityChanged = objective !== mission.objective.trim().replace(/\s+/g, " ") || !sameOrderedStrings(requirements, mission.requirements) || !sameStringSet(paths, mission.paths);
		if (!input.reason.trim()) throw new Error("Mission objective updates require a reason.");
		return {
			kind: "objective_updated",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			objective,
			requirements,
			objectiveVersion: identityChanged ? (mission.objectiveVersion ?? 1) + 1 : mission.objectiveVersion ?? 1,
			reason: input.reason.trim(),
			...(input.paths !== undefined ? { paths } : {}),
			...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget === null || input.tokenBudget === 0 ? null : positiveNumber(input.tokenBudget, "tokenBudget") } : {}),
			...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd === null || input.costBudgetUsd === 0 ? null : positiveNumber(input.costBudgetUsd, "costBudgetUsd") } : {}),
			...(input.turnBudget !== undefined ? { turnBudget: input.turnBudget === null || input.turnBudget === 0 ? null : positiveInteger(input.turnBudget, "turnBudget") } : {}),
			...(input.wallDeadlineMs !== undefined ? { wallDeadlineAt: input.wallDeadlineMs === null || input.wallDeadlineMs === 0 ? null : Date.now() + positiveNumber(input.wallDeadlineMs, "wallDeadlineMs")! } : {}),
			...(identityChanged ? { reviewStatus: "due" as const, reviewReason: "Mission objective changed" } : {}),
		};
	}

	reviewEvent(status: MissionReviewStatus, input: { runId?: string; admissionId?: string; reason?: string; skippedReason?: string; suggestedVerdict?: MissionReviewVerdict | "unknown"; failure?: boolean; outcome?: MissionReviewOutcome; notBeforeAt?: number; worktreeFingerprint?: string; candidateId?: string; highestSeverity?: MissionReviewSeverity; blockingFindingCount?: number; backlogFindingCount?: number; findings?: MissionReviewFinding[]; scopePaths?: string[]; scopeRevisions?: MissionReviewRevision[]; replayAdjudication?: boolean } = {}): MissionEvent {
		const mission = this.requireActive();
		const adjudicated = status === "clear" || status === "changes_requested";
		const correctionCount = input.replayAdjudication ? mission.reviewCorrectionCount : status === "changes_requested" ? (mission.reviewCorrectionCount ?? 0) + 1 : status === "clear" ? 0 : undefined;
		const supersessionCount = input.outcome === "superseded" ? (mission.reviewSupersessionCount ?? 0) + 1 : (status === "clear" || status === "changes_requested") ? 0 : undefined;
		const candidateId = input.candidateId ?? (status === "due" ? undefined : mission.reviewCandidateId);
		const findings = input.findings?.map((finding) => ({ ...finding }));
		const acceptedFindings = status === "changes_requested"
			? (mission.reviewFindings ?? []).filter((finding) => finding.severity === "blocker" || finding.severity === "major").map((finding) => ({ ...finding }))
			: status === "clear" ? [] : undefined;
		const acceptedRevisions = status === "changes_requested" || status === "clear"
			? mission.reviewScopeRevisions?.map((revision) => ({ root: revision.root, base: revision.head, head: revision.head }))
			: undefined;
		let previousAdjudications = [...(mission.reviewAdjudications ?? [])];
		if (mission.reviewAdjudicatedCandidateId && mission.reviewAdjudicatedVerdict) {
			previousAdjudications = [...previousAdjudications.filter((item) => item.candidateId !== mission.reviewAdjudicatedCandidateId), { candidateId: mission.reviewAdjudicatedCandidateId, verdict: mission.reviewAdjudicatedVerdict }];
		}
		const candidateKnown = candidateId ? previousAdjudications.some((item) => item.candidateId === candidateId) : false;
		if (adjudicated && candidateId && mission.reviewAdjudicationHistoryComplete !== true && !candidateKnown) {
			throw new Error("Mission review adjudication history is incomplete; refusing to adjudicate an unknown candidate.");
		}
		if (adjudicated && candidateId && previousAdjudications.length >= MAX_MISSION_REVIEW_ADJUDICATIONS && !candidateKnown) {
			throw new Error("Mission review adjudication history capacity is exhausted; refusing to forget a reviewed candidate.");
		}
		const adjudications = adjudicated && candidateId
			? [...previousAdjudications.filter((item) => item.candidateId !== candidateId), { candidateId, verdict: status }]
			: undefined;
		return {
			kind: "review_changed",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			reviewStatus: status,
			reviewRunId: input.runId,
			reviewAdmissionId: input.admissionId,
			reviewReason: input.reason,
			reviewSkippedReason: input.skippedReason?.trim(),
			reviewSuggestedVerdict: input.suggestedVerdict,
			reviewFailure: input.failure,
			reviewOutcome: input.outcome,
			reviewNotBeforeAt: input.notBeforeAt,
			reviewSupersessionCount: supersessionCount,
			reviewWorktreeFingerprint: input.worktreeFingerprint,
			admittedWorktreeFingerprint: status === "skipped" || status === "not_required" ? input.worktreeFingerprint : undefined,
			reviewCandidateId: candidateId,
			reviewCandidateObjectiveVersion: candidateId ? mission.objectiveVersion ?? 1 : undefined,
			reviewAdjudicatedCandidateId: adjudicated ? candidateId : undefined,
			reviewAdjudicatedVerdict: adjudicated ? status : undefined,
			reviewAdjudications: adjudications,
			reviewHighestSeverity: input.highestSeverity,
			reviewBlockingFindingCount: input.blockingFindingCount,
			reviewBacklogFindingCount: input.backlogFindingCount,
			reviewFindings: findings,
			reviewAcceptedFindings: acceptedFindings,
			reviewScopePaths: input.scopePaths,
			reviewScopeRevisions: input.scopeRevisions,
			reviewAcceptedRevisions: acceptedRevisions,
			reviewCorrectionCount: correctionCount,
		};
	}

	reviewPolicyEvent(reviewCorrectionLimit: number): MissionEvent {
		const mission = this.requireCurrent();
		if (mission.status !== "blocked" || (mission.reviewCorrectionCount ?? 0) <= (mission.reviewCorrectionLimit ?? DEFAULT_REVIEW_CORRECTION_LIMIT)) throw new Error("Mission review correction authorization is not required.");
		if (!Number.isSafeInteger(reviewCorrectionLimit) || reviewCorrectionLimit < (mission.reviewCorrectionCount ?? 0)) throw new Error("Review correction limit must cover the pending correction cycle.");
		return { kind: "review_policy_updated", missionId: mission.missionId, generation: mission.generation, at: Date.now(), reviewCorrectionLimit };
	}

	completionLatchEvent(candidateId: string, reviewStatus: MissionConvergedReviewStatus): MissionEvent {
		const mission = this.requireActive();
		if (!candidateId) throw new Error("Mission completion authorization requires an exact candidate.");
		return { kind: "completion_latched", missionId: mission.missionId, generation: mission.generation, at: Date.now(), completionLatchCandidateId: candidateId, completionLatchReviewStatus: reviewStatus };
	}

	completionLatchClearedEvent(): MissionEvent {
		const mission = this.requireActive();
		return { kind: "completion_latch_cleared", missionId: mission.missionId, generation: mission.generation, at: Date.now() };
	}

	completionEvent(candidateId: string, completionId: string, audit: Array<{ requirementIndex: number; evidence: string }> | undefined, reason?: string, summary?: string): MissionEvent {
		const mission = this.requireActive();
		if (mission.completionLatchCandidateId !== candidateId) throw new Error("Mission completion is not authorized for this candidate.");
		if (mission.completionLatchReviewStatus !== (mission.reviewStatus ?? "not_required")) throw new Error("Mission completion authorization does not match the current review disposition.");
		return { kind: "completed", missionId: mission.missionId, generation: mission.generation, at: Date.now(), status: "complete", reason, summary, reviewCandidateId: candidateId, expectedObjectiveVersion: mission.objectiveVersion ?? 1, completionId, completionEffectsStatus: "pending", completionAudit: audit };
	}

	completionEffectsDoneEvent(completionId: string): MissionEvent {
		const mission = this.requireCurrent();
		return { kind: "completion_effects_done", missionId: mission.missionId, generation: mission.generation, at: Date.now(), completionId, completionEffectsStatus: "done" };
	}

	workspaceFingerprintEvent(fingerprint: string): MissionEvent {
		const mission = this.requireActive();
		return { kind: "workspace_fingerprinted", missionId: mission.missionId, generation: mission.generation, at: Date.now(), admittedWorktreeFingerprint: fingerprint };
	}

	settledEvent(input: { blockerFingerprint?: string; madeProgress: boolean }): MissionEvent {
		const mission = this.requireActive();
		const sameBlocker = input.blockerFingerprint && input.blockerFingerprint === mission.blockerFingerprint;
		return {
			kind: "settled",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			blockerFingerprint: input.madeProgress ? undefined : input.blockerFingerprint ?? mission.blockerFingerprint,
			blockerCount: input.madeProgress ? 0 : sameBlocker ? (mission.blockerCount ?? 0) + 1 : input.blockerFingerprint ? 1 : mission.blockerCount ?? 0,
		};
	}

	progressEvent(input: MissionProgressInput): MissionEvent {
		const mission = this.requireMutable();
		const summary = input.summary.trim();
		if (!summary) throw new Error("mission_progress summary must not be empty.");
		const blockerId = input.blockerId?.trim();
		if (input.blocked && !blockerId) throw new Error("blocked Mission progress requires blockerId.");
		return {
			kind: "progress",
			missionId: mission.missionId,
			generation: mission.generation,
			at: Date.now(),
			summary: summary.slice(0, 1200),
			evidence: normalizeProgressList(input.evidence, 20),
			remaining: normalizeProgressList(input.remaining, 20),
			validation: normalizeValidation(input.validation, mission.objectiveVersion ?? 1),
			checkpoint: input.checkpoint === true,
			blocked: input.blocked === true,
			blockerId: blockerId?.slice(0, 160),
		};
	}

	limitExceeded(): "token" | "cost" | "turn" | "wall" | null {
		const mission = this.current;
		if (!mission) return null;
		if (mission.tokenBudget !== undefined && this.usage.totalTokens >= mission.tokenBudget) return "token";
		if (mission.costBudgetUsd !== undefined && this.usage.totalCostUsd >= mission.costBudgetUsd) return "cost";
		if (mission.turnBudget !== undefined && (mission.turnCount ?? 0) >= mission.turnBudget) return "turn";
		if (mission.wallDeadlineAt !== undefined && Date.now() >= mission.wallDeadlineAt) return "wall";
		return null;
	}

	budgetExceeded(): "token" | "cost" | "turn" | "wall" | null {
		return this.current?.status === "active" ? this.limitExceeded() : null;
	}

	private requireCurrent(): MissionCurrent {
		if (this.persistenceError) throw new Error(this.persistenceError);
		if (this.ownershipConflict) throw new Error(`Mission ${this.ownershipConflict.missionId} is controlled by session ${this.ownershipConflict.ownerSessionId}; use mission_takeover only with explicit user confirmation.`);
		if (!this.current || this.current.status === "cleared") throw new Error("No Mission is controlled by this session.");
		return this.current;
	}

	private requireMutable(): MissionCurrent {
		const mission = this.requireCurrent();
		if (mission.status === "complete" || mission.status === "ended") throw new Error(`Mission ${mission.status} is terminal and cannot be mutated.`);
		return mission;
	}

	private requireActive(): MissionCurrent {
		const mission = this.requireMutable();
		if (mission.status !== "active") throw new Error(`Mission must be active, not ${mission.status}.`);
		return mission;
	}

	private applyEvent(event: MissionEvent): void {
		if (event.kind === "created") {
			if (!event.objective || !event.slug || !event.chain || !event.artifactDir) return;
			const requirements = normalizeRequirements(event.requirements?.length ? event.requirements : inferRequirements(event.objective));
			this.progress = [];
			this.continuationProgressIndex = 0;
			this.reviewFailureCount = 0;
			this.current = {
				missionId: event.missionId,
				objective: event.objective,
				title: normalizeTitle(event.title) || deriveMissionTitle(event.objective, requirements),
				requirements,
				status: event.status ?? "active",
				createdAt: event.at,
				updatedAt: event.at,
				slug: event.slug,
				chain: event.chain,
				chainBranch: event.chainBranch ?? DEFAULT_CHAIN_BRANCH,
				artifactDir: event.artifactDir,
				paths: normalizePaths(event.paths),
				tokenBudget: event.tokenBudget ?? undefined,
				costBudgetUsd: event.costBudgetUsd ?? undefined,
				baselineMainTokens: event.baselineMainTokens ?? 0,
				baselineSubagentTokens: event.baselineSubagentTokens ?? 0,
				baselineMainCostUsd: event.baselineMainCostUsd ?? 0,
				baselineSubagentCostUsd: event.baselineSubagentCostUsd ?? 0,
				generation: event.generation ?? `legacy-${event.missionId}`,
				objectiveVersion: event.objectiveVersion ?? 1,
				turnBudget: event.turnBudget ?? undefined,
				wallDeadlineAt: event.wallDeadlineAt ?? undefined,
				reviewStatus: event.reviewStatus ?? "not_required",
				initialBaselinePending: event.initialBaselinePending ?? false,
				reviewUpdatedAt: event.reviewUpdatedAt ?? event.at,
				reviewRunId: event.reviewRunId,
				reviewOutcome: event.reviewOutcome,
				reviewNotBeforeAt: event.reviewNotBeforeAt,
				reviewSupersessionCount: event.reviewSupersessionCount ?? 0,
				reviewAdmissionId: event.reviewAdmissionId,
				reviewReason: event.reviewReason,
				reviewSkippedReason: event.reviewSkippedReason,
				admittedWorktreeFingerprint: event.admittedWorktreeFingerprint,
				reviewCandidateId: event.reviewCandidateId,
				reviewCandidateObjectiveVersion: event.reviewCandidateObjectiveVersion,
				reviewAdjudicatedCandidateId: event.reviewAdjudicatedCandidateId,
				reviewAdjudicatedVerdict: event.reviewAdjudicatedVerdict,
				reviewAdjudications: event.reviewAdjudications?.map((item) => ({ ...item })),
				reviewAdjudicationHistoryComplete: event.reviewAdjudicationHistoryComplete,
				reviewHighestSeverity: event.reviewHighestSeverity,
				reviewBlockingFindingCount: event.reviewBlockingFindingCount ?? 0,
				reviewBacklogFindingCount: event.reviewBacklogFindingCount ?? 0,
				reviewFindings: event.reviewFindings?.map((finding) => ({ ...finding })),
				reviewAcceptedFindings: event.reviewAcceptedFindings?.map((finding) => ({ ...finding })),
				reviewScopePaths: event.reviewScopePaths ? [...event.reviewScopePaths] : undefined,
				reviewScopeRevisions: event.reviewScopeRevisions?.map((revision) => ({ ...revision })),
				reviewAcceptedRevisions: event.reviewAcceptedRevisions?.map((revision) => ({ ...revision })),
				reviewCorrectionCount: event.reviewCorrectionCount ?? 0,
				reviewCorrectionLimit: event.reviewCorrectionLimit ?? DEFAULT_REVIEW_CORRECTION_LIMIT,
				completionLatchCandidateId: event.completionLatchCandidateId,
				completionLatchReviewStatus: event.completionLatchReviewStatus,
				completionId: event.completionId,
				completionEffectsStatus: event.completionEffectsStatus,
				blockerFingerprint: event.blockerFingerprint,
				blockerCount: event.blockerCount ?? 0,
				turnCount: event.turnCount ?? 0,
			};
			return;
		}
		if (!this.current || this.current.missionId !== event.missionId) return;
		if (event.generation && this.current.generation && event.generation !== this.current.generation) return;
		if (event.kind === "completed" && event.completionId) {
			if (this.current.status !== "active") throw new Error("Mission completion was already committed or the Mission is no longer active.");
			if (this.current.objectiveVersion !== event.expectedObjectiveVersion || this.current.completionLatchCandidateId !== event.reviewCandidateId) throw new Error("Mission completion candidate changed before terminal commit.");
		}
		if (event.kind === "completion_effects_done" && (this.current.status !== "complete" || this.current.completionId !== event.completionId)) throw new Error("Mission completion effects do not match the terminal operation.");
		this.current.updatedAt = event.at;
		if (event.status) this.current.status = event.status;
		if (event.reason) this.current.lastReason = event.reason;
		if (event.summary) this.current.lastSummary = event.summary;
		if (event.kind === "continued") {
			this.current.lastContinuationAt = event.at;
			this.current.turnCount = event.turnCount ?? (this.current.turnCount ?? 0) + 1;
			this.continuationProgressIndex = this.progress.length;
		}
		if (event.kind === "objective_updated") {
			this.continuationProgressIndex = this.progress.length;
			const identityChanged = event.objectiveVersion === undefined || event.objectiveVersion !== (this.current.objectiveVersion ?? 1);
			if (event.objective) this.current.objective = event.objective;
			if (event.requirements) this.current.requirements = normalizeRequirements(event.requirements);
			if (event.paths !== undefined) this.current.paths = normalizePaths(event.paths);
			if (event.tokenBudget !== undefined) this.current.tokenBudget = event.tokenBudget ?? undefined;
			if (event.costBudgetUsd !== undefined) this.current.costBudgetUsd = event.costBudgetUsd ?? undefined;
			if (event.turnBudget !== undefined) this.current.turnBudget = event.turnBudget ?? undefined;
			if (event.wallDeadlineAt !== undefined) this.current.wallDeadlineAt = event.wallDeadlineAt ?? undefined;
			this.current.objectiveVersion = event.objectiveVersion ?? (this.current.objectiveVersion ?? 1) + 1;
			if (identityChanged) {
				this.current.reviewOutcome = "superseded";
				this.current.reviewSupersessionCount = (this.current.reviewSupersessionCount ?? 0) + 1;
				this.current.reviewNotBeforeAt = undefined;
				if (!this.current.reviewRunId || !this.current.reviewAdmissionId) {
					this.current.reviewCandidateId = undefined;
					this.current.reviewCandidateObjectiveVersion = undefined;
					this.current.reviewWorktreeFingerprint = undefined;
				}
				this.current.reviewAdjudicatedCandidateId = undefined;
				this.current.reviewAdjudicatedVerdict = undefined;
				this.current.reviewFindings = undefined;
				this.current.reviewAcceptedFindings = undefined;
				this.current.reviewScopePaths = undefined;
				this.current.reviewScopeRevisions = undefined;
				this.current.reviewAcceptedRevisions = undefined;
				this.current.reviewCorrectionCount = 0;
				this.current.completionLatchCandidateId = undefined;
				this.current.completionLatchReviewStatus = undefined;
			}
		}
		if (event.reviewStatus) this.current.reviewStatus = event.reviewStatus;
		if (event.kind === "review_changed") this.current.reviewUpdatedAt = event.at;
		if (event.kind === "review_changed" && event.reviewStatus === "not_required") this.current.initialBaselinePending = false;
		// A review that reaches the reviewer or clears wipes the transient failure streak, so weeks-apart intermittent reviewer failures cannot accumulate into a permanent three-strike block.
		if (event.reviewStatus === "awaiting_adjudication" || event.reviewStatus === "clear") this.reviewFailureCount = 0;
		if (event.kind === "review_changed") {
			this.current.reviewRunId = event.reviewRunId;
			this.current.reviewAdmissionId = event.reviewAdmissionId;
		} else {
			if (event.reviewRunId !== undefined) this.current.reviewRunId = event.reviewRunId;
			if (event.reviewAdmissionId !== undefined) this.current.reviewAdmissionId = event.reviewAdmissionId;
		}
		if (event.reviewReason !== undefined) this.current.reviewReason = event.reviewReason;
		if (event.reviewSkippedReason !== undefined) this.current.reviewSkippedReason = event.reviewSkippedReason;
		if (event.reviewSuggestedVerdict !== undefined) this.current.reviewSuggestedVerdict = event.reviewSuggestedVerdict;
		if (event.kind === "review_changed") {
			this.current.reviewFailure = event.reviewFailure;
			this.current.reviewOutcome = event.reviewOutcome;
		}
		if (event.reviewStatus && event.reviewStatus !== "due") this.current.reviewNotBeforeAt = undefined;
		else if (event.reviewNotBeforeAt !== undefined) this.current.reviewNotBeforeAt = event.reviewNotBeforeAt;
		if (event.reviewWorktreeFingerprint !== undefined) this.current.reviewWorktreeFingerprint = event.reviewWorktreeFingerprint;
		if (event.admittedWorktreeFingerprint !== undefined) this.current.admittedWorktreeFingerprint = event.admittedWorktreeFingerprint;
		if (event.kind === "review_changed" && event.reviewStatus === "due" && event.reviewCandidateId === undefined) {
			this.current.reviewCandidateId = undefined;
			this.current.reviewCandidateObjectiveVersion = undefined;
			this.current.reviewWorktreeFingerprint = undefined;
		} else if (event.reviewCandidateId !== undefined) this.current.reviewCandidateId = event.reviewCandidateId;
		if (event.reviewCandidateObjectiveVersion !== undefined) this.current.reviewCandidateObjectiveVersion = event.reviewCandidateObjectiveVersion;
		if (event.reviewAdjudicatedCandidateId !== undefined) this.current.reviewAdjudicatedCandidateId = event.reviewAdjudicatedCandidateId;
		if (event.reviewAdjudicatedVerdict !== undefined) this.current.reviewAdjudicatedVerdict = event.reviewAdjudicatedVerdict;
		if (event.reviewAdjudications !== undefined || (event.reviewAdjudicatedCandidateId && event.reviewAdjudicatedVerdict)) {
			const additions = [...(event.reviewAdjudications ?? [])];
			if (event.reviewAdjudicatedCandidateId && event.reviewAdjudicatedVerdict) additions.push({ candidateId: event.reviewAdjudicatedCandidateId, verdict: event.reviewAdjudicatedVerdict });
			for (const adjudication of additions) this.current.reviewAdjudications = [...(this.current.reviewAdjudications ?? []).filter((item) => item.candidateId !== adjudication.candidateId), { ...adjudication }];
		}
		if (event.reviewAdjudicationHistoryComplete !== undefined) this.current.reviewAdjudicationHistoryComplete = event.reviewAdjudicationHistoryComplete;
		if (event.kind === "review_changed" && event.reviewStatus === "awaiting_adjudication") this.current.reviewHighestSeverity = event.reviewHighestSeverity;
		else if (event.reviewHighestSeverity !== undefined) this.current.reviewHighestSeverity = event.reviewHighestSeverity;
		if (event.reviewBlockingFindingCount !== undefined) this.current.reviewBlockingFindingCount = event.reviewBlockingFindingCount;
		if (event.reviewBacklogFindingCount !== undefined) this.current.reviewBacklogFindingCount = event.reviewBacklogFindingCount;
		if (event.kind === "review_changed" && event.reviewStatus === "due") {
			this.current.reviewFindings = undefined;
			this.current.reviewScopePaths = undefined;
			this.current.reviewScopeRevisions = undefined;
		}
		if (event.reviewFindings !== undefined) this.current.reviewFindings = event.reviewFindings.map((finding) => ({ ...finding }));
		if (event.reviewAcceptedFindings !== undefined) this.current.reviewAcceptedFindings = event.reviewAcceptedFindings.map((finding) => ({ ...finding }));
		if (event.reviewScopePaths !== undefined) this.current.reviewScopePaths = [...event.reviewScopePaths];
		if (event.reviewScopeRevisions !== undefined) this.current.reviewScopeRevisions = event.reviewScopeRevisions.map((revision) => ({ ...revision }));
		if (event.reviewAcceptedRevisions !== undefined) this.current.reviewAcceptedRevisions = event.reviewAcceptedRevisions.map((revision) => ({ ...revision }));
		if (event.reviewCorrectionCount !== undefined) this.current.reviewCorrectionCount = event.reviewCorrectionCount;
		if (event.reviewSupersessionCount !== undefined) this.current.reviewSupersessionCount = event.reviewSupersessionCount;
		if (event.reviewCorrectionLimit !== undefined) this.current.reviewCorrectionLimit = event.reviewCorrectionLimit;
		if (event.kind === "completion_latch_cleared") {
			this.current.completionLatchCandidateId = undefined;
			this.current.completionLatchReviewStatus = undefined;
		} else if (event.completionLatchCandidateId !== undefined) {
			this.current.completionLatchCandidateId = event.completionLatchCandidateId;
			this.current.completionLatchReviewStatus = event.completionLatchReviewStatus;
		}
		if (event.completionId !== undefined) this.current.completionId = event.completionId;
		if (event.completionEffectsStatus !== undefined) this.current.completionEffectsStatus = event.completionEffectsStatus;
		if (event.completionAudit !== undefined) this.current.completionAudit = event.completionAudit.map((item) => ({ ...item }));
		if (event.kind === "settled") {
			this.current.blockerFingerprint = event.blockerFingerprint;
			this.current.blockerCount = event.blockerCount ?? 0;
		}
		if (event.kind === "progress" && event.summary) {
			this.progress.push({
				missionId: event.missionId,
				at: event.at,
				summary: event.summary,
				evidence: normalizeProgressList(event.evidence, 20),
				remaining: normalizeProgressList(event.remaining, 20),
				validation: normalizeValidation(event.validation, this.current.objectiveVersion ?? 1),
				checkpoint: event.checkpoint === true,
				blocked: event.blocked === true,
				blockerId: event.blockerId,
			});
		}
	}
}

function takeoverStatus(snapshot: MissionSnapshot): MissionStatus {
	const mission = snapshot.mission;
	if ((mission.reviewCorrectionCount ?? 0) > (mission.reviewCorrectionLimit ?? DEFAULT_REVIEW_CORRECTION_LIMIT)) return "blocked";
	if ((mission.tokenBudget !== undefined && snapshot.usage.totalTokens >= mission.tokenBudget) || (mission.costBudgetUsd !== undefined && snapshot.usage.totalCostUsd >= mission.costBudgetUsd)) return "budget_limited";
	if ((mission.turnBudget !== undefined && (mission.turnCount ?? 0) >= mission.turnBudget) || (mission.wallDeadlineAt !== undefined && Date.now() >= mission.wallDeadlineAt)) return "usage_limited";
	return "active";
}

function latestMissionAnchor(branch: Array<any>): { kind: "created" | "taken_over"; missionId: string; slug: string } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		const event = entry?.type === "custom" && entry.customType === MISSION_CUSTOM_TYPE ? entry.data as MissionEvent | undefined : undefined;
		if ((event?.kind === "created" || event?.kind === "taken_over") && event.missionId && event.slug) return { kind: event.kind, missionId: event.missionId, slug: event.slug };
	}
	return undefined;
}

function onlyOwnedMission(snapshots: MissionSnapshot[], sessionId: string): MissionSnapshot | undefined {
	const owned = snapshots.filter((snapshot) => snapshot.owner.sessionId === sessionId && !["complete", "cleared"].includes(snapshot.mission.status));
	if (owned.length > 1) throw new Error(`Session controls multiple nonterminal Missions: ${owned.map((snapshot) => snapshot.mission.missionId).join(", ")}`);
	return owned[0];
}

function addUsage(left: MissionUsage, right: MissionUsage): MissionUsage {
	return {
		mainTokens: left.mainTokens + right.mainTokens,
		subagentTokens: left.subagentTokens + right.subagentTokens,
		totalTokens: left.totalTokens + right.totalTokens,
		mainCostUsd: left.mainCostUsd + right.mainCostUsd,
		subagentCostUsd: left.subagentCostUsd + right.subagentCostUsd,
		totalCostUsd: left.totalCostUsd + right.totalCostUsd,
	};
}

function cloneProgress(progress: MissionProgressRecord[]): MissionProgressRecord[] {
	return progress.map((item) => ({ ...item, evidence: [...item.evidence], remaining: [...item.remaining], validation: item.validation.map((value) => ({ ...value })) }));
}

async function chooseDefaultChain(cwd: string, title: string, slug: string): Promise<string> {
	const chains = await new ChainService(cwd).list().catch(() => []);
	const matches = chains.filter((item) => chainMatches(item.chain, title, slug));
	if (matches.length === 1) return matches[0]!.chain;
	return `mission-${slug}`.slice(0, 60);
}

function chainMatches(chain: string, _title: string, slug: string): boolean {
	return chain.toLowerCase() === slug;
}

function normalizeTitle(value: string | undefined): string | undefined {
	const title = value?.trim().replace(/\s+/g, " ");
	return title ? title.slice(0, 80) : undefined;
}

function inferRequirements(objective: string): string[] {
	return normalizeRequirements([objective]);
}

function normalizeProgressList(values: string[] | undefined, maxItems: number): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values ?? []) {
		const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 500);
		if (!cleaned) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(cleaned);
		if (result.length >= maxItems) break;
	}
	return result;
}

function assertInputLimits(requirements: string[] | undefined, paths: string[] | undefined): void {
	if ((requirements?.length ?? 0) > MAX_REQUIREMENTS) throw new Error(`Mission requirements are limited to ${MAX_REQUIREMENTS}.`);
	if ((paths?.length ?? 0) > MAX_PATHS) throw new Error(`Mission paths are limited to ${MAX_PATHS}.`);
}

function normalizePaths(values: string[] | undefined): string[] {
	const result: string[] = [];
	for (const value of values ?? []) {
		const path = normalizePath(value.trim()).replaceAll("\\", "/");
		if (!path || path === "." || isAbsolute(path) || path === ".." || path.startsWith("../")) throw new Error(`Mission path must stay relative to the project: ${value}`);
		if (!result.includes(path)) result.push(path);
	}
	return result;
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedRight = [...right].sort();
	return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function normalizeValidation(values: Array<MissionValidationInput | MissionValidationRecord> | undefined, objectiveVersion: number): MissionValidationRecord[] {
	return (values ?? []).slice(0, 20).flatMap((value) => {
		const command = value.command?.trim().replace(/\s+/g, " ").slice(0, 500);
		if (!command || !Number.isInteger(value.exitCode)) return [];
		const summary = value.summary?.trim().replace(/\s+/g, " ").slice(0, 500);
		const artifact = value.artifact?.trim().slice(0, 500);
		const version = "objectiveVersion" in value && Number.isInteger(value.objectiveVersion) ? value.objectiveVersion : objectiveVersion;
		return [{ command, exitCode: value.exitCode, objectiveVersion: version, ...(summary ? { summary } : {}), ...(artifact ? { artifact } : {}) }];
	});
}

function normalizeRequirements(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const cleaned = value.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "").replace(/\s+/g, " ").slice(0, 240);
		if (!cleaned) continue;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(cleaned);
	}
	return result;
}

function deriveMissionTitle(objective: string, requirements: string[]): string {
	const source = requirements[0] ?? objective;
	const words = source.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
	const title = words.length ? words.slice(0, 6).map(titleCaseWord).join(" ") : "Mission";
	return title.slice(0, 80);
}

function titleCaseWord(word: string): string {
	return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
}

function positiveNumber(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive when provided.`);
	return value;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
	const positive = positiveNumber(value, name);
	return positive === undefined ? undefined : Math.floor(positive);
}

function usageFromAggregate(aggregate: MissionUsage, mission: MissionCurrent): MissionUsage {
	const usage: MissionUsage = {
		mainTokens: Math.max(0, aggregate.mainTokens - mission.baselineMainTokens),
		subagentTokens: Math.max(0, aggregate.subagentTokens - mission.baselineSubagentTokens),
		totalTokens: 0,
		mainCostUsd: Math.max(0, aggregate.mainCostUsd - mission.baselineMainCostUsd),
		subagentCostUsd: Math.max(0, aggregate.subagentCostUsd - mission.baselineSubagentCostUsd),
		totalCostUsd: 0,
	};
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
	return usage;
}

function aggregateUsage(branch: Array<any>, cutoffMs?: number): MissionUsage {
	const seenSubagents = new Set<string>();
	const usage = zeroUsage();
	for (const entry of branch) {
		if (cutoffMs !== undefined && entryTimestampMs(entry) > cutoffMs) continue;
		addUsageFromEntry(usage, entry, seenSubagents);
	}
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
	return usage;
}

function addUsageFromEntry(usage: MissionUsage, entry: any, seenSubagents: Set<string>): void {
	if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) addMainUsage(usage, entry.message.usage);
	const runtimeEvent = entry.type === "custom" && entry.customType === "deevs.runtime-event-op.v1" && entry.data?.type === "emit" ? entry.data.event : undefined;
	if (runtimeEvent?.source?.kind === "subagent" && runtimeEvent.usage) {
		const key = `${runtimeEvent.source.id}:${runtimeEvent.source.generation ?? "legacy"}`;
		if (!seenSubagents.has(key)) {
			seenSubagents.add(key);
			usage.subagentTokens += numberValue(runtimeEvent.usage.inputTokens) + numberValue(runtimeEvent.usage.outputTokens) + numberValue(runtimeEvent.usage.cacheWriteTokens);
			usage.subagentCostUsd += numberValue(runtimeEvent.usage.costUsd);
		}
	}
	const details = entry.type === "custom_message" && entry.customType === "subagents" ? entry.details : entry.type === "message" && entry.message?.role === "toolResult" ? entry.message.details : undefined;
	addSubagentUsageFromDetails(usage, details, seenSubagents);
	usage.totalTokens = usage.mainTokens + usage.subagentTokens;
	usage.totalCostUsd = usage.mainCostUsd + usage.subagentCostUsd;
}

function entryTimestampMs(entry: any): number {
	const timestamp = Date.parse(entry?.timestamp ?? "");
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function addMainUsage(target: MissionUsage, raw: any): void {
	target.mainTokens += billableTokens(raw);
	target.mainCostUsd += numberValue(raw.cost?.total);
}

function addSubagentUsageFromDetails(target: MissionUsage, details: any, seen: Set<string>): void {
	const runs = [details?.run, ...(Array.isArray(details?.runs) ? details.runs : [])].filter(Boolean);
	if (details?.group?.usage && details.group.id && !seen.has(details.group.id)) {
		seen.add(details.group.id);
		target.subagentTokens += billableTokens(details.group.usage);
		target.subagentCostUsd += numberValue(details.group.usage.cost?.total);
	}
	for (const run of runs) {
		if (!run?.id || !run.usage || seen.has(run.id)) continue;
		seen.add(run.id);
		target.subagentTokens += billableTokens(run.usage);
		target.subagentCostUsd += numberValue(run.usage.cost?.total);
	}
}

function billableTokens(raw: any): number {
	const input = numberValue(raw?.input ?? raw?.inputTokens);
	const cacheWrite = numberValue(raw?.cacheWrite ?? raw?.cacheCreationInputTokens);
	const output = numberValue(raw?.output ?? raw?.outputTokens);
	const computed = Math.max(0, input) + Math.max(0, cacheWrite) + Math.max(0, output);
	return computed || numberValue(raw?.totalTokens ?? raw?.total);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function zeroUsage(): MissionUsage {
	return { mainTokens: 0, subagentTokens: 0, totalTokens: 0, mainCostUsd: 0, subagentCostUsd: 0, totalCostUsd: 0 };
}
