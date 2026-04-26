import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessLogWriter } from "./logs.ts";
import type { RuntimeWatch } from "./watches.ts";

export type ProcessStatus =
	| "starting"
	| "running"
	| "exited"
	| "signaled"
	| "failed"
	| "killing"
	| "kill_timeout"
	| "orphaned"
	| "unknown";

export type ProcessBackend = "pipe" | "pty" | "tmux";
export type OutputStream = "stdout" | "stderr";
export type ReadStreamFilter = OutputStream | "combined";
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface OutputChunk {
	seq: number;
	time: number;
	stream: OutputStream;
	text: string;
	byteLength: number;
}

export interface ProcessStats {
	stdoutBytes: number;
	stderrBytes: number;
	droppedBytes: number;
	bufferedBytes: number;
	logBytes: number;
	lastOutputAt: number | null;
}

export interface AlertPolicy {
	alertOnExit: boolean;
	alertOnFailure: boolean;
	alertOnReady: boolean;
}

export interface WatchSpec {
	pattern: string;
	mode?: "substring" | "regex";
	stream?: "stdout" | "stderr" | "both";
	repeat?: boolean;
	triggerTurn?: boolean;
}

export interface ProcessManagerEvent {
	type: "watch_match" | "process_exit";
	process: ManagedProcessInfo;
	pattern?: string;
	text?: string;
	triggerTurn: boolean;
}

export interface ManagedProcessInfo {
	id: string;
	name: string;
	command: string | null;
	argv: string[] | null;
	cwd: string;
	backend: ProcessBackend;
	pid: number | null;
	pgid: number | null;
	status: ProcessStatus;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	signal: string | null;
	stdinOpen: boolean;
	persistent: boolean;
	logFile: string | null;
	stdoutLogFile: string | null;
	stderrLogFile: string | null;
	alertPolicy: AlertPolicy;
	stats: ProcessStats;
}

export interface ReadResult {
	id: string;
	status: ProcessStatus;
	chunks: OutputChunk[];
	nextSeq: number;
	earliestSeq: number;
	exited: boolean;
	exitCode: number | null;
	signal: string | null;
	truncated: boolean;
	droppedBeforeSeq: number | null;
}

export interface StartProcessInput {
	name: string;
	command?: string;
	argv?: string[];
	cwd?: string;
	waitMs?: number;
	maxBytes?: number;
	backend?: "pipe" | "pty";
	env?: Record<string, string>;
	persistent?: boolean;
	alertOnExit?: boolean;
	alertOnFailure?: boolean;
	alertOnReady?: boolean;
	watches?: WatchSpec[];
}

export interface ReadProcessInput {
	id: string;
	afterSeq?: number;
	waitMs?: number;
	maxBytes?: number;
	stream?: ReadStreamFilter;
}

export interface SignalProcessInput {
	id: string;
	signal: ProcessSignal;
	tree?: boolean;
	timeoutMs?: number;
}

export interface WriteProcessInput {
	id: string;
	input: string;
	end?: boolean;
}

export interface ListProcessInput {
	includeExited?: boolean;
	includePersistent?: boolean;
}

export interface LogsProcessInput {
	id: string;
	stream?: "stdout" | "stderr" | "combined";
	maxBytes?: number;
}

export interface ClearProcessInput {
	id?: string;
	allExited?: boolean;
	deleteLogs?: boolean;
}

export interface StartProcessResult {
	process: ManagedProcessInfo;
	output: ReadResult;
}

export interface SpawnSpec {
	command?: string;
	argv?: string[];
	cwd: string;
	env?: Record<string, string>;
}

export interface SpawnedProcess {
	child: ChildProcessWithoutNullStreams;
	pid: number;
	pgid: number;
}

export interface ManagedProcessInternal extends ManagedProcessInfo {
	child: ChildProcessWithoutNullStreams | null;
	logWriter: ProcessLogWriter | null;
	watches: RuntimeWatch[];
}
