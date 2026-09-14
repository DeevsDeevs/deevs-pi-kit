import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import type { HostedTarget } from "../extensions/runtime/hosted-types.ts";
import type { BindAgentInput } from "../extensions/runtime/service/bind-request.ts";
import { RuntimeAgentBinder } from "../extensions/runtime/service/bridge.ts";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { HostedParticipantCoordinator } from "../extensions/runtime/service/participant.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { startRuntimeServer } from "../extensions/runtime/service/server.ts";
import { deriveAgentTargetKey, HostedStateStore } from "../extensions/runtime/service/state.ts";
import { RuntimeInbox } from "../extensions/runtime/service/delivery.ts";

const AGENT_NAME = "collab-fable";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();

	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		const agent = this.agents.get(agentName);
		if (!agent) throw Object.assign(new Error("missing agent"), { code: "identity_mismatch" });
		return agent;
	}
}

function codexAgent(cwd: string, name = AGENT_NAME): HostedLiveAgent {
	return { tabId: "w1:t9", workspaceId: "w1", cwd, name };
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-bridge-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	mkdirSync(projectRoot);
	const host = new FakeHost();
	const inputs = new Map<string, RegisterPiInput>();
	for (const name of ["main", "successor"]) {
		const sessionFile = join(root, `${name}.jsonl`);
		const sessionId = `session_${name}`;
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		inputs.set(name, { projectRoot, piSessionId: sessionId, piSessionFile: sessionFile });
	}
	const store = new HostedStateStore(join(root, "runtime"));
	let now = 1_000;
	let registrationNumber = 0;
	const registrationOptions = { now: () => now, createId: () => `reg_${++registrationNumber}`, createKey: () => `key_${registrationNumber}` };
	const registrations = new RuntimeRegistrationManager(store, host, registrationOptions);
	let generation = 0;
	const participants = new HostedParticipantCoordinator(store, registrations, { now: () => now, createGeneration: () => `lease_${++generation}` });
	const bridges = new RuntimeAgentBinder(store, registrations, host, { now: () => now, createGeneration: () => "lease_agent" });
	return { root, projectRoot, host, inputs, store, registrations, registrationOptions, participants, bridges, setNow(value: number) { now = value; } };
}

async function registerPi(test: ReturnType<typeof setup>, name: string, registrations = test.registrations) {
	return registrations.register(test.inputs.get(name)!);
}

function bindInput(callerParticipantKey: string, expectedCallerGeneration: string): BindAgentInput {
	return {
		agentName: AGENT_NAME,
		driver: "codex",
		profile: "read-only",
		protocol: "review",
		participantId: "fable",
		callerParticipantKey,
		expectedCallerGeneration,
	};
}

describe("authoritative Herdr agent bind", () => {
	it("binds an exact live agent, rebinds onto the same lease, and stops the bound target", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const caller = test.participants.acquire(main, "review", "main").participant;
		test.host.agents.set(AGENT_NAME, codexAgent(test.projectRoot));
		const bound = await test.bridges.bind(main, bindInput(caller.participantKey, caller.generation));
		expect(bound).toMatchObject({
			targetKey: deriveAgentTargetKey(test.projectRoot, AGENT_NAME),
			holderGeneration: "lease_agent",
			driver: "codex",
			profile: "read-only",
			cwd: test.projectRoot,
		});
		expect(test.store.read().targets[bound.targetKey]).toMatchObject({ kind: "agent", agentName: AGENT_NAME });
		expect(test.store.read().participants[bound.participantKey]).toMatchObject({ state: "held", holderTargetKey: bound.targetKey, generation: "lease_agent" });
		expect(test.registrations.hasLiveTarget(bound.targetKey)).toBe(true);

		const rebound = await test.bridges.bind(main, bindInput(caller.participantKey, caller.generation));
		expect(rebound.targetKey).toBe(bound.targetKey);
		expect(rebound.holderGeneration).toBe("lease_agent");
		expect(rebound.registration.registrationId).not.toBe(bound.registration.registrationId);
		expect(() => test.registrations.authorize(bound.registration.registrationId, bound.registration.registrationKey)).toThrow();

		const stoppedTargets: HostedTarget[] = [];
		const stopping = new HostedParticipantCoordinator(test.store, test.registrations, { now: () => 1_002, createGeneration: () => "lease_stopped", stopTarget: async (target) => { stoppedTargets.push(target); return "closed"; } });
		const stopped = await stopping.stopConfirmed(main, bound.participantKey, bound.holderGeneration);
		expect(stopped).toMatchObject({ outcome: "stopped", participant: { state: "vacant" } });
		expect(stoppedTargets).toMatchObject([{ kind: "agent", targetKey: bound.targetKey, agentName: AGENT_NAME }]);
	});

	it("rejects an absent agent and one whose name, cwd, or tab identity does not match", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const caller = test.participants.acquire(main, "review", "main").participant;
		const input = bindInput(caller.participantKey, caller.generation);
		await expect(test.bridges.bind(main, input)).rejects.toMatchObject({ code: "identity_mismatch" });
		test.host.agents.set(AGENT_NAME, codexAgent(test.projectRoot, "collab-other"));
		await expect(test.bridges.bind(main, input)).rejects.toMatchObject({ code: "identity_mismatch" });
		const { tabId: _tabId, ...untabbed } = codexAgent(test.projectRoot);
		test.host.agents.set(AGENT_NAME, untabbed);
		await expect(test.bridges.bind(main, input)).rejects.toMatchObject({ code: "identity_mismatch" });
		test.host.agents.set(AGENT_NAME, codexAgent(test.root));
		await expect(test.bridges.bind(main, input)).rejects.toMatchObject({ code: "identity_mismatch" });
		expect(test.store.read().targets[deriveAgentTargetKey(test.projectRoot, AGENT_NAME)]).toBeUndefined();
	});

	it("rejects stale caller authority and an unexpected participant generation", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const caller = test.participants.acquire(main, "review", "main").participant;
		test.host.agents.set(AGENT_NAME, codexAgent(test.projectRoot));
		await expect(test.bridges.bind(main, bindInput(caller.participantKey, "lease_stale"))).rejects.toMatchObject({ code: "conflict" });
		await expect(test.bridges.bind(main, { ...bindInput(caller.participantKey, caller.generation), expectedParticipantGeneration: "lease_absent" })).rejects.toMatchObject({ code: "conflict" });
		const successor = await registerPi(test, "successor");
		const held = test.participants.acquire(successor, "review", "fable").participant;
		await expect(test.bridges.bind(main, bindInput(caller.participantKey, caller.generation))).rejects.toMatchObject({ code: "conflict" });
		test.participants.standDown(successor, held.participantKey);
		const bound = await test.bridges.bind(main, { ...bindInput(caller.participantKey, caller.generation), expectedParticipantGeneration: test.participants.get(main, held.participantKey).generation });
		expect(bound.participantKey).toBe(held.participantKey);
	});

	it("fails a heartbeat closed when Herdr no longer reports the agent in its project", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const caller = test.participants.acquire(main, "review", "main").participant;
		test.host.agents.set(AGENT_NAME, codexAgent(test.projectRoot));
		const bound = await test.bridges.bind(main, bindInput(caller.participantKey, caller.generation));
		const live = await test.registrations.heartbeat(bound.registration.registrationId, bound.registration.registrationKey);
		expect(live.targetKey).toBe(bound.targetKey);
		test.host.agents.set(AGENT_NAME, codexAgent(test.root));
		await expect(test.registrations.heartbeat(bound.registration.registrationId, bound.registration.registrationKey)).rejects.toMatchObject({ code: "identity_mismatch" });
		test.host.agents.delete(AGENT_NAME);
		await expect(test.registrations.heartbeat(bound.registration.registrationId, bound.registration.registrationKey)).rejects.toMatchObject({ code: "identity_mismatch" });
	});

	it("exposes strict additive bind RPC without weakening Pi registration", async () => {
		const test = setup();
		const main = await registerPi(test, "main");
		const caller = test.participants.acquire(main, "review", "main").participant;
		test.host.agents.set(AGENT_NAME, codexAgent(test.projectRoot));
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false });
		const inbox = new RuntimeInbox(test.store);
		const context: HostedProtocolContext = { runtimeId: "rt_test", agentWake: "none", registrations: test.registrations, monitors, inbox, participants: test.participants, bridges: test.bridges };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		expect(await call("hello", { minVersion: 1, maxVersion: 1 })).toMatchObject({ ok: true, result: { capabilities: { interactiveAgent: { bind: "herdr_agent_name" } } } });
		const auth = { registrationId: main.registrationId, registrationKey: main.registrationKey };
		const params = { ...auth, ...bindInput(caller.participantKey, caller.generation) };
		expect(await call("bridge.register", params)).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await call("bridge.bind", { ...params, extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("bridge.bind", { ...params, driver: "pi" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const bound = await call("bridge.bind", params);
		expect(bound).toMatchObject({ ok: true, result: { targetKey: expect.stringMatching(/^agent_/), holderGeneration: "lease_agent", driver: "codex", profile: "read-only" } });
		expect(await call("pi.register", { ...test.inputs.get("successor"), extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("crosses the real Unix socket with strict Pi authorization and an exact agent bind", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-bridge-socket-"));
		roots.push(root);
		const runtimeRoot = join(root, "runtime");
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const sessionFile = join(root, "main.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_main", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		const host = new FakeHost();
		host.agents.set(AGENT_NAME, codexAgent(projectRoot));
		let registrationNumber = 0;
		const server = await startRuntimeServer({ root: runtimeRoot, host, registration: { createId: () => `reg_${++registrationNumber}`, createKey: () => `key_${registrationNumber}` }, participant: { createGeneration: () => "lease_main" }, bridge: { createGeneration: () => "lease_agent_socket" } });
		const client = new HostedRuntimeClient(server.socketPath);
		try {
			const registered = await client.call("pi.register", { projectRoot, piSessionId: "session_main", piSessionFile: sessionFile }) as Record<string, unknown>;
			const auth = { registrationId: String(registered.registrationId), registrationKey: String(registered.registrationKey) };
			const acquired = await client.call("participant.acquire", { ...auth, protocol: "review", participantId: "main" }) as { participant: { participantKey: string; generation: string } };
			const bound = await client.call("bridge.bind", { ...auth, ...bindInput(acquired.participant.participantKey, acquired.participant.generation) }) as Record<string, unknown>;
			expect(bound).toMatchObject({ targetKey: deriveAgentTargetKey(projectRoot, AGENT_NAME), holderGeneration: "lease_agent_socket", profile: "read-only", cwd: projectRoot });
			expect(await client.call("bridge.heartbeat", { registrationId: bound.registrationId, registrationKey: bound.registrationKey })).toMatchObject({ targetKey: bound.targetKey });
		} finally {
			await server.close();
		}
	});
});
