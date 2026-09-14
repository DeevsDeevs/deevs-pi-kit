import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedAgentTarget, HostedTarget } from "../extensions/runtime/hosted-types.ts";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { HostedParticipantCoordinator, HostedParticipantError } from "../extensions/runtime/service/participant.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type HostedLiveRegistration, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { deriveAgentTargetKey, HostedStateStore, pendingHostedEvents } from "../extensions/runtime/service/state.ts";
import { HostedWakeCoordinator } from "../extensions/runtime/service/wake.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class MultiHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	prompts: Array<{ paneId: string; text: string }> = [];

	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		const agent = this.agents.get(agentName);
		if (!agent) throw Object.assign(new Error("missing agent"), { code: "identity_mismatch" });
		return agent;
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
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		inputs.set(name, { projectRoot, piSessionId: sessionId, piSessionFile: sessionFile, admittedClaims: [] });
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
		startedAt: 1_000,
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
		expect(test.participants.get(main, mainParticipant.participantKey)).toMatchObject({ holderLive: true, unreadMail: 0 });
		expect(test.participants.list(main).map((participant) => participant.participantId)).toEqual(["fable", "main"]);
		expect(test.participants.list(main)[0]).not.toHaveProperty("unreadMail");
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

	it("excludes ordinary managed mail from the bound agent inbox and preserves Monitor delivery", async () => {
		const test = setup();
		const { main, fable, mainParticipant, fableParticipant } = await acquirePair(test);
		const vacant = test.participants.standDown(fable, fableParticipant.participantKey);
		const agentName = "collab-managed";
		const managedTarget: HostedAgentTarget = {
			kind: "agent",
			targetKey: deriveAgentTargetKey(test.projectRoot, agentName),
			projectRoot: test.projectRoot,
			agentName,
			driver: "codex",
			participantKey: fableParticipant.participantKey,
			holderGeneration: "lease_managed",
			profile: "read-only",
			herdr: { tabId: "w1:t9", workspaceId: "w1" },
			createdAt: 1_000,
		};
		test.store.apply({ type: "agent.bind", bind: { target: managedTarget, protocol: "review", participantId: "fable", callerTargetKey: main.targetKey, callerParticipantKey: mainParticipant.participantKey, callerGeneration: mainParticipant.generation, expectedParticipantGeneration: vacant.generation, at: 1_001 } });
		const managedRegistration: HostedLiveRegistration = { targetKey: managedTarget.targetKey, registrationId: "reg_managed", registrationKey: "key_managed", leaseUntil: 31_000 };
		const managed = test.participants.get(main, fableParticipant.participantKey);
		expect(managed).toMatchObject({ state: "held", holderTargetKey: managedTarget.targetKey, generation: "lease_managed" });
		expect(test.participants.list(main).find((participant) => participant.participantId === "fable")).toMatchObject({ driver: "codex", profile: "read-only" });
		const ordinary = test.participants.send(main, mainParticipant.participantKey, mainParticipant.generation, managed.participantKey, "send_managed", "Please inspect.");
		let managedClaim = 0;
		const wakes = new HostedWakeCoordinator(test.store, { now: () => 1_001, createClaimId: () => `claim_managed_${++managedClaim}` });
		expect(() => wakes.claim(managedRegistration, 1)).toThrow("Inbox has no pending events");
		expect(test.store.read().events[ordinary.eventId]?.delivery).toEqual({ status: "pending" });
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false });
		const monitor = monitors.create(managedTarget.targetKey, test.projectRoot, 0);
		const nativeEvent = (name: string) => {
			writeFileSync(join(test.projectRoot, name), "native monitor input");
			monitors.reconcile(monitor.monitorId);
			monitors.reconcile(monitor.monitorId);
			return Object.values(test.store.read().events).find(event => event.type === "filesystem.created" && event.payload.relativePath === name)!;
		};
		const message = nativeEvent("monitored.txt");
		const claim = wakes.claim(managedRegistration, 1);
		expect(claim.events.map((event) => event.eventId)).toEqual([message.eventId]);
		expect(wakes.status(managedRegistration)).toMatchObject({ pending: 0, claimed: 1, acknowledged: 0 });
		wakes.ack(managedRegistration, claim.claim.claimId, claim.claim.eventIds);
		expect(test.store.read().events[message.eventId]?.delivery.status).toBe("acked");
		const released = nativeEvent("released.txt");
		const second = wakes.claim(managedRegistration, 1);
		wakes.release(managedRegistration, second.claim.claimId, second.claim.eventIds);
		expect(pendingHostedEvents(test.store.read(), managedTarget.targetKey).map((event) => event.eventId)).toEqual([released.eventId]);
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
		expect(stopped).toMatchObject({ outcome: "stopped", participant: { state: "vacant", unreadMail: 1 } });
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

	it("blocks takeover after a Runtime restart until reconnect grace elapses", async () => {
		const test = setup();
		const { fableParticipant } = await acquirePair(test);
		test.registrations.close();
		let now = 2_000;
		let id = 0;
		const registrations = new RuntimeRegistrationManager(test.store, test.host, { now: () => now, createId: () => `restart_reg_${++id}`, createKey: () => `restart_key_${id}` });
		const successor = await registrations.register(test.inputs.get("successor")!);
		const participants = new HostedParticipantCoordinator(test.store, registrations, { request() {} }, { now: () => now, startedAt: 2_000, reconnectGraceMs: 60_000, createGeneration: () => "lease_after_restart" });
		participants.registrationReady(successor.targetKey);
		expect(() => participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toThrow(expect.objectContaining({ code: "busy" }));
		now = 62_001;
		expect(participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toMatchObject({ holderTargetKey: successor.targetKey });
	});

	it("does not treat a target-scoped filesystem claim as participant takeover authority", async () => {
		const test = setup();
		const { fable, fableParticipant } = await acquirePair(test);
		const successor = await register(test, "successor");
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false });
		const monitor = monitors.create(fable.targetKey, test.projectRoot, 0);
		writeFileSync(join(test.projectRoot, "created.txt"), "created\n");
		monitors.reconcile(monitor.monitorId);
		monitors.reconcile(monitor.monitorId);
		const event = pendingHostedEvents(test.store.read(), fable.targetKey).find((candidate) => candidate.type === "filesystem.created")!;
		test.store.apply({ type: "inbox.claim", claim: { claimId: "claim_filesystem", targetKey: fable.targetKey, registrationId: fable.registrationId, eventIds: [event.eventId], createdAt: 1_000, leaseUntil: 2_000, status: "active" } });
		test.registrations.unregister(fable.registrationId, fable.registrationKey);
		expect(test.participants.takeover(successor, fableParticipant.participantKey, fableParticipant.generation)).toMatchObject({ holderTargetKey: successor.targetKey });
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
		const context: HostedProtocolContext = { runtimeId: "rt_test", agentWake: "none", registrations: test.registrations, monitors, wakes, participants: test.participants };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		expect(await call("hello", { minVersion: 1, maxVersion: 1 })).toMatchObject({ ok: true, result: { capabilities: { mailbox: { maxBodyBytes: 16_384 } } } });
		let mainAuth = { registrationId: main.registrationId, registrationKey: main.registrationKey };
		const fableAuth = { registrationId: fable.registrationId, registrationKey: fable.registrationKey };
		const acquiredMain = await call("participant.acquire", { ...mainAuth, protocol: "review", participantId: "main" });
		const acquiredFable = await call("participant.acquire", { ...fableAuth, protocol: "review", participantId: "fable" });
		const sender = (acquiredMain as { result: { participant: { participantKey: string; generation: string } } }).result.participant;
		const recipient = (acquiredFable as { result: { participant: { participantKey: string; generation: string } } }).result.participant;
		expect(acquiredMain).toMatchObject({ ok: true, result: { participant: { participantId: "main" }, revived: false } });
		test.setNow(1_001);
		test.registrations.unregister(mainAuth.registrationId, mainAuth.registrationKey);
		const reconnectedMain = await register(test, "main");
		mainAuth = { registrationId: reconnectedMain.registrationId, registrationKey: reconnectedMain.registrationKey };
		expect(await call("mailbox.send", { ...mainAuth, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: recipient.participantKey, sendId: "send_rpc", body: "Review RPC." })).toMatchObject({ ok: true, result: { sequence: 1 } });
		expect(await call("mailbox.send", { ...mainAuth, senderParticipantKey: sender.participantKey, expectedSenderGeneration: "stale", recipientParticipantKey: recipient.participantKey, sendId: "send_stale", body: "Wrong sender." })).toMatchObject({ ok: false, error: { code: "conflict" } });
		expect(await call("participant.get", { ...mainAuth, participantKey: recipient.participantKey })).toMatchObject({ ok: true, result: { unreadMail: 1 } });
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
