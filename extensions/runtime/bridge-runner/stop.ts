import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isProcessGroupQuiescent, ownsProcessIdentity, quiesceProcessGroup, readProcessGroupId } from "../../shared/process-group.ts";
import { BridgeJournalStore, readBridgeJournal, readWorkerState } from "./journal.ts";
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
	if (journal.turns.some((turn) => turn.state !== "pending" && !turn.worker)) throw new Error("Bridge runner has a settled or active turn without an exact worker receipt.");
	const unsettled = journal.turns.filter((turn) => turn.state !== "reply_sent" && turn.worker);
	if (unsettled.length > 1) throw new Error("Bridge runner has multiple unsettled worker identities.");
	const settled = journal.turns.filter((turn) => turn.state === "reply_sent" && turn.worker);
	const store = new BridgeJournalStore(canonicalRoot, journal);
	let stopped = false;
	for (const original of [...unsettled, ...settled]) {
		const turn = store.read().turns.find((candidate) => candidate.eventId === original.eventId)!;
		if (turn.worker?.quiescedAt !== undefined) continue;
		const proof = await quiesceTurn(canonicalRoot, turn);
		stopped = proof.signalled || stopped;
		const quiescedAt = Date.now();
		store.update((state) => ({ ...state, turns: state.turns.map((candidate) => candidate.eventId === turn.eventId ? { ...candidate, worker: { ...candidate.worker!, workerPid: proof.workerPid, workerIdentity: proof.workerIdentity, quiescedAt }, updatedAt: Math.max(candidate.updatedAt, quiescedAt) } : candidate), updatedAt: Math.max(state.updatedAt, quiescedAt) }));
	}
	return stopped ? "quiesced" : "idle";
}

async function quiesceTurn(root: string, turn: BridgeTurn): Promise<{ signalled: boolean; workerPid: number; workerIdentity: string }> {
	if (!turn.worker || !TURN_ID.test(turn.turnId)) throw new Error("Bridge runner turn identity is invalid for stop.");
	const statePath = join(root, "turns", turn.turnId, `attempt-${turn.worker.attempt}`, "worker.v1.json");
	if (resolve(turn.worker.statePath) !== statePath || realpathSync(dirname(statePath)) !== dirname(statePath)) throw new Error("Bridge worker state path escaped its runner root.");
	let worker = readWorkerState(statePath);
	if (!worker && turn.state !== "reply_sent") { await delay(250); worker = readWorkerState(statePath); }
	if (!worker || worker.turnId !== turn.turnId || worker.eventId !== turn.eventId || worker.attempt !== turn.worker.attempt || turn.worker.workerPid !== undefined && turn.worker.workerPid !== worker.workerPid || turn.worker.workerIdentity !== undefined && turn.worker.workerIdentity !== worker.workerIdentity) throw new Error("Bridge worker identity is unavailable or inconsistent during stop.");
	const workerOwned = await ownsProcessIdentity(worker.workerPid, worker.workerIdentity);
	const childOwned = Boolean(worker.childPid && worker.childIdentity && await ownsProcessIdentity(worker.childPid, worker.childIdentity));
	if (!workerOwned && !childOwned) {
		for (let attempt = 0; attempt < 20 && !await isProcessGroupQuiescent(worker.workerPid); attempt++) await delay(25);
		if (!await isProcessGroupQuiescent(worker.workerPid)) throw new Error("Bridge worker group is live without an exact process witness.");
		return { signalled: false, workerPid: worker.workerPid, workerIdentity: worker.workerIdentity };
	}
	if (!workerOwned && worker.childPid && await readProcessGroupId(worker.childPid) !== worker.workerPid) throw new Error("Bridge native child escaped its recorded process group.");
	if (!await quiesceProcessGroup(worker.workerPid, { graceMs: 1_000, killWaitMs: 2_000 }) && !await isProcessGroupQuiescent(worker.workerPid)) throw new Error("Bridge worker group could not be quiesced.");
	if (await ownsProcessIdentity(worker.workerPid, worker.workerIdentity) || worker.childPid && worker.childIdentity && await ownsProcessIdentity(worker.childPid, worker.childIdentity)) throw new Error("Bridge worker identity remained live after group quiescence.");
	return { signalled: true, workerPid: worker.workerPid, workerIdentity: worker.workerIdentity };
}

function delay(ms: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
