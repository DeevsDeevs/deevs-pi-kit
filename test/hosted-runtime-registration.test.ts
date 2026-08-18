import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import {
	deriveTargetKey,
	RegistrationError,
	RuntimeRegistrationManager,
	type HostedHostVerifier,
	type HostedLiveAgent,
	type RegisterPiInput,
} from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, pendingHostedEvents } from "../extensions/runtime/service/state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	agent: HostedLiveAgent;
	available = true;
	findBarrier?: Promise<void>;

	constructor(agent: HostedLiveAgent) { this.agent = agent; }
	async getPane(_paneId: string): Promise<HostedLiveAgent> {
		if (!this.available) throw new RegistrationError("host_unavailable", "offline");
		return this.agent;
	}
	async findTerminal(_terminalId: string): Promise<HostedLiveAgent> {
		if (!this.available) throw new RegistrationError("host_unavailable", "offline");
		await this.findBarrier;
		return this.agent;
	}
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-registration-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	const watchRoot = join(projectRoot, "reviews");
	const sessionFile = join(root, "session.jsonl");
	mkdirSync(watchRoot, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	const store = new HostedStateStore(join(root, "runtime"));
	const agent: HostedLiveAgent = {
		paneId: "w1:p1",
		terminalId: "term_1",
		cwd: projectRoot,
		agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile },
		stateChangeSeq: 7,
	};
	const host = new FakeHost(agent);
	let now = 1_000;
	let nextId = 0;
	const registrations = new RuntimeRegistrationManager(store, host, {
		now: () => now,
		leaseMs: 30_000,
		createId: () => `reg_${++nextId}`,
		createKey: () => `key_${nextId}`,
	});
	const input: RegisterPiInput = {
		projectRoot,
		piSessionId: "session_1",
		piSessionFile: sessionFile,
		clientGeneration: "client_1",
		admittedClaims: [],
		herdr: { paneId: "w1:p1", terminalId: "term_1" },
	};
	return { root, projectRoot, watchRoot, sessionFile, store, host, registrations, input, setNow: (value: number) => { now = value; } };
}

describe("hosted Pi registration", () => {
	it("derives a canonical durable target and idempotently renews one client generation", async () => {
		const test = setup();
		const first = await test.registrations.register(test.input);
		expect(first).toMatchObject({ registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 31_000, host: { stateChangeSeq: 7 } });
		expect(first.targetKey).toBe(deriveTargetKey(test.projectRoot, "session_1"));
		expect(test.store.read().targets[first.targetKey]).toMatchObject({ projectRoot: test.projectRoot, piSessionFile: test.sessionFile });
		test.setNow(2_000);
		const retry = await test.registrations.register(test.input);
		expect(retry).toMatchObject({ registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 32_000 });
		test.host.agent = { ...test.host.agent, name: "pi-main", agentSession: { source: "pi-kit-runtime", agent: "pi", kind: "id", value: "session_1" } };
		expect(await test.registrations.register({ ...test.input, herdr: { ...test.input.herdr, agentName: "pi-main" } })).toMatchObject({ registrationId: "reg_1" });
	});

	it("rejects every authoritative identity mismatch and host outage", async () => {
		const test = setup();
		const cases: Array<Partial<HostedLiveAgent>> = [
			{ paneId: "w1:p2" },
			{ terminalId: "term_2" },
			{ cwd: test.root },
			{ agentSession: { source: "other", agent: "pi", kind: "path", value: test.sessionFile } },
			{ agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: join(test.root, "missing.jsonl") } },
		];
		for (const patch of cases) {
			test.host.agent = { ...test.host.agent, ...patch };
			await expect(test.registrations.register(test.input)).rejects.toMatchObject({ code: "identity_mismatch" });
			test.host.agent = { ...test.host.agent, ...patch, paneId: "w1:p1", terminalId: "term_1", cwd: test.projectRoot, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: test.sessionFile } };
		}
		await expect(test.registrations.register({ ...test.input, piSessionId: "wrong_session" })).rejects.toMatchObject({ code: "invalid_request" });
		test.host.available = false;
		await expect(test.registrations.register(test.input)).rejects.toMatchObject({ code: "host_unavailable" });
	});

	it("rejects a second terminal, rotates a same-terminal generation, follows pane moves, and expires leases", async () => {
		const test = setup();
		const first = await test.registrations.register(test.input);
		test.host.agent = { ...test.host.agent, paneId: "w1:p2", terminalId: "term_2" };
		await expect(test.registrations.register({ ...test.input, herdr: { paneId: "w1:p2", terminalId: "term_2" } })).rejects.toMatchObject({ code: "conflict" });

		test.host.agent = { ...test.host.agent, paneId: "w1:p9", terminalId: "term_1" };
		const moved = await test.registrations.heartbeat(first.registrationId, first.registrationKey);
		expect(moved.host.paneId).toBe("w1:p9");
		const rotated = await test.registrations.register({ ...test.input, clientGeneration: "client_2", herdr: { paneId: "w1:p9", terminalId: "term_1" } });
		expect(rotated.registrationId).toBe("reg_2");
		expect(() => test.registrations.authorize(first.registrationId, first.registrationKey)).toThrow(RegistrationError);
		test.setNow(31_001);
		expect(() => test.registrations.authorize(rotated.registrationId, rotated.registrationKey)).toThrow(RegistrationError);
	});

	it("does not resurrect a registration removed during heartbeat verification", async () => {
		const test = setup();
		const registration = await test.registrations.register(test.input);
		let release!: () => void;
		test.host.findBarrier = new Promise<void>((resolve) => { release = resolve; });
		const heartbeat = test.registrations.heartbeat(registration.registrationId, registration.registrationKey);
		await Promise.resolve();
		test.registrations.unregister(registration.registrationId, registration.registrationKey);
		release();
		await expect(heartbeat).rejects.toMatchObject({ code: "registration_stale" });
		expect(() => test.registrations.authorize(registration.registrationId, registration.registrationKey)).toThrow(RegistrationError);
	});

	it("ignores pruned historical receipts but reconciles an exact retained admission", async () => {
		const test = setup();
		const registration = await test.registrations.register(test.input);
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false, now: () => 1_000, createId: (prefix) => `${prefix}_receipt` });
		const monitor = monitors.create(registration.targetKey, test.watchRoot, 0);
		writeFileSync(join(test.watchRoot, "review.md"), "review");
		monitors.reconcile(monitor.monitorId);
		const later = new DirectoryMonitorManager(test.store, { automatic: false, now: () => 1_001 });
		later.reconcile(monitor.monitorId);
		const event = pendingHostedEvents(test.store.read(), registration.targetKey)[0]!;
		test.store.apply({ type: "inbox.claim", claim: { claimId: "claim_old", targetKey: registration.targetKey, registrationId: registration.registrationId, clientGeneration: registration.clientGeneration, eventIds: [event.eventId], createdAt: 1_001, leaseUntil: 2_000, status: "active" } });
		test.registrations.close();
		const replacement = new RuntimeRegistrationManager(test.store, test.host, { now: () => 3_000, createId: () => "reg_new", createKey: () => "key_new" });
		await replacement.register({ ...test.input, clientGeneration: "client_new", admittedClaims: [{ claimId: "claim_missing_after_prune", eventIds: ["evt_pruned"] }, { claimId: "claim_old", eventIds: [event.eventId] }] });
		expect(test.store.read().events[event.eventId]?.delivery).toMatchObject({ status: "acked", claimId: "claim_old", ackedAt: 3_000 });
	});
});

describe("registration-authorized Monitor protocol", () => {
	it("registers, creates/reads/deletes a Monitor, and rejects a stale key", async () => {
		const test = setup();
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false, now: () => 1_000, createId: (prefix) => `${prefix}_rpc` });
		const context: HostedProtocolContext = { runtimeId: "rt_test", epoch: "epoch_test", agentWake: "none", registrations: test.registrations, monitors };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		const registered = await call("pi.register", test.input);
		expect(registered).toMatchObject({ ok: true, result: { registrationId: "reg_1", registrationKey: "key_1", hostStateChangeSeq: 7 } });
		const auth = { registrationId: "reg_1", registrationKey: "key_1" };
		expect(await call("monitor.create", { ...auth, directory: test.watchRoot, settleMs: 250 })).toMatchObject({ ok: true, result: { monitorId: "mon_rpc", status: "watching" } });
		expect(await call("monitor.get", auth)).toMatchObject({ ok: true, result: { monitor: { monitorId: "mon_rpc" } } });
		expect(await call("monitor.get", { ...auth, registrationKey: "wrong" })).toMatchObject({ ok: false, error: { code: "registration_stale" } });
		expect(await call("monitor.delete", { ...auth, monitorId: "mon_rpc" })).toMatchObject({ ok: true, result: { deleted: true } });
		expect(await call("monitor.get", auth)).toMatchObject({ ok: true, result: { monitor: null } });
	});
});
