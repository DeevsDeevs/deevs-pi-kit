import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isProcessGroupAlive, ownsProcessIdentity, quiesceProcessGroup } from "../../shared/process-group.ts";
import { readBridgeJournal, readWorkerState } from "./journal.ts";
import type { BridgeTurn } from "./types.ts";

const TURN_ID = /^turn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BridgeStopAuthority {
	bridgeId: string;
	targetKey: string;
	participantKey: string;
	holderGeneration: string;
}

export async function quiesceBridgeRunner(root: string, expected: BridgeStopAuthority): Promise<"idle" | "quiesced"> {
	const canonicalRoot = realpathSync(root);
	const journal = readBridgeJournal(canonicalRoot);
	if (!journal || journal.bridgeId !== expected.bridgeId || journal.targetKey !== expected.targetKey || journal.participantKey !== expected.participantKey || journal.holderGeneration !== expected.holderGeneration) throw new Error("Bridge runner journal does not match stop authority.");
	const unsettled = journal.turns.filter((turn) => turn.state !== "reply_sent" && turn.worker);
	if (unsettled.length > 1) throw new Error("Bridge runner has multiple unsettled worker identities.");
	const settled = journal.turns.filter((turn) => turn.state === "reply_sent" && turn.worker);
	let stopped = false;
	for (const turn of [...unsettled, ...settled]) stopped = await quiesceTurn(canonicalRoot, turn) || stopped;
	return stopped ? "quiesced" : "idle";
}

async function quiesceTurn(root: string, turn: BridgeTurn): Promise<boolean> {
	if (!turn.worker || !TURN_ID.test(turn.turnId)) throw new Error("Bridge runner turn identity is invalid for stop.");
	const statePath = join(root, "turns", turn.turnId, `attempt-${turn.worker.attempt}`, "worker.v1.json");
	if (resolve(turn.worker.statePath) !== statePath || realpathSync(dirname(statePath)) !== dirname(statePath)) throw new Error("Bridge worker state path escaped its runner root.");
	let worker = readWorkerState(statePath);
	if (!worker && turn.state !== "reply_sent") { await delay(250); worker = readWorkerState(statePath); }
	if (!worker || worker.turnId !== turn.turnId || worker.eventId !== turn.eventId || worker.attempt !== turn.worker.attempt || turn.worker.workerPid !== undefined && turn.worker.workerPid !== worker.workerPid || turn.worker.workerIdentity !== undefined && turn.worker.workerIdentity !== worker.workerIdentity) throw new Error("Bridge worker identity is unavailable or inconsistent during stop.");
	const witnessed = await ownsProcessIdentity(worker.workerPid, worker.workerIdentity) || Boolean(worker.childPid && worker.childIdentity && await ownsProcessIdentity(worker.childPid, worker.childIdentity));
	if (!witnessed) {
		if (isProcessGroupAlive(worker.workerPid)) throw new Error("Bridge worker group is live without an exact process witness.");
		return false;
	}
	if (!await quiesceProcessGroup(worker.workerPid, { graceMs: 1_000, killWaitMs: 2_000 })) throw new Error("Bridge worker group could not be quiesced.");
	return true;
}

function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
