import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, pendingHostedEvents } from "../extensions/runtime/service/state.ts";
import { HostedWakeCoordinator } from "../extensions/runtime/service/wake.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	prompts: Array<{ paneId: string; text: string; wakeWasDurable: boolean }> = [];
	onPrompt?: () => boolean;
	verifyBarrier?: Promise<void>;
	onVerify?: () => void;
	constructor(public agent: HostedLiveAgent) {}
	async getPane(): Promise<HostedLiveAgent> { this.onVerify?.(); await this.verifyBarrier; return this.agent; }
	async findTerminal(): Promise<HostedLiveAgent> { this.onVerify?.(); await this.verifyBarrier; return this.agent; }
	async prompt(paneId: string, text: string): Promise<void> { this.prompts.push({ paneId, text, wakeWasDurable: this.onPrompt?.() ?? false }); }
}

function setup(status: HostedLiveAgent["status"] = "idle") {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-wake-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	const watchRoot = join(projectRoot, "reviews");
	const sessionFile = join(root, "session.jsonl");
	mkdirSync(watchRoot, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	const store = new HostedStateStore(join(root, "runtime"));
	const host = new FakeHost({
		paneId: "w1:p1",
		terminalId: "term_1",
		cwd: projectRoot,
		agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile },
		status,
		stateChangeSeq: 1,
	});
	let now = 1_000;
	let registrationNumber = 0;
	const registrations = new RuntimeRegistrationManager(store, host, {
		now: () => now,
		createId: () => `reg_${++registrationNumber}`,
		createKey: () => `key_${registrationNumber}`,
	});
	const input: RegisterPiInput = {
		projectRoot,
		piSessionId: "session_1",
		piSessionFile: sessionFile,
		clientGeneration: "client_1",
		admittedClaims: [],
		herdr: { paneId: "w1:p1", terminalId: "term_1" },
	};
	let wakeNumber = 0;
	let claimNumber = 0;
	const wakes = new HostedWakeCoordinator(store, registrations, host, {
		now: () => now,
		createWakeId: () => `wake_${++wakeNumber}`,
		createClaimId: () => `claim_manual_${++claimNumber}`,
	});
	const monitors = new DirectoryMonitorManager(store, { automatic: false, now: () => now, createId: (prefix) => `${prefix}_wake` });
	return { root, projectRoot, watchRoot, store, host, registrations, input, wakes, monitors, setNow(value: number) { now = value; } };
}

async function enqueue(test: ReturnType<typeof setup>) {
	const registration = await test.registrations.register(test.input);
	const monitor = test.monitors.create(registration.targetKey, test.watchRoot, 0);
	writeFileSync(join(test.watchRoot, "review.md"), "review");
	test.monitors.reconcile(monitor.monitorId);
	test.setNow(1_001);
	test.monitors.reconcile(monitor.monitorId);
	return { registration, event: pendingHostedEvents(test.store.read(), registration.targetKey)[0]! };
}

describe("hosted exact wake and inbox", () => {
	it("records one wake before prompting the exact verified idle agent", async () => {
		const test = setup();
		const { registration } = await enqueue(test);
		test.host.onPrompt = () => test.store.read().wakes[registration.targetKey]?.wakeId === "wake_1";
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		expect(test.host.prompts[0]).toEqual({ paneId: "w1:p1", text: `/pi-kit-runtime-wake 1 ${registration.registrationId} wake_1`, wakeWasDurable: true });
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(2));
		expect(test.host.prompts[1]?.text).toContain(" wake_1");
	});

	it("does not inject wake commands into a focused human editor", async () => {
		const test = setup();
		test.host.agent = { ...test.host.agent, focused: true };
		const { registration, event } = await enqueue(test);
		test.wakes.request(registration.targetKey);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(test.host.prompts).toEqual([]);
		expect(test.store.read().events[event.eventId]?.delivery.status).toBe("pending");
	});

	it("keeps events pending while busy, then follows the same terminal to its moved idle pane", async () => {
		const test = setup("working");
		const { registration } = await enqueue(test);
		test.wakes.request(registration.targetKey);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(test.host.prompts).toEqual([]);
		test.host.agent = { ...test.host.agent, paneId: "w1:p9", status: "idle", stateChangeSeq: 2 };
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		expect(test.host.prompts[0]?.paneId).toBe("w1:p9");
	});

	it("atomically accepts, idempotently returns, acknowledges, and rejects another generation", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		const first = test.wakes.accept(registration, "wake_1");
		expect(first.events.map((candidate) => candidate.eventId)).toEqual([event.eventId]);
		expect(test.store.read().wakes).toEqual({});
		expect(test.wakes.accept(registration, "wake_1").claim.claimId).toBe(first.claim.claimId);
		test.wakes.ack(registration, first.claim.claimId, first.claim.eventIds);
		expect(test.store.read().events[event.eventId]?.delivery.status).toBe("acked");
		const replacement = await test.registrations.register({ ...test.input, clientGeneration: "client_2" });
		expect(() => test.wakes.ack(replacement, first.claim.claimId, first.claim.eventIds)).toThrow(/another registration generation/);
	});

	it("releases an exact claim and rearms pending events with a fresh wake", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		const accepted = test.wakes.accept(registration, "wake_1");
		test.wakes.release(registration, accepted.claim.claimId, accepted.claim.eventIds);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(2));
		expect(test.store.read().events[event.eventId]?.delivery.status).toBe("pending");
		expect(test.host.prompts[1]?.text).toContain(" wake_2");
	});

	it("fails a stale wake safely when a manual claim wins the interleaving", async () => {
		const test = setup();
		const { registration } = await enqueue(test);
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		const manual = test.wakes.claim(registration);
		expect(() => test.wakes.accept(registration, "wake_1")).toThrow(/active delivery claim/);
		test.wakes.ack(registration, manual.claim.claimId, manual.claim.eventIds);
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.store.read().wakes).toEqual({}));
	});

	it("reruns an active wake request and clears routing that changed during verification", async () => {
		const test = setup();
		const { registration } = await enqueue(test);
		let verificationStarted!: () => void;
		let releaseVerification!: () => void;
		const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
		test.host.verifyBarrier = new Promise<void>((resolve) => { releaseVerification = resolve; });
		test.host.onVerify = verificationStarted;
		test.wakes.request(registration.targetKey);
		await started;
		const manual = test.wakes.claim(registration);
		test.wakes.ack(registration, manual.claim.claimId, manual.claim.eventIds);
		releaseVerification();
		await vi.waitFor(() => expect(test.store.read().wakes).toEqual({}));
		expect(test.host.prompts).toEqual([]);
	});

	it("serializes claims for one target even when later events are pending", async () => {
		const test = setup();
		const { registration } = await enqueue(test);
		const first = test.wakes.claim(registration);
		writeFileSync(join(test.watchRoot, "second.md"), "second");
		const monitor = Object.values(test.store.read().monitors)[0]!;
		test.monitors.reconcile(monitor.monitorId);
		test.setNow(1_002);
		test.monitors.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), registration.targetKey)).toHaveLength(1);
		expect(() => test.wakes.claim(registration)).toThrow(/active delivery claim/);
		test.wakes.ack(registration, first.claim.claimId, first.claim.eventIds);
		expect(test.wakes.claim(registration).events).toHaveLength(1);
	});

	it("rebinds a durable old-epoch wake only after the exact Pi target re-registers", async () => {
		const test = setup();
		const { registration } = await enqueue(test);
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		test.wakes.close();
		test.registrations.close();
		test.host.prompts.length = 0;
		const reloadedStore = new HostedStateStore(join(test.root, "runtime"));
		const replacement = new RuntimeRegistrationManager(reloadedStore, test.host, { now: () => 2_000, createId: () => "reg_restart", createKey: () => "key_restart" });
		const replacementWakes = new HostedWakeCoordinator(reloadedStore, replacement, test.host, { now: () => 2_000, createWakeId: () => "wake_restart" });
		const rebound = await replacement.register({ ...test.input, clientGeneration: "client_restart" });
		replacementWakes.request(rebound.targetKey);
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
		expect(test.host.prompts[0]?.text).toBe("/pi-kit-runtime-wake 1 reg_restart wake_restart");
		expect(reloadedStore.read().wakes[rebound.targetKey]).toMatchObject({ registrationId: "reg_restart", wakeId: "wake_restart" });
	});

	it("fails closed when identity changes before a wake", async () => {
		const test = setup();
		const { registration } = await enqueue(test);
		test.host.agent = { ...test.host.agent, terminalId: "term_other" };
		test.wakes.request(registration.targetKey);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(test.host.prompts).toEqual([]);
		expect(test.store.read().wakes).toEqual({});
	});
});
