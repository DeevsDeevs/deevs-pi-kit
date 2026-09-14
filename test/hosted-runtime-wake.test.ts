import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, pendingHostedEvents } from "../extensions/runtime/service/state.ts";
import { HostedWakeCoordinator } from "../extensions/runtime/service/wake.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	getAgentCalls = 0;
	constructor(public agent: HostedLiveAgent) {}
	async getAgent(): Promise<HostedLiveAgent> { this.getAgentCalls++; return this.agent; }
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-wake-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	const watchRoot = join(projectRoot, "reviews");
	const sessionFile = join(root, "session.jsonl");
	mkdirSync(watchRoot, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	const store = new HostedStateStore(join(root, "runtime"));
	const host = new FakeHost({ name: "pi-main", cwd: projectRoot });
	let now = 1_000;
	let registrationNumber = 0;
	const registrations = new RuntimeRegistrationManager(store, host, {
		now: () => now,
		createId: () => `reg_${++registrationNumber}`,
		createKey: () => `key_${registrationNumber}`,
	});
	const input: RegisterPiInput = { projectRoot, piSessionId: "session_1", piSessionFile: sessionFile, admittedClaims: [] };
	let claimNumber = 0;
	const wakes = new HostedWakeCoordinator(store, {
		now: () => now,
		createClaimId: () => `claim_manual_${++claimNumber}`,
	});
	const monitors = new DirectoryMonitorManager(store, { automatic: false, now: () => now, createId: (prefix) => `${prefix}_wake` });
	return { root, watchRoot, store, host, registrations, input, wakes, monitors, setNow(value: number) { now = value; } };
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

describe("hosted heartbeat inbox", () => {
	it("leaves pending events for heartbeat admission without invoking Herdr", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		const verificationCalls = test.host.getAgentCalls;
		test.wakes.request(registration.targetKey);
		await vi.waitFor(() => expect(test.store.read().events[event.eventId]?.delivery.status).toBe("pending"));
		expect(test.host.getAgentCalls).toBe(verificationCalls);
		expect(test.store.read().wakes).toEqual({});
	});

	it("claims, acknowledges, and rejects another registration", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		const first = test.wakes.claim(registration);
		expect(first.events.map((candidate) => candidate.eventId)).toEqual([event.eventId]);
		test.wakes.ack(registration, first.claim.claimId, first.claim.eventIds);
		expect(test.store.read().events[event.eventId]?.delivery.status).toBe("acked");
		const replacement = await test.registrations.register(test.input);
		expect(() => test.wakes.ack(replacement, first.claim.claimId, first.claim.eventIds)).toThrow(/another registration/);
	});

	it("releases an exact claim for the next heartbeat", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		const first = test.wakes.claim(registration);
		test.wakes.release(registration, first.claim.claimId, first.claim.eventIds);
		expect(test.store.read().events[event.eventId]?.delivery.status).toBe("pending");
		expect(test.wakes.claim(registration).events.map((candidate) => candidate.eventId)).toEqual([event.eventId]);
	});

	it("serializes claims for one target while later events remain pending", async () => {
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

	it("accepts a durable legacy wake without creating new prompt wakes", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		test.store.apply({ type: "wake.set", wake: { wakeId: "wake_legacy", targetKey: registration.targetKey, registrationId: registration.registrationId, createdAt: 1_001 } });
		const accepted = test.wakes.accept(registration, "wake_legacy");
		expect(accepted.events.map((candidate) => candidate.eventId)).toEqual([event.eventId]);
		expect(test.store.read().wakes).toEqual({});
	});
});
