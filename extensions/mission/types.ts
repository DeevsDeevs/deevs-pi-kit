export type MissionStatus = "active" | "paused" | "budget_limited" | "complete" | "stuck" | "cleared";
export type MissionEventKind = "created" | "status_changed" | "continued" | "completed" | "artifact_updated";

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
}

export interface MissionCreateInput {
	objective: string;
	title?: string;
	requirements?: string[];
	tokenBudget?: number;
	costBudgetUsd?: number;
	chain?: string;
	chainBranch?: string;
}

export interface MissionCompleteInput {
	summary?: string;
	audit?: Array<{ requirement: string; evidence: string }>;
}
