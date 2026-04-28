import type { ReadResult } from "../processes/types.ts";
import type { ChainContextInput } from "../chains/types.ts";

export type AgentMode = "advisory" | "executor";
export type AgentContextMode = "fresh" | "fork";
export type AgentRunStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "timeout";
export type AgentGroupStatus = "running" | "completed" | "partial" | "failed" | "cancelled";
export type AgentLogSource = "result" | "task" | "system-prompt" | "metadata" | "combined" | "stdout" | "stderr";

export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	mode: AgentMode;
	write: boolean;
	model?: string;
	tags: string[];
	disabled: boolean;
	body: string;
	filePath: string;
}

export interface AgentsSettings {
	allowedModels: string[];
	defaultModel?: string;
	modelsByAgent: Record<string, string>;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	parallelDefaultConcurrency: number;
	parallelMaxConcurrency: number;
	dockEnabled: boolean;
	dockHeight: number;
	defaultAllowWrite: boolean;
	notifyOnTerminal: boolean;
	wakeOnCompletion: boolean;
	wakeOnFailure: boolean;
	wakeOnTimeout: boolean;
	maxCompletedRecords: number;
}

export interface AgentStartInput {
	agent: string;
	task: string;
	cwd?: string;
	context?: AgentContextMode;
	model?: string;
	tools?: string[];
	allowWrite?: boolean;
	timeoutMs?: number;
	maxBytes?: number;
	chainContext?: ChainContextInput;
}

export interface AgentParallelTaskInput {
	agent: string;
	task: string;
	model?: string;
	tools?: string[];
	allowWrite?: boolean;
	context?: AgentContextMode;
	chainContext?: ChainContextInput;
}

export interface AgentParallelStartInput {
	tasks: AgentParallelTaskInput[];
	concurrency?: number;
	failFast?: boolean;
	timeoutMs?: number;
	maxBytesPerAgent?: number;
}

export interface AgentReadInput {
	id: string;
	afterSeq?: number;
	waitMs?: number;
	maxBytes?: number;
	stream?: "combined" | "stdout" | "stderr";
	raw?: boolean;
}

export interface AgentStatusInput {
	id?: string;
	includeCompleted?: boolean;
}

export interface AgentStopInput {
	id: string;
	signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
	timeoutMs?: number;
}

export interface AgentLogsInput {
	id: string;
	source?: AgentLogSource;
	maxBytes?: number;
	raw?: boolean;
}

export interface AgentClearInput {
	id?: string;
	allCompleted?: boolean;
	deleteArtifacts?: boolean;
}

export interface AgentRunRecord {
	id: string;
	procId: string | null;
	groupId?: string;
	agent: string;
	task: string;
	status: AgentRunStatus;
	startedAt: number;
	endedAt?: number;
	cwd: string;
	context: AgentContextMode;
	model?: string;
	tools: string[];
	allowWrite: boolean;
	artifactsDir: string;
	resultPath: string;
	taskPath: string;
	systemPromptPath: string;
	metadataPath: string;
	timeoutMs: number;
	timedOut?: boolean;
	cancelRequested?: boolean;
	terminalNotified?: boolean;
	timer?: NodeJS.Timeout;
	lastSeq?: number;
	finalOutput?: string;
	extractionWarning?: string;
	chainContext?: ChainContextInput;
}

export interface AgentGroupRecord {
	id: string;
	mode: "parallel";
	status: AgentGroupStatus;
	startedAt: number;
	endedAt?: number;
	children: string[];
	pending: AgentParallelTaskInput[];
	concurrency: number;
	failFast: boolean;
	failFastTriggered?: boolean;
	cancelRequested?: boolean;
	skippedCount?: number;
	activeCount: number;
	cwd: string;
	artifactsDir: string;
	metadataPath: string;
	resultPath: string;
	timeoutMs: number;
	maxBytesPerAgent?: number;
	terminalNotified?: boolean;
}

export interface AgentStartResult {
	id: string;
	procId: string | null;
	agent: string;
	task: string;
	status: AgentRunStatus;
	startedAt: number;
	cwd: string;
	artifactsDir: string;
	logs?: {
		combined?: string | null;
		stdout?: string | null;
		stderr?: string | null;
	};
	output?: string;
	nextSeq?: number;
}

export interface AgentParallelStartResult {
	groupId: string;
	status: AgentGroupStatus;
	mode: "parallel";
	runs: Array<{ id: string; procId: string | null; agent: string; task: string; status: AgentRunStatus }>;
}

export interface AgentReadResult {
	id: string;
	type: "run" | "group";
	status: AgentRunStatus | AgentGroupStatus;
	output: string;
	raw?: ReadResult;
	nextSeq?: number;
	truncated?: boolean;
}
