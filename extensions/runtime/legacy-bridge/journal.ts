import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BRIDGE_RUNNER_MAX_BODY_BYTES, BRIDGE_RUNNER_MAX_FRAMES, BRIDGE_RUNNER_MAX_STATE_BYTES, BRIDGE_RUNNER_MAX_STDERR_BYTES, BRIDGE_RUNNER_MAX_STDOUT_BYTES, BRIDGE_RUNNER_MAX_TURNS, type BridgeAdmission, type BridgeJournal, type BridgeTurn, type BridgeWorkerState } from "./types.ts";

const MAX_ID_BYTES = 200;
const MAX_PATH_BYTES = 8 * 1024;
const TURN_DIRECTORY = /^turn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface PersistedBridgeAdmission {
	claimId?: string | null;
	eventIds?: string[] | null;
	ack?: string | null;
	createdAt?: number | null;
}

interface PersistedBridgeTurnWorker {
	attempt?: number | null;
	statePath?: string | null;
	workerPid?: number | null;
	workerIdentity?: string | null;
	cancelRequested?: boolean | null;
	quiescedAt?: number | null;
}

interface PersistedBridgeTurnTerminal {
	status?: string | null;
	body?: string | null;
	sessionAdvance?: string | null;
	sessionId?: string | null;
}

interface PersistedBridgeTurn {
	turnId?: string | null;
	sequence?: number | null;
	eventId?: string | null;
	claimId?: string | null;
	senderParticipantKey?: string | null;
	body?: string | null;
	task?: boolean | null;
	state?: string | null;
	attempt?: number | null;
	replySendId?: string | null;
	replyBody?: string | null;
	reply?: string | null;
	worker?: PersistedBridgeTurnWorker | null;
	terminal?: PersistedBridgeTurnTerminal | null;
	createdAt?: number | null;
	updatedAt?: number | null;
}

interface PersistedBridgeJournal {
	version?: number | null;
	bridgeId?: string | null;
	driver?: string | null;
	targetKey?: string | null;
	participantKey?: string | null;
	holderGeneration?: string | null;
	protocol?: string | null;
	participantId?: string | null;
	driverSessionId?: string | null;
	nextSequence?: number | null;
	admissions?: PersistedBridgeAdmission[] | null;
	turns?: PersistedBridgeTurn[] | null;
	status?: string | null;
	updatedAt?: number | null;
}

interface PersistedBridgeWorkerState {
	version?: number | null;
	turnId?: string | null;
	eventId?: string | null;
	attempt?: number | null;
	status?: string | null;
	workerPid?: number | null;
	workerIdentity?: string | null;
	childPid?: number | null;
	childIdentity?: string | null;
	stdoutBytes?: number | null;
	stderrBytes?: number | null;
	frames?: number | null;
	terminal?: PersistedBridgeTurnTerminal | null;
	error?: string | null;
	startedAt?: number | null;
	updatedAt?: number | null;
	endedAt?: number | null;
}

type PersistedBridgeObject = PersistedBridgeAdmission | PersistedBridgeTurnWorker | PersistedBridgeTurnTerminal | PersistedBridgeTurn | PersistedBridgeJournal | PersistedBridgeWorkerState;

export class BridgeJournalError extends Error {
	readonly code = "journal_error" as const;
}

export class BridgeJournalStore {
	readonly root: string;
	readonly path: string;
	private state: BridgeJournal;

	constructor(root: string, initial: BridgeJournal) {
		this.root = root;
		prepareDirectory(root);
		this.path = join(root, "journal.v1.json");
		const persisted = readJson<PersistedBridgeJournal | null>(this.path, BRIDGE_RUNNER_MAX_STATE_BYTES);
		this.state = persisted === undefined ? validateJournal(initial) : validateJournal(persisted);
		if (persisted === undefined) writeAtomic(this.path, this.state, BRIDGE_RUNNER_MAX_STATE_BYTES);
	}

	read(): BridgeJournal { return this.state; }

	write(state: BridgeJournal): BridgeJournal {
		const validated = validateJournal(state);
		writeAtomic(this.path, validated, BRIDGE_RUNNER_MAX_STATE_BYTES);
		this.state = validated;
		return validated;
	}

	update(update: (state: BridgeJournal) => BridgeJournal): BridgeJournal { return this.write(update(structuredClone(this.state))); }

	pruneTurnArtifacts(retainedTurnIds: readonly string[]): void {
		const turnsRoot = join(this.root, "turns");
		let info;
		try { info = lstatSync(turnsRoot); }
		catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw new BridgeJournalError(`Cannot inspect bridge turn directory: ${turnsRoot}`); }
		if (info.isSymbolicLink() || !info.isDirectory()) throw new BridgeJournalError(`Bridge turn path is not an owned directory: ${turnsRoot}`);
		const canonicalRoot = realpathSync(this.root);
		const canonicalTurns = realpathSync(turnsRoot);
		if (canonicalTurns !== join(canonicalRoot, "turns")) throw new BridgeJournalError("Bridge turn directory escaped its runner root.");
		const retained = new Set(retainedTurnIds);
		let changed = false;
		for (const name of readdirSync(canonicalTurns)) {
			if (retained.has(name) || !TURN_DIRECTORY.test(name)) continue;
			const path = join(canonicalTurns, name);
			const entry = lstatSync(path);
			if (entry.isSymbolicLink()) unlinkSync(path);
			else {
				if (!entry.isDirectory() || realpathSync(path) !== path) throw new BridgeJournalError(`Bridge turn artifact escaped its runner root: ${name}`);
				rmSync(path, { recursive: true });
			}
			changed = true;
		}
		if (changed) { const directory = openSync(canonicalTurns, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(directory); } finally { closeSync(directory); } }
	}
}

export function readBridgeJournal(root: string): BridgeJournal | undefined { const value = readJson<PersistedBridgeJournal | null>(join(root, "journal.v1.json"), BRIDGE_RUNNER_MAX_STATE_BYTES); return value === undefined ? undefined : validateJournal(value); }
export function readWorkerState(path: string): BridgeWorkerState | undefined { const value = readJson<PersistedBridgeWorkerState | null>(path, BRIDGE_RUNNER_MAX_STATE_BYTES); return value === undefined ? undefined : validateWorkerState(value); }

function validateJournal(state: PersistedBridgeJournal | null): BridgeJournal {
	assertExactObject(state, "bridge journal", ["version", "bridgeId", "driver", "targetKey", "participantKey", "holderGeneration", "protocol", "participantId", "driverSessionId", "nextSequence", "admissions", "turns", "status", "updatedAt"]);
	const driver = enumValue(state.driver, ["fake", "claude-code", "codex"], "Bridge journal driver is invalid.");
	const status = enumValue(state.status, ["starting", "running", "needs_attention", "stopped"], "Bridge journal status is invalid.");
	if (state.version !== 1) throw new BridgeJournalError("Bridge journal version, driver, or status is invalid.");
	const admissions = array(state.admissions, "admissions", BRIDGE_RUNNER_MAX_TURNS).map(validateAdmission);
	const turns = array(state.turns, "turns", BRIDGE_RUNNER_MAX_TURNS).map(validateTurn);
	const result: BridgeJournal = {
		version: 1,
		bridgeId: text(state.bridgeId, "bridge ID", MAX_ID_BYTES),
		driver,
		nextSequence: integer(state.nextSequence, "next sequence"),
		admissions,
		turns,
		status,
		updatedAt: time(state.updatedAt, "updated time"),
	};
	if (state.targetKey !== undefined) result.targetKey = text(state.targetKey, "target key", MAX_ID_BYTES);
	if (state.participantKey !== undefined) result.participantKey = text(state.participantKey, "participant key", MAX_ID_BYTES);
	if (state.holderGeneration !== undefined) result.holderGeneration = text(state.holderGeneration, "holder generation", MAX_ID_BYTES);
	if (state.protocol !== undefined) result.protocol = text(state.protocol, "protocol", 64);
	if (state.participantId !== undefined) result.participantId = text(state.participantId, "participant ID", 64);
	if (state.driverSessionId !== undefined) result.driverSessionId = text(state.driverSessionId, "driver session ID", MAX_ID_BYTES);
	const admitted = new Map(admissions.map((item) => [item.claimId, new Set(item.eventIds)]));
	if (result.nextSequence < 1 || new Set(admissions.map((item) => item.claimId)).size !== admissions.length || new Set(turns.map((item) => item.eventId)).size !== turns.length || new Set(turns.map((item) => item.sequence)).size !== turns.length || turns.some((turn) => turn.sequence < 1 || turn.sequence >= result.nextSequence || !admitted.get(turn.claimId)?.has(turn.eventId))) throw new BridgeJournalError("Bridge journal admission or turn identity is inconsistent.");
	if (turns.some((turn) => (turn.terminal !== undefined || ["terminal", "reply_pending", "reply_sent"].includes(turn.state)) && !turn.worker)) result.status = "needs_attention";
	return result;
}

function validateAdmission(item: PersistedBridgeAdmission): BridgeAdmission {
	assertExactObject(item, "bridge admission", ["claimId", "eventIds", "ack", "createdAt"]);
	if (item.ack !== "uncertain" && item.ack !== "confirmed") throw new BridgeJournalError("Bridge admission ACK state is invalid.");
	const eventIds = array(item.eventIds, "event IDs", 12).map((entry) => text(entry, "event ID", MAX_ID_BYTES));
	if (!eventIds.length || new Set(eventIds).size !== eventIds.length) throw new BridgeJournalError("Bridge admission event IDs are invalid.");
	return { claimId: text(item.claimId, "claim ID", MAX_ID_BYTES), eventIds, ack: item.ack, createdAt: time(item.createdAt, "admission time") };
}

function validateTurn(item: PersistedBridgeTurn): BridgeTurn {
	assertExactObject(item, "bridge turn", ["turnId", "sequence", "eventId", "claimId", "senderParticipantKey", "body", "task", "state", "attempt", "replySendId", "replyBody", "reply", "worker", "terminal", "createdAt", "updatedAt"]);
	const state = enumValue(item.state, ["pending", "starting", "running", "terminal", "reply_pending", "reply_sent", "needs_attention"], "Bridge turn execution state is invalid.");
	const reply = enumValue(item.reply, ["unsent", "uncertain", "sent"], "Bridge turn reply state is invalid.");
	if (item.task !== undefined && item.task !== true) invalid("Bridge turn task marker is invalid.");
	const result: BridgeTurn = {
		turnId: text(item.turnId, "turn ID", MAX_ID_BYTES),
		sequence: integer(item.sequence, "turn sequence"),
		eventId: text(item.eventId, "event ID", MAX_ID_BYTES),
		claimId: text(item.claimId, "claim ID", MAX_ID_BYTES),
		senderParticipantKey: text(item.senderParticipantKey, "sender participant key", MAX_ID_BYTES),
		body: string(item.body, "turn body", BRIDGE_RUNNER_MAX_BODY_BYTES),
		state,
		attempt: integer(item.attempt, "attempt"),
		replySendId: text(item.replySendId, "reply send ID", MAX_ID_BYTES),
		reply,
		createdAt: time(item.createdAt, "turn creation time"),
		updatedAt: time(item.updatedAt, "turn updated time"),
	};
	if (item.task === true) result.task = true;
	if (item.replyBody !== undefined) result.replyBody = string(item.replyBody, "reply body", BRIDGE_RUNNER_MAX_BODY_BYTES);
	if (item.worker !== undefined) result.worker = validateTurnWorker(item.worker);
	if (item.terminal !== undefined) result.terminal = validateTurnTerminal(item.terminal);
	const terminalRequired = ["terminal", "reply_pending", "reply_sent"].includes(result.state);
	const terminalAllowed = terminalRequired || result.state === "needs_attention";
	if (result.updatedAt < result.createdAt || (result.state === "reply_sent") !== (result.reply === "sent") || (terminalRequired && !result.terminal) || (!terminalAllowed && result.terminal !== undefined) || result.worker?.quiescedAt !== undefined && (!result.worker.workerPid || !result.worker.workerIdentity)) throw new BridgeJournalError("Bridge turn terminal, reply, worker quiescence, or time is inconsistent.");
	return result;
}

function validateTurnWorker(item: PersistedBridgeTurnWorker | null): NonNullable<BridgeTurn["worker"]> {
	assertExactObject(item, "turn worker", ["attempt", "statePath", "workerPid", "workerIdentity", "cancelRequested", "quiescedAt"]);
	const result: NonNullable<BridgeTurn["worker"]> = { attempt: integer(item.attempt, "worker attempt"), statePath: text(item.statePath, "worker state path", MAX_PATH_BYTES) };
	if (item.workerPid !== undefined) result.workerPid = positiveInteger(item.workerPid, "worker PID");
	if (item.workerIdentity !== undefined) result.workerIdentity = text(item.workerIdentity, "worker identity", MAX_PATH_BYTES);
	if (item.cancelRequested !== undefined) result.cancelRequested = boolean(item.cancelRequested, "Bridge worker cancel request must be boolean.");
	if (item.quiescedAt !== undefined) result.quiescedAt = time(item.quiescedAt, "worker quiescence time");
	return result;
}

function validateTurnTerminal(item: PersistedBridgeTurnTerminal | null): NonNullable<BridgeTurn["terminal"]> {
	assertExactObject(item, "turn terminal", ["status", "body", "sessionAdvance", "sessionId"]);
	const result: NonNullable<BridgeTurn["terminal"]> = {
		status: enumValue(item.status, ["completed", "failed", "cancelled"], "Bridge terminal status is invalid."),
		body: string(item.body, "terminal body", BRIDGE_RUNNER_MAX_BODY_BYTES),
		sessionAdvance: enumValue(item.sessionAdvance, ["none", "committed", "uncertain"], "Bridge session advance state is invalid."),
	};
	if (item.sessionId !== undefined) result.sessionId = text(item.sessionId, "terminal session ID", MAX_ID_BYTES);
	return result;
}

function validateWorkerState(item: PersistedBridgeWorkerState | null): BridgeWorkerState {
	assertExactObject(item, "bridge worker state", ["version", "turnId", "eventId", "attempt", "status", "workerPid", "workerIdentity", "childPid", "childIdentity", "stdoutBytes", "stderrBytes", "frames", "terminal", "error", "startedAt", "updatedAt", "endedAt"]);
	const status = enumValue(item.status, ["starting", "running", "terminal", "needs_attention"], "Bridge worker status is invalid.");
	if (item.version !== 1) throw new BridgeJournalError("Bridge worker version or status is invalid.");
	const result: BridgeWorkerState = {
		version: 1,
		turnId: text(item.turnId, "worker turn ID", MAX_ID_BYTES),
		eventId: text(item.eventId, "worker event ID", MAX_ID_BYTES),
		attempt: integer(item.attempt, "worker attempt"),
		status,
		workerPid: positiveInteger(item.workerPid, "worker PID"),
		workerIdentity: text(item.workerIdentity, "worker identity", MAX_PATH_BYTES),
		stdoutBytes: integer(item.stdoutBytes, "stdout bytes"),
		stderrBytes: integer(item.stderrBytes, "stderr bytes"),
		frames: integer(item.frames, "frame count"),
		startedAt: time(item.startedAt, "worker start time"),
		updatedAt: time(item.updatedAt, "worker update time"),
	};
	if (item.childPid !== undefined) result.childPid = positiveInteger(item.childPid, "child PID");
	if (item.childIdentity !== undefined) result.childIdentity = text(item.childIdentity, "child identity", MAX_PATH_BYTES);
	if (item.terminal !== undefined) result.terminal = validateTurnTerminal(item.terminal);
	if (item.error !== undefined) result.error = string(item.error, "worker error", BRIDGE_RUNNER_MAX_BODY_BYTES);
	if (item.endedAt !== undefined) result.endedAt = time(item.endedAt, "worker end time");
	if (result.stdoutBytes > BRIDGE_RUNNER_MAX_STDOUT_BYTES || result.stderrBytes > BRIDGE_RUNNER_MAX_STDERR_BYTES || result.frames > BRIDGE_RUNNER_MAX_FRAMES || result.updatedAt < result.startedAt || (result.endedAt !== undefined && result.endedAt < result.startedAt) || (result.status === "terminal" && !result.terminal)) throw new BridgeJournalError("Bridge worker counters, time, or terminal state is inconsistent.");
	return result;
}

function invalid(message: string): never { throw new BridgeJournalError(message); }

function prepareDirectory(path: string): void {
	try { mkdirSync(path, { recursive: true, mode: 0o700 }); const info = lstatSync(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(); chmodSync(path, 0o700); }
	catch { throw new BridgeJournalError(`Cannot prepare bridge journal directory: ${path}`); }
}

function readJson<Value extends PersistedBridgeJournal | PersistedBridgeWorkerState | null>(path: string, max: number): Value | undefined { let fd: number | undefined; try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const info = fstatSync(fd); if (!info.isFile() || info.size > max || (info.mode & 0o077) !== 0) throw new Error(); /* SAFETY: Callers request an exact persisted bridge contract and validate every field before constructing trusted state. */ return JSON.parse(readFileSync(fd, "utf8")) as Value; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw new BridgeJournalError(`Cannot read bridge state: ${path}`); } finally { if (fd !== undefined) closeSync(fd); } }
function writeAtomic(path: string, value: BridgeJournal, max: number): void { prepareDirectory(dirname(path)); const content = `${JSON.stringify(value, null, 2)}\n`; if (Buffer.byteLength(content) > max) throw new BridgeJournalError(`Bridge state exceeds ${max} bytes.`); if (lstatExistsSymlink(path)) throw new BridgeJournalError(`Refusing bridge state symlink: ${path}`); const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`); let fd: number | undefined; try { fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); chmodSync(path, 0o600); const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(directory); } finally { closeSync(directory); } } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} throw new BridgeJournalError(`Cannot persist bridge state: ${path}`); } }
function lstatExistsSymlink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
function assertExactObject<Value extends PersistedBridgeObject>(value: Value | null | undefined, name: string, allowed: readonly string[]): asserts value is Value { if (!value || value.constructor !== Object) throw new BridgeJournalError(`${name} must be an object.`); for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new BridgeJournalError(`${name} has unknown field ${key}.`); }
function enumValue<const Value extends string>(value: string | null | undefined, allowed: readonly Value[], message: string): Value { const result = allowed.find((candidate) => candidate === value); if (result === undefined) throw new BridgeJournalError(message); return result; }
function array<Value>(value: Value[] | null | undefined, name: string, max: number): Value[] { if (!Array.isArray(value) || value.length > max) throw new BridgeJournalError(`${name} exceeds ${max} entries.`); return value; }
function text(value: string | null | undefined, name: string, max: number): string { const result = string(value, name, max); if (!result.trim()) throw new BridgeJournalError(`${name} is empty.`); return result; }
function string(value: string | null | undefined, name: string, max: number): string { if (!isString(value) || Buffer.byteLength(value) > max) throw new BridgeJournalError(`${name} exceeds ${max} bytes.`); return value; }
function boolean(value: boolean | null | undefined, message: string): boolean { if (value !== true && value !== false) throw new BridgeJournalError(message); return value; }
function integer(value: number | null | undefined, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BridgeJournalError(`${name} must be a non-negative integer.`); return Number(value); }
function positiveInteger(value: number | null | undefined, name: string): number { const result = integer(value, name); if (result < 1) throw new BridgeJournalError(`${name} must be positive.`); return result; }
function time(value: number | null | undefined, name: string): number { if (!Number.isFinite(value) || Number(value) < 0) throw new BridgeJournalError(`${name} must be a non-negative time.`); return Number(value); }
function isString(value: string | null | undefined): value is string { return value !== undefined && value !== null && value.constructor === String; }
