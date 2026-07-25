import type { RuntimeUsage } from "../shared/runtime-events.ts";

export type DelegateRunStatus =
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "partial"
	| "failed"
	| "cancelled"
	| "timeout"
	| "limited"
	| "needs_attention"
	| "lost";

export type DelegateLimitReason = "wall" | "turns" | "tokens" | "cost" | "protocol_output";

export interface DelegateRunSpec {
	id: string;
	agentId: string;
	generation: string;
	persona: string;
	personaVersion: string;
	task: string;
	cwd: string;
	tools: string[];
	allowWrite: boolean;
	deliverTerminal: boolean;
	model?: string;
	execution: { command: string; args: string[] };
	context: "fresh" | "fork" | "resume";
	forkSessionFile?: string;
	resumeSessionFile?: string;
	createdAt: number;
	limits: {
		wallMs: number;
		turns?: number;
		tokens?: number;
		costUsd?: number;
		maxProtocolLineBytes: number;
		maxStderrBytes: number;
	};
	artifactsDir: string;
	sessionDir: string;
	systemPromptPath: string;
	taskPath: string;
	transcriptPath: string;
	resultPath: string;
	runtimePath: string;
}

export interface DelegateRunRuntime {
	version: 1;
	id: string;
	status: DelegateRunStatus;
	workerPid?: number;
	workerIdentity?: string;
	childPid?: number;
	childIdentity?: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	exitSignal?: string | null;
	settled: boolean;
	turns: number;
	usage: RuntimeUsage;
	currentTool?: string;
	lastActivityAt: number;
	output?: string;
	error?: string;
	limitReason?: DelegateLimitReason;
	sessionFile?: string;
}

export interface DelegateRun {
	spec: DelegateRunSpec;
	runtime: DelegateRunRuntime;
}

export interface DelegateStartInput {
	persona: string;
	personaBody: string;
	personaTools: string[];
	task: string;
	cwd: string;
	allowWrite?: boolean;
	deliverTerminal?: boolean;
	tools?: string[];
	model?: string;
	context?: "fresh" | "fork";
	forkSessionFile?: string;
	detach?: boolean;
	wallMs?: number;
	turns?: number;
	tokens?: number;
	costUsd?: number;
}

export interface DelegateResumeInput {
	runId: string;
	task: string;
	detach?: boolean;
	wallMs?: number;
	turns?: number;
	tokens?: number;
	costUsd?: number;
}

export interface DelegateExecutorOptions {
	artifactsRoot?: string;
	command?: (spec: DelegateRunSpec) => { command: string; args: string[] };
	now?: () => number;
}
