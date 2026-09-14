import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedDelivery } from "../extensions/runtime/delivery.ts";
import type { InboxEvent, LiveClientRegistration } from "../extensions/runtime/responses.ts";
import type { RuntimeSession } from "../extensions/runtime/runtime-session.ts";
import { HostedSessionStore } from "../extensions/runtime/session-record.ts";
import { RuntimeInbox } from "../extensions/runtime/service/delivery.ts";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, undeliveredHostedEvents } from "../extensions/runtime/service/state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	constructor(public agent: HostedLiveAgent) {}
	async getAgent(): Promise<HostedLiveAgent> { return this.agent; }
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-delivery-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	const watchRoot = join(projectRoot, "reviews");
	const sessionFile = join(root, "session.jsonl");
	mkdirSync(watchRoot, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	const store = new HostedStateStore(join(root, "runtime"));
	let now = 1_000;
	let registrationNumber = 0;
	const registrations = new RuntimeRegistrationManager(store, new FakeHost({ name: "pi-main", cwd: projectRoot }), {
		now: () => now,
		createId: () => `reg_${++registrationNumber}`,
		createKey: () => `key_${registrationNumber}`,
	});
	const input: RegisterPiInput = { projectRoot, piSessionId: "session_1", piSessionFile: sessionFile };
	const inbox = new RuntimeInbox(store, { now: () => now, claimLeaseMs: 500 });
	const monitors = new DirectoryMonitorManager(store, { automatic: false, now: () => now, createId: (prefix) => `${prefix}_delivery` });
	return { root, watchRoot, store, registrations, input, inbox, monitors, setNow(value: number) { now = value; } };
}

async function enqueue(test: ReturnType<typeof setup>, name = "review.md") {
	const registration = await test.registrations.register(test.input);
	const monitor = test.monitors.create(registration.targetKey, test.watchRoot, 0);
	writeFileSync(join(test.watchRoot, name), "review");
	test.monitors.reconcile(monitor.monitorId);
	test.setNow(1_001);
	test.monitors.reconcile(monitor.monitorId);
	return { registration, event: undeliveredHostedEvents(test.store.read(), registration.targetKey)[0]! };
}

function deliveredAt(test: ReturnType<typeof setup>, eventId: string): number | undefined {
	const event = test.store.read().events[eventId];
	return event?.type === "filesystem.created" ? event.deliveredAt : undefined;
}

describe("hosted heartbeat delivery", () => {
	it("hands an event out once per claim and settles it on ack", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		expect(test.inbox.deliver(registration).map((candidate) => candidate.eventId)).toEqual([event.eventId]);
		test.inbox.ack(registration, [event.eventId]);
		expect(deliveredAt(test, event.eventId)).toBe(1_001);
		expect(test.store.read().claims).toEqual({});
		expect(test.inbox.deliver(registration)).toEqual([]);
	});

	it("does not re-hand a live claim to a second heartbeat", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		expect(test.inbox.deliver(registration).map((candidate) => candidate.eventId)).toEqual([event.eventId]);
		expect(test.inbox.deliver(registration)).toEqual([]);
		expect(test.inbox.status(registration)).toEqual({ undelivered: 1, delivered: 0 });
	});

	it("re-hands an undelivered event once its claim expires", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		test.inbox.deliver(registration);
		test.setNow(1_501);
		expect(test.inbox.deliver(registration).map((candidate) => candidate.eventId)).toEqual([event.eventId]);
	});

	it("ignores an ack that names another target", async () => {
		const test = setup();
		const { registration, event } = await enqueue(test);
		const foreign = { ...registration, targetKey: "pi_other" };
		test.inbox.ack(foreign, [event.eventId]);
		expect(deliveredAt(test, event.eventId)).toBeUndefined();
	});
});

function piStub(store: HostedSessionStore, branch: Array<Record<string, unknown>>, sent: string[]) {
	return {
		store,
		isActive: true,
		client: { call: async () => ({ settled: true }) },
		pi: {
			sendMessage(message: { content: string }) { sent.push(message.content); },
			appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
		},
	} as unknown as RuntimeSession;
}

function inboxEvent(eventId: string): InboxEvent {
	return { eventId, type: "filesystem.created", summary: `new file: ${eventId}`, path: `/tmp/${eventId}.md` };
}

describe("pi-side admission", () => {
	it("skips an event its durable seen-set already admitted", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const sent: string[] = [];
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		const store = new HostedSessionStore(pi);
		const ctx = {
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getBranch: () => branch, getSessionId: () => "session_1", getSessionFile: () => "/tmp/session.jsonl" },
			ui: { notify: () => {} },
			cwd: "/tmp",
		} as unknown as ExtensionContext;
		store.restore(ctx);
		const registration: LiveClientRegistration = { targetKey: "pi_session_1", registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 31_000 };
		const delivery = new HostedDelivery(piStub(store, branch, sent));

		await delivery.admit(registration, ctx, [inboxEvent("evt_1")]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("evt_1");

		// A crash before the ack re-delivers the same event; the restored seen-set must not admit it twice.
		const restored = new HostedSessionStore(pi);
		restored.restore(ctx);
		const afterRestart = new HostedDelivery(piStub(restored, branch, sent));
		await afterRestart.admit(registration, ctx, [inboxEvent("evt_1"), inboxEvent("evt_2")]);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("evt_2");
		expect(sent[1]).not.toContain("evt_1");
	});

	it("admits nothing while the session is busy", async () => {
		const branch: Array<Record<string, unknown>> = [];
		const sent: string[] = [];
		const pi = { appendEntry() {} } as unknown as ExtensionAPI;
		const store = new HostedSessionStore(pi);
		const busy = { isIdle: () => true, hasPendingMessages: () => true } as unknown as ExtensionContext;
		const registration: LiveClientRegistration = { targetKey: "pi_session_1", registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 31_000 };
		await new HostedDelivery(piStub(store, branch, sent)).admit(registration, busy, [inboxEvent("evt_1")]);
		expect(sent).toEqual([]);
	});
});
