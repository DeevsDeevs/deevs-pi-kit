export const BRIDGE_RUNNER_MAX_TURNS = 1_000;
export const BRIDGE_RUNNER_MAX_BODY_BYTES = 16 * 1024;
export const BRIDGE_RUNNER_MAX_LINE_BYTES = 256 * 1024;
export const BRIDGE_RUNNER_MAX_STDOUT_BYTES = 1024 * 1024;
export const BRIDGE_RUNNER_MAX_STDERR_BYTES = 256 * 1024;
export const BRIDGE_RUNNER_MAX_FRAMES = 1_000;
export const BRIDGE_RUNNER_MAX_STATE_BYTES = 4 * 1024 * 1024;

export type BridgeExecutionState = "pending" | "starting" | "running" | "terminal" | "reply_pending" | "reply_sent" | "needs_attention";
export type BridgeSessionAdvance = "none" | "committed" | "uncertain";
export type BridgeTerminalStatus = "completed" | "failed" | "cancelled";

export interface BridgeClaimReceipt {
	claimId: string;
	eventIds: string[];
}

export interface BridgeAdmission {
	claimId: string;
	eventIds: string[];
	ack: "uncertain" | "confirmed";
	createdAt: number;
}

export interface BridgeTurnWorker {
	attempt: number;
	statePath: string;
	workerPid?: number;
	workerIdentity?: string;
	cancelRequested?: boolean;
}

export interface BridgeTurnTerminal {
	status: BridgeTerminalStatus;
	body: string;
	sessionAdvance: BridgeSessionAdvance;
	sessionId?: string;
}

export interface BridgeTurn {
	turnId: string;
	sequence: number;
	eventId: string;
	claimId: string;
	senderParticipantKey: string;
	body: string;
	state: BridgeExecutionState;
	attempt: number;
	replySendId: string;
	replyBody?: string;
	reply: "unsent" | "uncertain" | "sent";
	worker?: BridgeTurnWorker;
	terminal?: BridgeTurnTerminal;
	createdAt: number;
	updatedAt: number;
}

export interface BridgeJournal {
	version: 1;
	bridgeId: string;
	driver: "fake";
	targetKey?: string;
	participantKey?: string;
	holderGeneration?: string;
	protocol?: string;
	participantId?: string;
	driverSessionId?: string;
	nextSequence: number;
	admissions: BridgeAdmission[];
	turns: BridgeTurn[];
	status: "starting" | "running" | "needs_attention" | "stopped";
	updatedAt: number;
}

export interface BridgeRunnerConfig {
	version: 1;
	bridgeId: string;
	driver: "fake";
	root: string;
	runtimeSocket: string;
	projectRoot: string;
	cwd: string;
	clientGeneration: string;
	protocol: string;
	participantId: string;
	launchToken?: string;
	reconnectToken: string;
	targetKey?: string;
	wallMs: number;
}

export type BridgeDriverFrame =
	| { type: "session"; sessionId: string }
	| { type: "text"; text: string }
	| { type: "terminal"; status: BridgeTerminalStatus; body: string; sessionAdvance: BridgeSessionAdvance; sessionId?: string };

export interface BridgeWorkerSpec {
	version: 1;
	turnId: string;
	eventId: string;
	attempt: number;
	driver: "fake";
	cwd: string;
	body: string;
	sessionId?: string;
	statePath: string;
	wallMs: number;
}

export interface BridgeWorkerState {
	version: 1;
	turnId: string;
	eventId: string;
	attempt: number;
	status: "starting" | "running" | "terminal" | "needs_attention";
	workerPid: number;
	workerIdentity: string;
	childPid?: number;
	childIdentity?: string;
	stdoutBytes: number;
	stderrBytes: number;
	frames: number;
	terminal?: BridgeTurnTerminal;
	error?: string;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
}
