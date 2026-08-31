import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BRIDGE_RUNNER_MAX_BODY_BYTES, BRIDGE_RUNNER_MAX_FRAMES, BRIDGE_RUNNER_MAX_STATE_BYTES, BRIDGE_RUNNER_MAX_STDERR_BYTES, BRIDGE_RUNNER_MAX_STDOUT_BYTES, BRIDGE_RUNNER_MAX_TURNS, type BridgeAdmission, type BridgeJournal, type BridgeTurn, type BridgeWorkerState } from "./types.ts";

const MAX_ID_BYTES = 200;
const MAX_PATH_BYTES = 8 * 1024;
const TURN_DIRECTORY = /^turn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
		const persisted = readJson(this.path, BRIDGE_RUNNER_MAX_STATE_BYTES);
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

export function readBridgeJournal(root: string): BridgeJournal | undefined { const value = readJson(join(root, "journal.v1.json"), BRIDGE_RUNNER_MAX_STATE_BYTES); return value === undefined ? undefined : validateJournal(value); }
export function readWorkerState(path: string): BridgeWorkerState | undefined { const value = readJson(path, BRIDGE_RUNNER_MAX_STATE_BYTES); return value === undefined ? undefined : validateWorkerState(value); }

function validateJournal(value: unknown): BridgeJournal {
	const state = object(value, "bridge journal", ["version", "bridgeId", "driver", "targetKey", "participantKey", "holderGeneration", "protocol", "participantId", "driverSessionId", "nextSequence", "admissions", "turns", "status", "updatedAt"]);
	const driver = enumValue(state.driver, ["fake", "claude-code", "codex"], "Bridge journal driver is invalid.");
	const status = enumValue(state.status, ["starting", "running", "needs_attention", "stopped"], "Bridge journal status is invalid.");
	if (state.version !== 1) throw new BridgeJournalError("Bridge journal version, driver, or status is invalid.");
	const admissions = array(state.admissions, "admissions", BRIDGE_RUNNER_MAX_TURNS).map(validateAdmission);
	const turns = array(state.turns, "turns", BRIDGE_RUNNER_MAX_TURNS).map(validateTurn);
	const result: BridgeJournal = {
		version: 1,
		bridgeId: text(state.bridgeId, "bridge ID", MAX_ID_BYTES),
		driver,
		...(state.targetKey === undefined ? {} : { targetKey: text(state.targetKey, "target key", MAX_ID_BYTES) }),
		...(state.participantKey === undefined ? {} : { participantKey: text(state.participantKey, "participant key", MAX_ID_BYTES) }),
		...(state.holderGeneration === undefined ? {} : { holderGeneration: text(state.holderGeneration, "holder generation", MAX_ID_BYTES) }),
		...(state.protocol === undefined ? {} : { protocol: text(state.protocol, "protocol", 64) }),
		...(state.participantId === undefined ? {} : { participantId: text(state.participantId, "participant ID", 64) }),
		...(state.driverSessionId === undefined ? {} : { driverSessionId: text(state.driverSessionId, "driver session ID", MAX_ID_BYTES) }),
		nextSequence: integer(state.nextSequence, "next sequence"),
		admissions,
		turns,
		status,
		updatedAt: time(state.updatedAt, "updated time"),
	};
	const admitted = new Map(admissions.map((item) => [item.claimId, new Set(item.eventIds)]));
	if (result.nextSequence < 1 || new Set(admissions.map((item) => item.claimId)).size !== admissions.length || new Set(turns.map((item) => item.eventId)).size !== turns.length || new Set(turns.map((item) => item.sequence)).size !== turns.length || turns.some((turn) => turn.sequence < 1 || turn.sequence >= result.nextSequence || !admitted.get(turn.claimId)?.has(turn.eventId))) throw new BridgeJournalError("Bridge journal admission or turn identity is inconsistent.");
	if (turns.some((turn) => (turn.terminal !== undefined || ["terminal", "reply_pending", "reply_sent"].includes(turn.state)) && !turn.worker)) result.status = "needs_attention";
	return result;
}

function validateAdmission(value: unknown): BridgeAdmission {
	const item = object(value, "bridge admission", ["claimId", "eventIds", "ack", "createdAt"]);
	if (item.ack !== "uncertain" && item.ack !== "confirmed") throw new BridgeJournalError("Bridge admission ACK state is invalid.");
	const eventIds = array(item.eventIds, "event IDs", 12).map((entry) => text(entry, "event ID", MAX_ID_BYTES));
	if (!eventIds.length || new Set(eventIds).size !== eventIds.length) throw new BridgeJournalError("Bridge admission event IDs are invalid.");
	return { claimId: text(item.claimId, "claim ID", MAX_ID_BYTES), eventIds, ack: item.ack, createdAt: time(item.createdAt, "admission time") };
}

function validateTurn(value: unknown): BridgeTurn {
	const item = object(value, "bridge turn", ["turnId", "sequence", "eventId", "claimId", "senderParticipantKey", "body", "task", "state", "attempt", "replySendId", "replyBody", "reply", "worker", "terminal", "createdAt", "updatedAt"]);
	const state = enumValue(item.state, ["pending", "starting", "running", "terminal", "reply_pending", "reply_sent", "needs_attention"], "Bridge turn execution state is invalid.");
	const reply = enumValue(item.reply, ["unsent", "uncertain", "sent"], "Bridge turn reply state is invalid.");
	const worker = item.worker === undefined ? undefined : object(item.worker, "turn worker", ["attempt", "statePath", "workerPid", "workerIdentity", "cancelRequested", "quiescedAt"]);
	const terminal = item.terminal === undefined ? undefined : object(item.terminal, "turn terminal", ["status", "body", "sessionAdvance", "sessionId"]);
	if (worker?.cancelRequested !== undefined && typeof worker.cancelRequested !== "boolean") throw new BridgeJournalError("Bridge worker cancel request must be boolean.");
	const terminalStatus = terminal ? enumValue(terminal.status, ["completed", "failed", "cancelled"], "Bridge terminal status is invalid.") : undefined;
	const sessionAdvance = terminal ? enumValue(terminal.sessionAdvance, ["none", "committed", "uncertain"], "Bridge session advance state is invalid.") : undefined;
	const result: BridgeTurn = {
		turnId: text(item.turnId, "turn ID", MAX_ID_BYTES),
		sequence: integer(item.sequence, "turn sequence"),
		eventId: text(item.eventId, "event ID", MAX_ID_BYTES),
		claimId: text(item.claimId, "claim ID", MAX_ID_BYTES),
		senderParticipantKey: text(item.senderParticipantKey, "sender participant key", MAX_ID_BYTES),
		body: string(item.body, "turn body", BRIDGE_RUNNER_MAX_BODY_BYTES),
		...(item.task === true ? { task: true as const } : item.task === undefined ? {} : invalid("Bridge turn task marker is invalid.")),
		state,
		attempt: integer(item.attempt, "attempt"),
		replySendId: text(item.replySendId, "reply send ID", MAX_ID_BYTES),
		...(item.replyBody === undefined ? {} : { replyBody: string(item.replyBody, "reply body", BRIDGE_RUNNER_MAX_BODY_BYTES) }),
		reply,
		...(worker ? { worker: { attempt: integer(worker.attempt, "worker attempt"), statePath: text(worker.statePath, "worker state path", MAX_PATH_BYTES), ...(worker.workerPid === undefined ? {} : { workerPid: positiveInteger(worker.workerPid, "worker PID") }), ...(worker.workerIdentity === undefined ? {} : { workerIdentity: text(worker.workerIdentity, "worker identity", MAX_PATH_BYTES) }), ...(worker.cancelRequested === undefined ? {} : { cancelRequested: worker.cancelRequested }), ...(worker.quiescedAt === undefined ? {} : { quiescedAt: time(worker.quiescedAt, "worker quiescence time") }) } } : {}),
		...(terminal && terminalStatus && sessionAdvance ? { terminal: { status: terminalStatus, body: string(terminal.body, "terminal body", BRIDGE_RUNNER_MAX_BODY_BYTES), sessionAdvance, ...(terminal.sessionId === undefined ? {} : { sessionId: text(terminal.sessionId, "terminal session ID", MAX_ID_BYTES) }) } } : {}),
		createdAt: time(item.createdAt, "turn creation time"),
		updatedAt: time(item.updatedAt, "turn updated time"),
	};
	const terminalRequired = ["terminal", "reply_pending", "reply_sent"].includes(result.state);
	const terminalAllowed = terminalRequired || result.state === "needs_attention";
	if (result.updatedAt < result.createdAt || (result.state === "reply_sent") !== (result.reply === "sent") || (terminalRequired && !result.terminal) || (!terminalAllowed && result.terminal !== undefined) || result.worker?.quiescedAt !== undefined && (!result.worker.workerPid || !result.worker.workerIdentity)) throw new BridgeJournalError("Bridge turn terminal, reply, worker quiescence, or time is inconsistent.");
	return result;
}

function validateWorkerState(value: unknown): BridgeWorkerState {
	const item = object(value, "bridge worker state", ["version", "turnId", "eventId", "attempt", "status", "workerPid", "workerIdentity", "childPid", "childIdentity", "stdoutBytes", "stderrBytes", "frames", "terminal", "error", "startedAt", "updatedAt", "endedAt"]);
	const status = enumValue(item.status, ["starting", "running", "terminal", "needs_attention"], "Bridge worker status is invalid.");
	if (item.version !== 1) throw new BridgeJournalError("Bridge worker version or status is invalid.");
	const terminal = item.terminal === undefined ? undefined : validateTurn({ turnId: "validation", sequence: 0, eventId: "validation", claimId: "validation", senderParticipantKey: "validation", body: "", state: "terminal", attempt: 0, replySendId: "validation", reply: "unsent", terminal: item.terminal, createdAt: 0, updatedAt: 0 }).terminal;
	const result: BridgeWorkerState = { version: 1, turnId: text(item.turnId, "worker turn ID", MAX_ID_BYTES), eventId: text(item.eventId, "worker event ID", MAX_ID_BYTES), attempt: integer(item.attempt, "worker attempt"), status, workerPid: positiveInteger(item.workerPid, "worker PID"), workerIdentity: text(item.workerIdentity, "worker identity", MAX_PATH_BYTES), ...(item.childPid === undefined ? {} : { childPid: positiveInteger(item.childPid, "child PID") }), ...(item.childIdentity === undefined ? {} : { childIdentity: text(item.childIdentity, "child identity", MAX_PATH_BYTES) }), stdoutBytes: integer(item.stdoutBytes, "stdout bytes"), stderrBytes: integer(item.stderrBytes, "stderr bytes"), frames: integer(item.frames, "frame count"), ...(terminal ? { terminal } : {}), ...(item.error === undefined ? {} : { error: string(item.error, "worker error", BRIDGE_RUNNER_MAX_BODY_BYTES) }), startedAt: time(item.startedAt, "worker start time"), updatedAt: time(item.updatedAt, "worker update time"), ...(item.endedAt === undefined ? {} : { endedAt: time(item.endedAt, "worker end time") }) };
	if (result.stdoutBytes > BRIDGE_RUNNER_MAX_STDOUT_BYTES || result.stderrBytes > BRIDGE_RUNNER_MAX_STDERR_BYTES || result.frames > BRIDGE_RUNNER_MAX_FRAMES || result.updatedAt < result.startedAt || (result.endedAt !== undefined && result.endedAt < result.startedAt) || (result.status === "terminal" && !result.terminal)) throw new BridgeJournalError("Bridge worker counters, time, or terminal state is inconsistent.");
	return result;
}

function invalid(message: string): never { throw new BridgeJournalError(message); }

function prepareDirectory(path: string): void {
	try { mkdirSync(path, { recursive: true, mode: 0o700 }); const info = lstatSync(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(); chmodSync(path, 0o700); }
	catch { throw new BridgeJournalError(`Cannot prepare bridge journal directory: ${path}`); }
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Journal readers pass this raw JSON directly to the versioned state decoders above.
function readJson(path: string, max: number): unknown | undefined { let fd: number | undefined; try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const info = fstatSync(fd); if (!info.isFile() || info.size > max || (info.mode & 0o077) !== 0) throw new Error(); return JSON.parse(readFileSync(fd, "utf8")); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw new BridgeJournalError(`Cannot read bridge state: ${path}`); } finally { if (fd !== undefined) closeSync(fd); } }
function writeAtomic(path: string, value: unknown, max: number): void { prepareDirectory(dirname(path)); const content = `${JSON.stringify(value, null, 2)}\n`; if (Buffer.byteLength(content) > max) throw new BridgeJournalError(`Bridge state exceeds ${max} bytes.`); if (lstatExistsSymlink(path)) throw new BridgeJournalError(`Refusing bridge state symlink: ${path}`); const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`); let fd: number | undefined; try { fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path); chmodSync(path, 0o600); const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(directory); } finally { closeSync(directory); } } catch { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} throw new BridgeJournalError(`Cannot persist bridge state: ${path}`); } }
function lstatExistsSymlink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
function object(value: unknown, name: string, allowed: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeJournalError(`${name} must be an object.`); /* SAFETY: Runtime checks exclude null, primitives, and arrays before schema validation. */ const item = value as Record<string, unknown>; for (const key of Object.keys(item)) if (!allowed.includes(key)) throw new BridgeJournalError(`${name} has unknown field ${key}.`); return item; }
function enumValue<const Value extends string>(value: unknown, allowed: readonly Value[], message: string): Value { if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) throw new BridgeJournalError(message); /* SAFETY: Equality against the complete literal allowlist proves union membership. */ return value as Value; }
function array(value: unknown, name: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new BridgeJournalError(`${name} exceeds ${max} entries.`); return value; }
function text(value: unknown, name: string, max: number): string { const result = string(value, name, max); if (!result.trim()) throw new BridgeJournalError(`${name} is empty.`); return result; }
function string(value: unknown, name: string, max: number): string { if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new BridgeJournalError(`${name} exceeds ${max} bytes.`); return value; }
function integer(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new BridgeJournalError(`${name} must be a non-negative integer.`); return Number(value); }
function positiveInteger(value: unknown, name: string): number { const result = integer(value, name); if (result < 1) throw new BridgeJournalError(`${name} must be positive.`); return result; }
function time(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new BridgeJournalError(`${name} must be a non-negative time.`); return value; }
