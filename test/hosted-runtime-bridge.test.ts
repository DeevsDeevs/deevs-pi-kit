import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import type { HostedTarget } from "../extensions/runtime/hosted-types.ts";
import { RuntimeBridgeCoordinator } from "../extensions/runtime/service/bridge.ts";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { HostedParticipantCoordinator } from "../extensions/runtime/service/participant.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type HostedPaneIdentity, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { startRuntimeServer } from "../extensions/runtime/service/server.ts";
import { HostedStateStore, readHostedRuntimeState, runtimeStatePaths } from "../extensions/runtime/service/state.ts";
import { HostedWakeCoordinator } from "../extensions/runtime/service/wake.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	readonly panes = new Map<string, HostedPaneIdentity>();
	getPaneBarrier?: Promise<void>;
	onGetPane?: () => void;

	async getPane(paneId: string): Promise<HostedLiveAgent> {
		this.onGetPane?.();
		await this.getPaneBarrier;
		const agent = this.agents.get(paneId);
		if (!agent) throw Object.assign(new Error("missing agent"), { code: "identity_mismatch" });
		return agent;
	}

	async findTerminal(terminalId: string): Promise<HostedLiveAgent> {
		const matches = [...this.agents.values()].filter((agent) => agent.terminalId === terminalId);
		if (matches.length !== 1) throw Object.assign(new Error("missing terminal"), { code: "identity_mismatch" });
		return matches[0]!;
	}

	async getPaneIdentity(paneId: string): Promise<HostedPaneIdentity> {
		const pane = this.panes.get(paneId);
		if (!pane) throw Object.assign(new Error("missing pane"), { code: "identity_mismatch" });
		return pane;
	}
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-bridge-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	mkdirSync(projectRoot);
	const host = new FakeHost();
	const inputs = new Map<string, RegisterPiInput>();
	for (const [index, name] of ["main", "successor"].entries()) {
		const sessionFile = join(root, `${name}.jsonl`);
		const sessionId = `session_${name}`;
		const paneId = `w1:p${index + 1}`;
		const terminalId = `term_${name}`;
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		host.agents.set(paneId, { paneId, tabId: `w1:t${index + 1}`, workspaceId: "w1", terminalId, cwd: projectRoot, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, status: "idle", stateChangeSeq: 1 });
		inputs.set(name, { projectRoot, piSessionId: sessionId, piSessionFile: sessionFile, clientGeneration: `client_${name}`, admittedClaims: [], herdr: { paneId, terminalId } });
	}
	host.panes.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: projectRoot, paneCount: 1, revision: 1 });
	const store = new HostedStateStore(join(root, "runtime"));
	let now = 1_000;
	let registrationNumber = 0;
	const registrationOptions = { now: () => now, createId: () => `reg_${++registrationNumber}`, createKey: () => `key_${registrationNumber}` };
	const registrations = new RuntimeRegistrationManager(store, host, registrationOptions);
	let generation = 0;
	const participants = new HostedParticipantCoordinator(store, registrations, { request() {} }, { now: () => now, createGeneration: () => `lease_${++generation}` });
	const secrets = [Buffer.alloc(32, 1).toString("base64url"), Buffer.alloc(32, 2).toString("base64url")];
	const bridges = new RuntimeBridgeCoordinator(store, registrations, host, { now: () => now, createId: () => "launch_1", createGeneration: () => "lease_bridge", createSecret: () => secrets.shift()! });
	return { root, projectRoot, host, inputs, store, registrations, registrationOptions, participants, bridges, setNow(value: number) { now = value; } };
}

async function registerPi(test: ReturnType<typeof setup>, name: string, registrations = test.registrations) {
	return registrations.register(test.inputs.get(name)!);
}

describe("authoritative Runtime bridge launch", () => {
	it("reserves, consumes once, reconnects after Runtime restart, and stops the exact bridge target", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const successor = await registerPi(test, "successor");
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		const launch = await test.bridges.create(main, {
			requestId: "request_1",
			callerParticipantKey: mainParticipant.participantKey,
			expectedCallerGeneration: mainParticipant.generation,
			protocol: "review",
			participantId: "fable",
			profile: "read-only",
			configurationHash: "a".repeat(64),
			herdr: { paneId: "w1:p9", terminalId: "term_bridge" },
			metadata: { adapter: "opaque-v1" },
		});
		expect(test.store.read().bridgeLaunches[launch.launchId]).toMatchObject({ status: "pending", holderGeneration: "lease_bridge", herdr: { tabId: "w1:t9" } });
		expect(JSON.stringify(test.store.read())).not.toContain(launch.launchToken);
		expect(JSON.stringify(test.store.read())).not.toContain(launch.reconnectToken);
		expect(() => test.participants.acquire(successor, "review", "fable")).toThrow(/reserved/);

		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: test.projectRoot, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: "wrong_bridge" }, status: "idle", stateChangeSeq: 2 });
		await expect(test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toMatchObject({ code: "identity_mismatch" });
		expect(test.store.read().bridgeLaunches[launch.launchId]?.status).toBe("pending");
		test.host.agents.set("w1:p9", { ...test.host.agents.get("w1:p9")!, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: launch.launchId } });
		await expect(test.bridges.register({ launchToken: launch.launchToken, reconnectToken: "x".repeat(43), clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toMatchObject({ code: "conflict" });
		let releaseRegistration!: () => void;
		test.host.getPaneBarrier = new Promise<void>((resolve) => { releaseRegistration = resolve; });
		const attempts = [test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } }), test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })];
		await Promise.resolve();
		releaseRegistration();
		const settled = await Promise.allSettled(attempts);
		expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
		const first = (settled.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof test.bridges.register>>> => item.status === "fulfilled"))!.value;
		expect(first).toMatchObject({ participantKey: expect.stringMatching(/^participant_/), holderGeneration: "lease_bridge", profile: "read-only", metadata: { adapter: "opaque-v1" } });
		expect(test.store.read().bridgeLaunches[launch.launchId]).toMatchObject({ status: "consumed", clientGeneration: "client_bridge" });
		expect(test.store.read().targets[launch.targetKey]).toMatchObject({ kind: "bridge", bridgeId: launch.launchId, holderGeneration: "lease_bridge" });
		const migrationRoot = mkdtempSync(join(tmpdir(), "pi-kit-runtime-v3-to-v4-"));
		roots.push(migrationRoot);
		mkdirSync(migrationRoot, { recursive: true });
		const { workspaces: _workspaces, integrations: _integrations, ...v3 } = structuredClone(test.store.read());
		writeFileSync(runtimeStatePaths(migrationRoot).state, JSON.stringify({ ...v3, version: 3 }));
		expect(readHostedRuntimeState(migrationRoot)).toMatchObject({ version: 4, workspaces: {}, integrations: {}, targets: { [launch.targetKey]: { kind: "bridge", bridgeId: launch.launchId } }, bridgeLaunches: { [launch.launchId]: { status: "consumed" } } });
		expect(test.registrations.isLiveTarget(launch.targetKey)).toBe(true);
		await expect(test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toMatchObject({ code: "conflict" });

		test.registrations.close();
		const restartedRegistrations = new RuntimeRegistrationManager(test.store, test.host, test.registrationOptions);
		const restartedBridges = new RuntimeBridgeCoordinator(test.store, restartedRegistrations, test.host, { now: () => 1_001 });
		const reconnected = await restartedBridges.reconnect({ targetKey: launch.targetKey, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } });
		expect(reconnected.registration.registrationId).toBe(first.registration.registrationId);
		expect(reconnected.registration.registrationKey).toBe(first.registration.registrationKey);
		const restartedMain = await registerPi(test, "main", restartedRegistrations);
		const stoppedTargets: HostedTarget[] = [];
		const restartedParticipants = new HostedParticipantCoordinator(test.store, restartedRegistrations, { request() {} }, { now: () => 1_002, createGeneration: () => "lease_stopped", stopTarget: async (target) => { stoppedTargets.push(target); return "closed"; } });
		const stopped = await restartedParticipants.stopConfirmed(restartedMain, first.participantKey, first.holderGeneration);
		expect(stopped).toMatchObject({ outcome: "stopped", participant: { state: "vacant" } });
		expect(stoppedTargets).toMatchObject([{ kind: "bridge", targetKey: launch.targetKey }]);
		await expect(restartedBridges.reconnect({ targetKey: launch.targetKey, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toMatchObject({ code: "conflict" });
	});

	it("does not reinstall a bridge registration after its holder generation changes during host verification", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		const launch = await test.bridges.create(main, { requestId: "reconnect_race", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "fable", profile: "read-only", configurationHash: "d".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_bridge" } });
		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: test.projectRoot, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: launch.launchId }, status: "idle", stateChangeSeq: 2 });
		const first = await test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } });
		let releaseVerification!: () => void;
		let verificationStarted!: () => void;
		test.host.getPaneBarrier = new Promise<void>((resolve) => { releaseVerification = resolve; });
		const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
		test.host.onGetPane = verificationStarted;
		const reconnecting = test.bridges.reconnect({ targetKey: launch.targetKey, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } });
		await started;
		test.participants.standDownConfirmed(main, first.participantKey, first.holderGeneration);
		releaseVerification();
		await expect(reconnecting).rejects.toMatchObject({ code: "registration_stale" });
	});

	it("exposes strict additive bridge RPC without weakening Pi registration", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false });
		const wakes = new HostedWakeCoordinator(test.store);
		const context: HostedProtocolContext = { runtimeId: "rt_test", epoch: "epoch_test", agentWake: "none", registrations: test.registrations, monitors, wakes, participants: test.participants, bridges: test.bridges };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		expect(await call("hello", { minVersion: 1, maxVersion: 1 })).toMatchObject({ ok: true, result: { capabilities: { bridge: { launch: "single_use", reconnect: true } } } });
		const auth = { registrationId: main.registrationId, registrationKey: main.registrationKey };
		const createParams = { ...auth, requestId: "rpc_1", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "fable", profile: "read-only", configurationHash: "c".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_bridge" } };
		expect(await call("bridge.launch.create", { ...createParams, metadata: { secret: "no" } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("bridge.launch.create", { ...createParams, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key_${index}`, "x"])) })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const created = await call("bridge.launch.create", { ...createParams, metadata: {} });
		expect(created).toMatchObject({ ok: true, result: { launchId: "launch_1", targetKey: expect.stringMatching(/^bridge_/), launchToken: expect.stringMatching(/^bridge_launch_/), reconnectToken: expect.any(String) } });
		const authority = (created as { result: { launchId: string; targetKey: string; launchToken: string; reconnectToken: string } }).result;
		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: test.projectRoot, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: authority.launchId }, status: "idle", stateChangeSeq: 2 });
		expect(await call("bridge.register", { launchToken: authority.launchToken, reconnectToken: authority.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).toMatchObject({ ok: true, result: { targetKey: authority.targetKey, participantKey: expect.stringMatching(/^participant_/), holderGeneration: "lease_bridge", profile: "read-only" } });
		expect(await call("bridge.register", { launchToken: authority.launchToken, reconnectToken: authority.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" }, extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("pi.register", { ...test.inputs.get("successor"), extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		wakes.close();
	});

	it("crosses the real Unix socket with strict Pi authorization and fake bridge registration", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-bridge-socket-"));
		roots.push(root);
		const runtimeRoot = join(root, "runtime");
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const sessionFile = join(root, "main.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_main", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		const host = new FakeHost();
		host.agents.set("w1:p1", { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", terminalId: "term_main", cwd: projectRoot, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, status: "idle", stateChangeSeq: 1 });
		host.panes.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: projectRoot, paneCount: 1, revision: 1 });
		const secrets = [Buffer.alloc(32, 3).toString("base64url"), Buffer.alloc(32, 4).toString("base64url")];
		const server = await startRuntimeServer({ root: runtimeRoot, host, registration: { createId: () => "reg_main", createKey: () => "key_main" }, participant: { createGeneration: () => "lease_main" }, bridge: { createId: () => "launch_socket", createGeneration: () => "lease_bridge_socket", createSecret: () => secrets.shift()! } });
		const client = new HostedRuntimeClient(server.socketPath);
		try {
			const registered = await client.call("pi.register", { projectRoot, piSessionId: "session_main", piSessionFile: sessionFile, clientGeneration: "client_main", admittedClaims: [], herdr: { paneId: "w1:p1", terminalId: "term_main" } }) as Record<string, unknown>;
			const auth = { registrationId: String(registered.registrationId), registrationKey: String(registered.registrationKey) };
			const acquired = await client.call("participant.acquire", { ...auth, protocol: "review", participantId: "main" }) as { participant: { participantKey: string; generation: string } };
			const authority = await client.call("bridge.launch.create", { ...auth, requestId: "socket_request", callerParticipantKey: acquired.participant.participantKey, expectedCallerGeneration: acquired.participant.generation, protocol: "review", participantId: "fable", profile: "read-only", configurationHash: "e".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_bridge" }, metadata: { format: "fake-v1" } }) as { launchId: string; targetKey: string; launchToken: string; reconnectToken: string };
			host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: projectRoot, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: authority.launchId }, status: "idle", stateChangeSeq: 2 });
			const bridge = await client.call("bridge.register", { launchToken: authority.launchToken, reconnectToken: authority.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } }) as Record<string, unknown>;
			expect(bridge).toMatchObject({ targetKey: authority.targetKey, holderGeneration: "lease_bridge_socket", profile: "read-only", metadata: { format: "fake-v1" } });
			expect(await client.call("bridge.heartbeat", { registrationId: bridge.registrationId, registrationKey: bridge.registrationKey })).toMatchObject({ targetKey: authority.targetKey, inboxReady: false });
			const durable = readFileSync(runtimeStatePaths(runtimeRoot).state, "utf8");
			expect(durable).not.toContain(authority.launchToken);
			expect(durable).not.toContain(authority.reconnectToken);
		} finally {
			await server.close();
		}
	});

	it("rejects stale caller authority, occupied panes, and expired launch capabilities", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		test.host.panes.set("w1:p9", { ...test.host.panes.get("w1:p9")!, agent: "pi" });
		await expect(test.bridges.create(main, { requestId: "occupied", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "fable", profile: "read-only", configurationHash: "b".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toMatchObject({ code: "identity_mismatch" });
		test.host.panes.set("w1:p9", { ...test.host.panes.get("w1:p9")!, agent: undefined });
		await expect(test.bridges.create(main, { requestId: "reserved_metadata", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "fable", profile: "read-only", configurationHash: "b".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_bridge" }, metadata: { driver: "codex" } })).rejects.toThrow("reserved");
		const launch = await test.bridges.create(main, { requestId: "expires", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "fable", profile: "read-only", configurationHash: "b".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_bridge" } });
		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_bridge", cwd: test.projectRoot, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: launch.launchId }, status: "idle", stateChangeSeq: 2 });
		test.participants.standDown(main, mainParticipant.participantKey);
		await expect(test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toThrow("caller authority changed");
		test.setNow(31_001);
		await expect(test.bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_bridge", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_bridge" } })).rejects.toThrow("expired");
		expect(test.store.read().bridgeLaunches[launch.launchId]?.status).toBe("expired");
	});
});
