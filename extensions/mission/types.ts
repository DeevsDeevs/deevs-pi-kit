export type MissionStatus = "active" | "paused" | "blocked" | "terminal_error" | "budget_limited" | "usage_limited" | "complete" | "ended" | "cleared";
export type MissionReviewStatus = "not_required" | "due" | "running" | "awaiting_adjudication" | "changes_requested" | "clear" | "skipped";

export interface MissionValidationInput {
	command: string;
	exitCode: number;
	summary?: string;
	artifact?: string;
}

export interface MissionValidationRecord extends MissionValidationInput {
	objectiveVersion: number;
}

export type MissionEventKind = "created" | "taken_over" | "status_changed" | "continued" | "completed" | "progress" | "objective_updated" | "review_changed" | "workspace_fingerprinted" | "settled";

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
	reviewRunId?: string;
	reviewReason?: string;
	reviewSkippedReason?: string;
	reviewSuggestedVerdict?: "clear" | "changes_requested" | "unknown";
	reviewFailure?: boolean;
	reviewWorktreeFingerprint?: string;
	admittedWorktreeFingerprint?: string;
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
	reviewStatus?: MissionReviewStatus;
	reviewRunId?: string;
	reviewReason?: string;
	reviewSkippedReason?: string;
	reviewSuggestedVerdict?: "clear" | "changes_requested" | "unknown";
	reviewFailure?: boolean;
	reviewWorktreeFingerprint?: string;
	admittedWorktreeFingerprint?: string;
	blockerFingerprint?: string;
	blockerCount?: number;
	turnCount?: number;
}

export interface MissionOwner {
	sessionId: string;
	sessionFile: string;
}

export interface MissionSnapshot {
	version: 1;
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
	source: "snapshot" | "legacy_session";
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
}

export interface MissionSearchInput {
	query: string;
	maxResults?: number;
}

export interface MissionCompleteInput {
	summary?: string;
	audit?: Array<{ requirementIndex: number; evidence: string }>;
	userRequested?: boolean;
}
