export type JobStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "timeout" | "lost";
export type JobStream = "stdout" | "stderr";

export interface JobChunk {
	seq: number;
	at: number;
	stream: JobStream;
	text: string;
	bytes: number;
}

export interface JobSpec {
	id: string;
	generation: string;
	name: string;
	command?: string;
	argv?: string[];
	cwd: string;
	timeoutMs: number;
	maxBufferBytes: number;
	readyPattern?: string;
	readyMode?: "substring" | "regex";
	readyTimeoutMs?: number;
	createdAt: number;
	/** Exact parent Pi session that owns this durable Job. Legacy records may omit it. */
	parentSessionFile?: string;
	artifactsDir: string;
	runtimePath: string;
	logPath: string;
	spoolPath: string;
}

export interface JobRuntime {
	version: 1;
	id: string;
	status: JobStatus;
	pid?: number;
	processIdentity?: string;
	startedAt: number;
	heartbeatAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	exitSignal?: string | null;
	ready: boolean;
	readyAt?: number;
	lastOutputAt?: number;
	bufferedBytes: number;
	droppedBytes: number;
	logBytes: number;
	logTruncated: boolean;
	spoolBytes: number;
	spoolTruncated: boolean;
	error?: string;
}

export interface JobRecord {
	spec: JobSpec;
	runtime: JobRuntime;
}

export interface JobStartInput {
	name: string;
	command?: string;
	argv?: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	readyPattern?: string;
	readyMode?: "substring" | "regex";
	readyTimeoutMs?: number;
	stdin?: string;
	maxBytes?: number;
}

export interface JobReadInput {
	id: string;
	afterSeq?: number;
	maxBytes?: number;
	stream?: "stdout" | "stderr" | "combined";
}

export interface JobReadResult {
	job: JobRecord;
	chunks: JobChunk[];
	nextSeq: number;
	earliestSeq: number;
	truncated: boolean;
	droppedBeforeSeq?: number;
}
