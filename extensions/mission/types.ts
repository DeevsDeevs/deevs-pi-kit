export type MissionStatus = "active" | "paused" | "blocked" | "terminal_error" | "budget_limited" | "usage_limited"
	| "complete" | "ended" | "cleared";
export type MissionReviewStatus = "not_required" | "due" | "starting" | "running" | "awaiting_adjudication"
	| "changes_requested" | "clear" | "skipped";
export type MissionConvergedReviewStatus = "not_required" | "clear" | "skipped";
export type MissionReviewSeverity = "blocker" | "major" | "minor" | "nit";
export type MissionReviewVerdict = "clear" | "changes_requested";
export type MissionReviewOutcome = "superseded" | "failed";
export type MissionReviewCriticalImpact = "security" | "data_loss";
export interface MissionReviewFinding {
	index: number;
	severity: MissionReviewSeverity;
	summary: string;
	path?: string;
	line?: number;
	requirementIndex?: number;
	criticalImpact?: MissionReviewCriticalImpact;
}
export interface MissionReviewRevision { root: string; base: string; head: string }
export const MAX_MISSION_REVIEW_ADJUDICATIONS = 256;

export interface MissionReviewAdjudicationEntry {
	candidateId: string;
	verdict: MissionReviewVerdict;
}

/** Current review lifecycle status plus reviewer admission bookkeeping. */
export interface MissionReviewAdmission {
	status: MissionReviewStatus;
	initialBaselinePending: boolean;
	supersessionCount: number;
	updatedAt?: number;
	runId?: string;
	admissionId?: string;
	reason?: string;
	skippedReason?: string;
	failure?: boolean;
	outcome?: MissionReviewOutcome;
	notBeforeAt?: number;
}

/** The exact objective/scope/workspace candidate the current review admission targets. */
export interface MissionReviewCandidate {
	id?: string;
	objectiveVersion?: number;
	worktreeFingerprint?: string;
	admittedWorktreeFingerprint?: string;
	scopePaths?: string[];
	scopeRevisions?: MissionReviewRevision[];
}

/** The parent's adjudication of the latest reviewer run, and the durable candidate history. */
export interface MissionReviewAdjudication {
	history: MissionReviewAdjudicationEntry[];
	suggestedVerdict?: MissionReviewVerdict | "unknown";
	adjudicatedCandidateId?: string;
	adjudicatedVerdict?: MissionReviewVerdict;
	historyComplete?: true;
}

export interface MissionReviewFindings {
	blockingCount: number;
	backlogCount: number;
	highestSeverity?: MissionReviewSeverity;
	items?: MissionReviewFinding[];
	accepted?: MissionReviewFinding[];
}

/** Bounded correction-cycle policy and the revision baseline corrections diff against. */
export interface MissionReviewCorrection {
	count: number;
	limit: number;
	acceptedRevisions?: MissionReviewRevision[];
}

/** User authorization to complete one exact candidate once its review disposition converges. */
export interface MissionCompletionLatch {
	candidateId?: string;
	reviewStatus?: MissionConvergedReviewStatus;
}

export interface MissionReview {
	admission: MissionReviewAdmission;
	candidate: MissionReviewCandidate;
	adjudication: MissionReviewAdjudication;
	findings: MissionReviewFindings;
	correction: MissionReviewCorrection;
	completionLatch: MissionCompletionLatch;
}

export interface MissionRequirementAudit {
	requirementIndex: number;
	evidence: string;
}

export interface MissionValidationInput {
	command: string;
	exitCode: number;
	summary?: string;
	artifact?: string;
}

export interface MissionValidationRecord extends MissionValidationInput {
	objectiveVersion: number;
}

export type MissionEventKind =
	| "created"
	| "taken_over"
	| "status_changed"
	| "continued"
	| "completed"
	| "completion_effects_done"
	| "completion_latched"
	| "completion_latch_cleared"
	| "progress"
	| "objective_updated"
	| "review_changed"
	| "review_policy_updated"
	| "workspace_fingerprinted"
	| "settled";

export interface MissionUsage {
	mainTokens: number;
	subagentTokens: number;
	totalTokens: number;
	mainCostUsd: number;
	subagentCostUsd: number;
	totalCostUsd: number;
}

export interface MissionEvent {
	kind: MissionEventKind;
	missionId: string;
	at: number;
	objective?: string;
	title?: string;
	requirements?: string[];
	status?: MissionStatus;
	reason?: string;
	summary?: string;
	evidence?: string[];
	remaining?: string[];
	validation?: MissionValidationRecord[];
	checkpoint?: boolean;
	blocked?: boolean;
	blockerId?: string;
	slug?: string;
	chain?: string;
	chainBranch?: string;
	artifactDir?: string;
	paths?: string[];
	tokenBudget?: number | null;
	costBudgetUsd?: number | null;
	baselineMainTokens?: number;
	baselineSubagentTokens?: number;
	baselineMainCostUsd?: number;
	baselineSubagentCostUsd?: number;
	generation?: string;
	objectiveVersion?: number;
	turnBudget?: number | null;
	wallDeadlineAt?: number | null;
	reviewStatus?: MissionReviewStatus;
	initialBaselinePending?: boolean;
	reviewUpdatedAt?: number;
	reviewRunId?: string;
	reviewAdmissionId?: string;
	reviewReason?: string;
	reviewSkippedReason?: string;
	reviewSuggestedVerdict?: MissionReviewVerdict | "unknown";
	reviewFailure?: boolean;
	reviewOutcome?: MissionReviewOutcome;
	reviewNotBeforeAt?: number;
	reviewSupersessionCount?: number;
	reviewWorktreeFingerprint?: string;
	admittedWorktreeFingerprint?: string;
	reviewCandidateId?: string;
	reviewCandidateObjectiveVersion?: number;
	reviewAdjudicatedCandidateId?: string;
	reviewAdjudicatedVerdict?: MissionReviewVerdict;
	reviewAdjudications?: Array<{ candidateId: string; verdict: MissionReviewVerdict }>;
	reviewAdjudicationHistoryComplete?: true;
	reviewHighestSeverity?: MissionReviewSeverity;
	reviewBlockingFindingCount?: number;
	reviewBacklogFindingCount?: number;
	reviewFindings?: MissionReviewFinding[];
	reviewAcceptedFindings?: MissionReviewFinding[];
	reviewScopePaths?: string[];
	reviewScopeRevisions?: MissionReviewRevision[];
	reviewAcceptedRevisions?: MissionReviewRevision[];
	reviewCorrectionCount?: number;
	reviewCorrectionLimit?: number;
	completionLatchCandidateId?: string;
	completionLatchReviewStatus?: MissionConvergedReviewStatus;
	completionId?: string;
	completionEffectsStatus?: "pending" | "done";
	completionAudit?: MissionRequirementAudit[];
	expectedObjectiveVersion?: number;
	blockerFingerprint?: string;
	blockerCount?: number;
	turnCount?: number;
	ownerSessionId?: string;
	previousOwnerSessionId?: string;
}

export interface MissionProgressRecord {
	missionId: string;
	at: number;
	summary: string;
	evidence: string[];
	remaining: string[];
	validation: MissionValidationRecord[];
	checkpoint: boolean;
	blocked: boolean;
	blockerId?: string;
}

export interface MissionCurrent {
	missionId: string;
	objective: string;
	title: string;
	requirements: string[];
	status: MissionStatus;
	createdAt: number;
	updatedAt: number;
	slug: string;
	chain: string;
	chainBranch: string;
	artifactDir: string;
	paths: string[];
	tokenBudget?: number;
	costBudgetUsd?: number;
	baselineMainTokens: number;
	baselineSubagentTokens: number;
	baselineMainCostUsd: number;
	baselineSubagentCostUsd: number;
	lastReason?: string;
	lastSummary?: string;
	lastContinuationAt?: number;
	generation?: string;
	objectiveVersion?: number;
	turnBudget?: number;
	wallDeadlineAt?: number;
	review: MissionReview;
	completionId?: string;
	completionEffectsStatus?: "pending" | "done";
	completionAudit?: MissionRequirementAudit[];
	blockerFingerprint?: string;
	blockerCount?: number;
	turnCount?: number;
}

export interface MissionOwner {
	sessionId: string;
	sessionFile: string;
}

export interface MissionSnapshot {
	version: 2;
	revision: number;
	owner: MissionOwner;
	mission: MissionCurrent;
	progress: MissionProgressRecord[];
	continuationProgressIndex: number;
	carriedUsage: MissionUsage;
	usage: MissionUsage;
	reviewFailureCount: number;
	usageComplete: boolean;
}

export interface MissionTakeoverInput {
	missionId: string;
	reason: string;
}

export interface MissionTakeoverCandidate {
	snapshot: MissionSnapshot;
	source: "snapshot";
}

export interface MissionCreateInput {
	objective: string;
	title?: string;
	requirements?: string[];
	paths?: string[];
	tokenBudget?: number;
	costBudgetUsd?: number;
	turnBudget?: number;
	wallDeadlineMs?: number;
	chain?: string;
	chainBranch?: string;
}

export interface MissionUpdateInput {
	objective?: string;
	requirements?: string[];
	paths?: string[];
	tokenBudget?: number | null;
	costBudgetUsd?: number | null;
	turnBudget?: number | null;
	wallDeadlineMs?: number | null;
	reason: string;
}

export interface MissionProgressInput {
	summary: string;
	evidence?: string[];
	remaining?: string[];
	validation?: MissionValidationInput[];
	checkpoint?: boolean;
	blocked?: boolean;
	blockerId?: string;
	reviewSkip?: boolean;
	reviewSkipReason?: string;
	reviewVerdict?: "clear" | "changes_requested";
	reviewRunId?: string;
	reviewReason?: string;
	reviewContinue?: boolean;
	reviewContinueReason?: string;
}

export interface MissionSearchInput {
	query: string;
	maxResults?: number;
}

export interface MissionCompleteInput {
	summary?: string;
	audit?: MissionRequirementAudit[];
	userRequested?: boolean;
	authorizeCompletion?: boolean;
}
