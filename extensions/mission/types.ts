export type MissionStatus = "active" | "paused" | "blocked" | "terminal_error" | "budget_limited" | "usage_limited" | "complete" | "cleared";
export type MissionReviewStatus = "not_required" | "due" | "running" | "awaiting_adjudication" | "changes_requested" | "clear" | "skipped";
export type MissionEventKind = "created" | "status_changed" | "continued" | "completed" | "progress" | "objective_updated" | "review_changed" | "settled";

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
	validation?: string[];
	checkpoint?: boolean;
	slug?: string;
	chain?: string;
	chainBranch?: string;
	artifactDir?: string;
	tokenBudget?: number;
	costBudgetUsd?: number;
	baselineMainTokens?: number;
	baselineSubagentTokens?: number;
	baselineMainCostUsd?: number;
	baselineSubagentCostUsd?: number;
	generation?: string;
	objectiveVersion?: number;
	turnBudget?: number;
	wallDeadlineAt?: number;
	reviewStatus?: MissionReviewStatus;
	reviewRunId?: string;
	reviewReason?: string;
	reviewSkippedReason?: string;
	blockerFingerprint?: string;
	blockerCount?: number;
	turnCount?: number;
}

export interface MissionProgressRecord {
	missionId: string;
	at: number;
	summary: string;
	evidence: string[];
	remaining: string[];
	validation: string[];
	checkpoint: boolean;
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
	blockerFingerprint?: string;
	blockerCount?: number;
	turnCount?: number;
}

export interface MissionCreateInput {
	objective: string;
	title?: string;
	requirements?: string[];
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
	reason: string;
}

export interface MissionProgressInput {
	summary: string;
	evidence?: string[];
	remaining?: string[];
	validation?: string[];
	checkpoint?: boolean;
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
	audit?: Array<{ requirement: string; evidence: string }>;
	userRequested?: boolean;
}
