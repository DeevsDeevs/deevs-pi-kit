import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedTarget } from "../extensions/runtime/hosted-types.ts";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { HostedParticipantCoordinator, HostedParticipantError } from "../extensions/runtime/service/participant.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type HostedLiveRegistration, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, pendingHostedEvents } from "../extensions/runtime/service/state.ts";
import { HostedWakeCoordinator } from "../extensions/runtime/service/wake.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class MultiHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	prompts: Array<{ paneId: string; text: string }> = [];

	async getPane(paneId: string): Promise<HostedLiveAgent> {
		const agent = this.agents.get(paneId);
		if (!agent) throw Object.assign(new Error("missing pane"), { code: "identity_mismatch" });
		return agent;
	}

	async findTerminal(terminalId: string): Promise<HostedLiveAgent> {
		const matches = [...this.agents.values()].filter((agent) => agent.terminalId === terminalId);
		if (matches.length !== 1) throw Object.assign(new Error("missing terminal"), { code: "identity_mismatch" });
		return matches[0]!;
	}

	async prompt(paneId: string, text: string): Promise<void> { this.prompts.push({ paneId, text }); }
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "hosted-participant-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	mkdirSync(projectRoot);
	const host = new MultiHost();
	const inputs = new Map<string, RegisterPiInput>();
	for (const name of ["main", "fable", "successor"]) {
		const sessionFile = join(root, `${name}.jsonl`);
		const sessionId = `session_${name}`;
		const paneId = `w1:p${inputs.size + 1}`;
		const terminalId = `terminal_${name}`;
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		host.agents.set(paneId, { paneId, terminalId, cwd: projectRoot, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, status: "idle", stateChangeSeq: 1 });
		inputs.set(name, { projectRoot, piSessionId: sessionId, piSessionFile: sessionFile, clientGeneration: `client_${name}`, admittedClaims: [], herdr: { paneId, terminalId } });
	}
	const store = new HostedStateStore(join(root, "runtime"));
	let now = 1_000;
	let registrationNumber = 0;
	const registrations = new RuntimeRegistrationManager(store, host, { now: () => now, createId: () => `reg_${++registrationNumber}`, createKey: () => `key_${registrationNumber}` });
	const requested: string[] = [];
	let generationNumber = 0;
	let eventNumber = 0;
	let stopOutcome: "closed" | "already_absent" | "unmanaged" = "closed";
	const stoppedTargets: string[] = [];
	let stopTarget = async (target: HostedTarget) => { stoppedTargets.push(target.targetKey); return stopOutcome; };
	const participants = new HostedParticipantCoordinator(store, registrations, { request: (targetKey) => requested.push(targetKey) }, {
		now: () => now,
		epochStartedAt: 1_000,
		createGeneration: () => `lease_${++generationNumber}`,
		createEventId: () => `event_${++eventNumber}`,
		stopTarget: (target) => stopTarget(target),
	});
	return { root, projectRoot, host, inputs, store, registrations, participants, requested, stoppedTargets, setStopOutcome(value: typeof stopOutcome) { stopOutcome = value; }, setStopTarget(value: typeof stopTarget) { stopTarget = value; }, setNow(value: number) { now = value; } };
}

async function register(test: ReturnType<typeof setup>, name: string): Promise<HostedLiveRegistration> {
	const registration = await test.registrations.register(test.inputs.get(name)!);
	test.participants.registrationReady(registration.targetKey);
	return registration;
}

async function acquirePair(test: ReturnType<typeof setup>) {
	const main = await register(test, "main");
	const fable = await register(test, "fable");
	const mainParticipant = test.participants.acquire(main, "review", "main").participant;
	const fableParticipant = test.participants.acquire(fable, "review", "fable").participant;
	return { main, fable, mainParticipant, fableParticipant };
}

describe("hosted participant coordinator", () => {
	it("acquires, reads, lists, and idempotently reacquires one identity", async () => {
		const test = setup();
		const { main, mainParticipant } = await acquirePair(test);
		const retry = test.participants.acquire(main, "review", "main");
		expect(retry).toMatchObject({ revived: false, participant: { generation: mainParticipant.generation } });
		expect(test.participants.get(main, mainParticipant.participantKey)).toMatchObject({ holderLive: true, queued: { pending: 0, claimed: 0 } });
		expect(test.participants.list(main).map((participant) => participant.participantId)).toEqual(["fable", "main"]);
		expect(test.participants.list(main)[0]).not.toHaveProperty("queued");
	});

	it("sends idempotently, wakes a held recipient, and queues while vacant", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		const first = test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_1", "Please review.");
		expect(test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_1", "Please review.").eventId).toBe(first.eventId);
		expect(test.requested.at(-1)).toBe(fable.targetKey);
		test.participants.standDown(fable, fableParticipant.participantKey);
		const queued = test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_2", "Queued review.");
		expect(pendingHostedEvents(test.store.read(), fable.targetKey).map((event) => event.eventId)).not.toContain(queued.eventId);
		expect(() => test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_1", "Changed.")).toThrow(expect.objectContaining({ code: "conflict" }));
	});

	it("settles bounded tasks once with deterministic typed results", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		const task = test.participants.sendTask(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "task_1", "Review the exact change.");
		expect(task).toMatchObject({ type: "mailbox.task", payload: { sendId: "task_1" } });
		expect(test.participants.taskStatus(main, mainParticipant.participantKey, mainParticipant.generation, task.eventId)).toEqual({ eventId: task.eventId, recipientParticipantKey: fableParticipant.participantKey, status: "pending" });
		const result = test.participants.resultTask(fable, fableParticipant.participantKey, fableParticipant.generation, task.eventId, "reply_task_1", "completed", "Reviewed.", "committed");
		expect(result).toMatchObject({ type: "mailbox.task_result", payload: { inReplyToEventId: task.eventId, replyId: "reply_task_1", status: "completed", body: "Reviewed.", sessionAdvance: "committed" } });
		expect(test.participants.resultTask(fable, fableParticipant.participantKey, fableParticipant.generation, task.eventId, "reply_task_1", "completed", "Reviewed.", "committed").eventId).toBe(result.eventId);
		expect(test.participants.taskStatus(main, mainParticipant.participantKey, mainParticipant.generation, task.eventId)).toMatchObject({ status: "completed", resultEventId: result.eventId, replyId: "reply_task_1", body: "Reviewed.", sessionAdvance: "committed" });
		expect(() => test.participants.resultTask(fable, fableParticipant.participantKey, fableParticipant.generation, task.eventId, "reply_task_1", "failed", "Changed.", "committed")).toThrow(expect.objectContaining({ code: "conflict" }));
		expect(() => test.participants.resultTask(fable, fableParticipant.participantKey, fableParticipant.generation, task.eventId, "reply_task_other", "completed", "Reviewed.", "committed")).toThrow(expect.objectContaining({ code: "conflict" }));
		expect(() => test.participants.taskStatus(fable, fableParticipant.participantKey, fableParticipant.generation, task.eventId)).toThrow(expect.objectContaining({ code: "not_found" }));
	});

	it("rejects cross-protocol send after a target changes identity", async () => {
		const test = setup();
		const { main, mainParticipant, fableParticipant } = await acquirePair(test);
		test.participants.standDown(main, mainParticipant.participantKey);
		test.participants.acquire(main, "other", "main");
		expect(() => test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_cross_protocol", "Wrong protocol.")).toThrow(expect.objectContaining({ code: "conflict" }));
	});

	it("allows a confirmed same-project target to generation-fence a live collaborator stand-down", async () => {
		const test = setup();
		const { main, fable, fableParticipant } = await acquirePair(test);
		test.requested.length = 0;
		expect(() => test.participants.standDownConfirmed(main, fableParticipant.participantKey, "stale_generation")).toThrow(expect.objectContaining({ code: "conflict" }));
		const vacant = test.participants.standDownConfirmed(main, fableParticipant.participantKey, fableParticipant.generation);
		expect(vacant).toMatchObject({ state: "vacant", holderLive: false, lastTransition: { cause: "stand_down", previousGeneration: fableParticipant.generation } });
		expect(test.requested).toEqual([fable.targetKey, main.targetKey]);
		expect(test.participants.standDownConfirmed(main, fableParticipant.participantKey, fableParticipant.generation).generation).toBe(vacant.generation);
	});

	it("stops an exact other target, preserves mail, and converges when retried", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "queued", "Keep me.");
		await expect(test.participants.stopConfirmed(fable, fableParticipant.participantKey, fableParticipant.generation)).rejects.toMatchObject({ code: "conflict" });
		await expect(test.participants.stopConfirmed(main, fableParticipant.participantKey, "stale")).rejects.toMatchObject({ code: "conflict" });
		expect(test.stoppedTargets).toEqual([]);
		const stopped = await test.participants.stopConfirmed(main, fableParticipant.participantKey, fableParticipant.generation);
		expect(stopped).toMatchObject({ outcome: "stopped", participant: { state: "vacant", queued: { pending: 1 } } });
		expect(test.stoppedTargets).toEqual([fable.targetKey]);
		test.setStopOutcome("already_absent");
		const lostResponseRetry = await test.participants.stopConfirmed(main, fableParticipant.participantKey, fableParticipant.generation);
		expect(lostResponseRetry).toMatchObject({ outcome: "already_stopped", participant: { state: "vacant", generation: stopped.participant.generation } });
		const observedRetry = await test.participants.stopConfirmed(main, fableParticipant.participantKey, stopped.participant.generation);
		expect(observedRetry).toMatchObject({ outcome: "already_stopped", participant: { state: "vacant", generation: stopped.participant.generation } });
	});

	it("refuses to stop a target that now holds another participant", async () => {
		const test = setup();
		const { main, fable, fableParticipant } = await acquirePair(test);
		const vacant = test.participants.standDown(fable, fableParticipant.participantKey);
		const other = test.participants.acquire(fable, "review", "other").participant;
		await expect(test.participants.stopConfirmed(main, fableParticipant.participantKey, vacant.generation)).rejects.toMatchObject({ code: "conflict" });
		expect(test.stoppedTargets).toEqual([]);
		expect(test.participants.get(fable, other.participantKey)).toMatchObject({ state: "held", holderTargetKey: fable.targetKey });
	});

	it("fences identity changes while an exact collaborator tab is stopping", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		let releaseStop!: () => void;
		let stopStarted!: () => void;
		const barrier = new Promise<void>((resolve) => { releaseStop = resolve; });
		const started = new Promise<void>((resolve) => { stopStarted = resolve; });
		test.setStopTarget(async (target) => {
			test.stoppedTargets.push(target.targetKey);
			stopStarted();
			await barrier;
			return "closed";
		});
		const stopping = test.participants.stopConfirmed(main, fableParticipant.participantKey, fableParticipant.generation);
		await started;
		expect(() => test.participants.acquire(fable, "review", "fable")).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => test.participants.acquire(fable, "review", "other")).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => test.participants.standDownConfirmed(main, fableParticipant.participantKey, fableParticipant.generation)).toThrow(expect.objectContaining({ code: "busy" }));
		expect(() => test.participants.send(fable, fableParticipant.participantKey, fableParticipant.generation, mainParticipant.participantKey, "during_stop", "No send.")).toThrow(expect.objectContaining({ code: "busy" }));
		releaseStop();
		expect(await stopping).toMatchObject({ outcome: "stopped", participant: { state: "vacant" } });
	});

	it("does not mutate an unmanaged collaborator target", async () => {
		const test = setup();
		const { main, fableParticipant } = await acquirePair(test);
		test.setStopOutcome("unmanaged");
		const result = await test.participants.stopConfirmed(main, fableParticipant.participantKey, fableParticipant.generation);
		expect(result).toMatchObject({ outcome: "unmanaged", participant: { state: "held", generation: fableParticipant.generation } });
	});

	it("rejects live or stale-generation takeover and allows it after a seen holder unregisters", async () => {
		const test = setup();
		const { fable, fableParticipant } = await acquirePair(test);
		const successor = await register(test, "successor");
		expect(() => test.participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toThrow(HostedParticipantError);
		test.registrations.unregister(fable.registrationId, fable.registrationKey);
		test.requested.length = 0;
		expect(() => test.participants.takeover(successor, fableParticipant.participantKey, "stale_generation")).toThrow(expect.objectContaining({ code: "conflict" }));
		const taken = test.participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation);
		expect(taken).toMatchObject({ state: "held", holderTargetKey: successor.targetKey, lastTransition: { cause: "takeover" } });
		expect(test.requested).toEqual([fable.targetKey, successor.targetKey]);
		expect(test.participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation).generation).toBe(taken.generation);
	});

	it("blocks takeover during a fresh Runtime epoch until reconnect grace elapses", async () => {
		const test = setup();
		const { fableParticipant } = await acquirePair(test);
		test.registrations.close();
		let now = 2_000;
		let id = 0;
		const registrations = new RuntimeRegistrationManager(test.store, test.host, { now: () => now, createId: () => `restart_reg_${++id}`, createKey: () => `restart_key_${id}` });
		const successor = await registrations.register(test.inputs.get("successor")!);
		const participants = new HostedParticipantCoordinator(test.store, registrations, { request() {} }, { now: () => now, epochStartedAt: 2_000, reconnectGraceMs: 60_000, createGeneration: () => "lease_after_restart" });
		participants.registrationReady(successor.targetKey);
		expect(() => participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toThrow(expect.objectContaining({ code: "busy" }));
		now = 62_001;
		expect(participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toMatchObject({ holderTargetKey: successor.targetKey });
	});

	it("waits for an old holder claim to expire before takeover", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		const successor = await register(test, "successor");
		const event = test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_claimed", "Claim me.");
		test.store.apply({ type: "inbox.claim", claim: { claimId: "claim_old", targetKey: fable.targetKey, registrationId: fable.registrationId, clientGeneration: fable.clientGeneration, eventIds: [event.eventId], createdAt: 1_000, leaseUntil: 1_100, status: "active" } });
		test.registrations.unregister(fable.registrationId, fable.registrationKey);
		expect(() => test.participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toThrow(expect.objectContaining({ code: "busy" }));
		test.setNow(1_101);
		expect(test.participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toMatchObject({ holderTargetKey: successor.targetKey });
		expect(pendingHostedEvents(test.store.read(), successor.targetKey).map((candidate) => candidate.eventId)).toEqual([event.eventId]);
	});

	it("reports revival and rejects sends to ended participants", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		test.participants.release(fable, fableParticipant.participantKey);
		expect(() => test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, fableParticipant.participantKey, "send_ended", "No receiver.")).toThrow(expect.objectContaining({ code: "not_found" }));
		expect(() => test.participants.acquire(fable, "review", "fable")).toThrow(expect.objectContaining({ code: "conflict" }));
		const revived = test.participants.acquire(fable, "review", "fable", true);
		expect(revived).toMatchObject({ revived: true, participant: { state: "held" } });
		expect(test.participants.acquire(fable, "review", "fable")).toMatchObject({ revived: true, participant: { generation: revived.participant.generation } });
	});

	it("rejects send when the caller holds no participant identity", async () => {
		const test = setup();
		const main = await register(test, "main");
		const fable = await register(test, "fable");
		const recipient = test.participants.acquire(fable, "review", "fable").participant;
		expect(() => test.participants.send(main, "participant_missing", "lease_missing", recipient.participantKey, "send_without_identity", "No sender.")).toThrow(expect.objectContaining({ code: "not_found" }));
	});
});

describe("participant and mailbox RPC", () => {
	it("advertises and strictly authorizes the collaborator method surface", async () => {
		const test = setup();
		const main = await register(test, "main");
		const fable = await register(test, "fable");
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false });
		const wakes = new HostedWakeCoordinator(test.store);
		const context: HostedProtocolContext = { runtimeId: "rt_test", epoch: "epoch_test", agentWake: "none", registrations: test.registrations, monitors, wakes, participants: test.participants };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		expect(await call("hello", { minVersion: 1, maxVersion: 1 })).toMatchObject({ ok: true, result: { capabilities: { mailbox: { maxBodyBytes: 16_384 } } } });
		let mainAuth = { registrationId: main.registrationId, registrationKey: main.registrationKey };
		const fableAuth = { registrationId: fable.registrationId, registrationKey: fable.registrationKey };
		const acquiredMain = await call("participant.acquire", { ...mainAuth, protocol: "review", participantId: "main" });
		const acquiredFable = await call("participant.acquire", { ...fableAuth, protocol: "review", participantId: "fable" });
		const sender = (acquiredMain as { result: { participant: { participantKey: string; generation: string } } }).result.participant;
		const recipient = (acquiredFable as { result: { participant: { participantKey: string; generation: string } } }).result.participant;
		expect(acquiredMain).toMatchObject({ ok: true, result: { participant: { participantId: "main" }, revived: false } });
		const capacity = { operationId: "auto_op_rpc", protocol: "review", callerParticipantId: "main", expectedCallerGeneration: sender.generation, participantIds: ["other"] };
		expect(await call("participant.auto_capacity.reserve", { ...mainAuth, ...capacity })).toMatchObject({ ok: true, result: { reservation: { operationId: "auto_op_rpc", createdAt: 1_000, participantKeys: [expect.any(String)] } } });
		test.setNow(1_001);
		test.registrations.unregister(mainAuth.registrationId, mainAuth.registrationKey);
		const reconnectedMain = await register(test, "main");
		mainAuth = { registrationId: reconnectedMain.registrationId, registrationKey: reconnectedMain.registrationKey };
		expect(await call("participant.auto_capacity.reserve", { ...mainAuth, ...capacity })).toMatchObject({ ok: true, result: { reservation: { operationId: "auto_op_rpc", createdAt: 1_000 } } });
		expect(await call("participant.auto_capacity.reserve", { ...mainAuth, ...capacity, participantIds: ["changed"] })).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await call("participant.auto_capacity.list", mainAuth)).toMatchObject({ ok: true, result: { reservations: [{ operationId: "auto_op_rpc" }] } });
		expect(await call("participant.auto_capacity.recover", { ...fableAuth, operationId: "auto_op_rpc", confirmedAbsent: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await call("participant.auto_capacity.recover", { ...mainAuth, operationId: "auto_op_rpc", confirmedAbsent: false })).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await call("participant.auto_capacity.recover", { ...mainAuth, operationId: "auto_op_rpc", confirmedAbsent: true })).toMatchObject({ ok: true, result: { released: true, confirmedAbsent: true } });
		expect(await call("participant.auto_capacity.release", { ...mainAuth, operationId: "auto_op_rpc" })).toMatchObject({ ok: true, result: { released: true } });

		const settledCapacity = { ...capacity, operationId: "auto_op_settled", participantIds: ["fable"] };
		expect(await call("participant.auto_capacity.reserve", { ...mainAuth, ...settledCapacity })).toMatchObject({ ok: true });
		expect(await call("participant.auto_capacity.recover", { ...mainAuth, operationId: "auto_op_settled", confirmedAbsent: false })).toMatchObject({ ok: true, result: { released: true, confirmedAbsent: false } });
		expect(await call("mailbox.send", { ...mainAuth, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: recipient.participantKey, sendId: "send_rpc", body: "Review RPC." })).toMatchObject({ ok: true, result: { sequence: 1 } });
		expect(await call("mailbox.send", { ...mainAuth, senderParticipantKey: sender.participantKey, expectedSenderGeneration: "stale", recipientParticipantKey: recipient.participantKey, sendId: "send_stale", body: "Wrong sender." })).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await call("participant.get", { ...mainAuth, participantKey: recipient.participantKey })).toMatchObject({ ok: true, result: { queued: { pending: 1 } } });
		expect(await call("participant.list", mainAuth)).toMatchObject({ ok: true, result: { participants: [{ participantId: "fable" }, { participantId: "main" }] } });
		expect(await call("participant.acquire", { ...mainAuth, protocol: "review", participantId: "bad", extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("participant.acquire", { ...mainAuth, protocol: "Review", participantId: "bad" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("participant.list", { ...mainAuth, registrationKey: "wrong" })).toMatchObject({ ok: false, error: { code: "registration_stale" } });
		expect(await call("mailbox.send", { ...mainAuth, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: recipient.participantKey, sendId: "bad_extra", body: "x", extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("participant.takeover", { ...mainAuth, participantKey: recipient.participantKey, expectedGeneration: recipient.generation, confirmed: false })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("participant.stand_down_confirmed", { ...mainAuth, participantKey: recipient.participantKey, expectedGeneration: recipient.generation, confirmed: false })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("participant.stop_confirmed", { ...mainAuth, participantKey: recipient.participantKey, expectedGeneration: recipient.generation, confirmed: false })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("participant.stop_confirmed", { ...mainAuth, participantKey: recipient.participantKey, expectedGeneration: recipient.generation, confirmed: true })).toMatchObject({ ok: true, result: { outcome: "stopped", participant: { state: "vacant" } } });
		expect(await call("participant.stand_down_confirmed", { ...mainAuth, participantKey: recipient.participantKey, expectedGeneration: recipient.generation, confirmed: true })).toMatchObject({ ok: true, result: { state: "vacant" } });
		expect(await call("participant.get", { ...mainAuth, participantKey: recipient.participantKey, extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});
});
