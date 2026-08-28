import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import { readRunnerConfig, readWorkerState, writeRunnerConfig, writeWorkerState } from "../extensions/runtime/bridge-runner/journal.ts";
import { BridgeRunner } from "../extensions/runtime/bridge-runner/runner.ts";
import type { BridgeJournal, BridgeRunnerConfig } from "../extensions/runtime/bridge-runner/types.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";
import { ownsProcessIdentity, quiesceProcessGroup } from "../extensions/shared/process-group.ts";
import type { HostedHostVerifier, HostedLiveAgent, HostedPaneIdentity } from "../extensions/runtime/service/registration.ts";

const roots: string[] = [];
const servers: RuntimeServerHandle[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	readonly panes = new Map<string, HostedPaneIdentity>();
	async getPane(paneId: string): Promise<HostedLiveAgent> { const value = this.agents.get(paneId); if (!value) throw new Error("missing agent"); return value; }
	async findTerminal(terminalId: string): Promise<HostedLiveAgent> { const values = [...this.agents.values()].filter((agent) => agent.terminalId === terminalId); if (values.length !== 1) throw new Error("missing terminal"); return values[0]!; }
	async getPaneIdentity(paneId: string): Promise<HostedPaneIdentity> { const value = this.panes.get(paneId); if (!value) throw new Error("missing pane"); return value; }
}

function session(root: string, projectRoot: string, name: string, paneId: string, host: FakeHost) {
	const file = join(root, `${name}.jsonl`);
	const id = `session_${name}`;
	const terminalId = `term_${name}`;
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	host.agents.set(paneId, { paneId, tabId: `tab_${name}`, workspaceId: "workspace_test", terminalId, cwd: projectRoot, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: file }, status: "idle", stateChangeSeq: 1 });
	return { projectRoot, piSessionId: id, piSessionFile: file, clientGeneration: `client_${name}`, admittedClaims: [], herdr: { paneId, terminalId } };
}

async function settle(runner: BridgeRunner, expectedTurns: number): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		await runner.step();
		if (runner.state().turns.length === expectedTurns && runner.state().turns.every((turn) => turn.state === "reply_sent")) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Bridge runner did not settle.");
}

describe("durable common bridge runner", () => {
	it("journals before ACK, executes serial fake turns, reconnects after Runtime restart, and replies deterministically", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-bridge-runner-e2e-"));
		roots.push(root);
		const runtimeRoot = join(root, "runtime");
		const projectRoot = join(root, "project");
		const runnerRoot = join(root, "runner");
		mkdirSync(projectRoot);
		const host = new FakeHost();
		const mainInput = session(root, projectRoot, "main", "pane_main", host);
		const senderInput = session(root, projectRoot, "sender", "pane_sender", host);
		host.panes.set("pane_bridge", { paneId: "pane_bridge", tabId: "tab_bridge", workspaceId: "workspace_test", terminalId: "term_bridge", cwd: projectRoot, paneCount: 1, revision: 1 });
		let server = await startRuntimeServer({ root: runtimeRoot, socketPath: join(runtimeRoot, "runtime.sock"), host, bridge: { createId: () => "bridge_fake", createGeneration: () => "lease_fake", createSecret: (() => { const values = [Buffer.alloc(32, 5).toString("base64url"), Buffer.alloc(32, 6).toString("base64url")]; return () => values.shift()!; })() } });
		servers.push(server);
		let client = new HostedRuntimeClient(server.socketPath);
		const mainRegistration = await client.call("pi.register", mainInput) as Record<string, unknown>;
		let senderRegistration = await client.call("pi.register", senderInput) as Record<string, unknown>;
		const main = (await client.call("participant.acquire", { registrationId: mainRegistration.registrationId, registrationKey: mainRegistration.registrationKey, protocol: "review", participantId: "main" }) as { participant: { participantKey: string; generation: string } }).participant;
		let sender = (await client.call("participant.acquire", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, protocol: "review", participantId: "sender" }) as { participant: { participantKey: string; generation: string } }).participant;
		const authority = await client.call("bridge.launch.create", { registrationId: mainRegistration.registrationId, registrationKey: mainRegistration.registrationKey, requestId: "runner_e2e", callerParticipantKey: main.participantKey, expectedCallerGeneration: main.generation, protocol: "review", participantId: "fake", profile: "read-only", configurationHash: "f".repeat(64), herdr: { paneId: "pane_bridge", terminalId: "term_bridge" }, metadata: { format: "fake-v1" } }) as { launchId: string; targetKey: string; launchToken: string; reconnectToken: string };
		host.agents.set("pane_bridge", { paneId: "pane_bridge", tabId: "tab_bridge", workspaceId: "workspace_test", terminalId: "term_bridge", cwd: projectRoot, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: authority.launchId }, status: "idle", stateChangeSeq: 2 });
		mkdirSync(runnerRoot);
		const configPath = join(runnerRoot, "config.v1.json");
		const config: BridgeRunnerConfig = { version: 1, bridgeId: authority.launchId, driver: "fake", root: runnerRoot, runtimeSocket: server.socketPath, projectRoot, cwd: projectRoot, clientGeneration: "client_bridge", protocol: "review", participantId: "fake", launchToken: authority.launchToken, reconnectToken: authority.reconnectToken, targetKey: authority.targetKey, wallMs: 2_000 };
		writeRunnerConfig(configPath, config);
		const runner = new BridgeRunner(configPath, config, undefined, { herdrIdentity: async () => ({ paneId: "pane_bridge", terminalId: "term_bridge" }) });
		await runner.start();
		const bridgeParticipantKey = runner.state().participantKey!;
		await client.call("mailbox.send", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: bridgeParticipantKey, sendId: "input_1", body: "first" });
		await settle(runner, 1);
		expect(runner.state()).toMatchObject({ status: "running", driverSessionId: expect.stringMatching(/^fake_/), admissions: [{ ack: "confirmed" }], turns: [{ sequence: 1, state: "reply_sent", reply: "sent", terminal: { status: "completed", body: "fake:first", sessionAdvance: "committed" } }] });
		const workerSpec = readFileSync(join(dirname(runner.state().turns[0]!.worker!.statePath), "spec.v1.json"), "utf8");
		expect(workerSpec).not.toContain(authority.launchToken);
		expect(workerSpec).not.toContain(authority.reconnectToken);
		expect(workerSpec).not.toContain("registrationKey");
		expect(workerSpec).not.toContain("runtimeSocket");
		const firstClaim = await client.call("inbox.claim", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey }) as { claimId: string; events: Array<{ payload: { body: string } }> };
		expect(firstClaim.events[0]?.payload.body).toBe("fake:first");

		await server.close();
		servers.splice(servers.indexOf(server), 1);
		await expect(runner.step()).resolves.toBe("idle");
		server = await startRuntimeServer({ root: runtimeRoot, socketPath: join(runtimeRoot, "runtime.sock"), host });
		servers.push(server);
		client = new HostedRuntimeClient(server.socketPath);
		senderRegistration = await client.call("pi.register", { ...senderInput, clientGeneration: "client_sender_restart" }) as Record<string, unknown>;
		sender = (await client.call("participant.get", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, participantKey: sender.participantKey }) as { participantKey: string; generation: string });
		await client.call("mailbox.send", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: bridgeParticipantKey, sendId: "input_2", body: "second" });
		await settle(runner, 2);
		expect(runner.state().turns.map((turn) => [turn.sequence, turn.replySendId, turn.terminal?.body])).toEqual([[1, expect.stringMatching(/^reply_/), "fake:first"], [2, expect.stringMatching(/^reply_/), "fake:second"]]);
		expect(runner.state().turns[0]!.replySendId).not.toBe(runner.state().turns[1]!.replySendId);

		await client.call("mailbox.send", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: bridgeParticipantKey, sendId: "input_3", body: "sleep:5000" });
		await runner.step();
		await runner.step();
		expect(runner.state().turns[2]?.state).toBe("running");
		for (let attempt = 0; attempt < 100 && !readWorkerState(runner.state().turns[2]!.worker!.statePath)?.childPid; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(readWorkerState(runner.state().turns[2]!.worker!.statePath)?.childPid).toEqual(expect.any(Number));
		await runner.cancelActive();
		await settle(runner, 3);
		expect(runner.state().turns[2]).toMatchObject({ state: "reply_sent", terminal: { status: "cancelled", sessionAdvance: "uncertain" } });

		await client.call("mailbox.send", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: bridgeParticipantKey, sendId: "input_4", body: "sleep:200" });
		await runner.step();
		await runner.step();
		const restartedRunner = new BridgeRunner(configPath, readRunnerConfig(configPath), undefined, { herdrIdentity: async () => ({ paneId: "pane_bridge", terminalId: "term_bridge" }) });
		await restartedRunner.start();
		await settle(restartedRunner, 4);
		expect(restartedRunner.state().turns[3]).toMatchObject({ sequence: 4, state: "reply_sent", terminal: { status: "completed", body: "fake:sleep:200" } });

		await client.call("mailbox.send", { registrationId: senderRegistration.registrationId, registrationKey: senderRegistration.registrationKey, senderParticipantKey: sender.participantKey, expectedSenderGeneration: sender.generation, recipientParticipantKey: bridgeParticipantKey, sendId: "input_5", body: "sleep:5000" });
		await restartedRunner.step();
		await restartedRunner.step();
		const uncertainTurn = restartedRunner.state().turns[4]!;
		for (let attempt = 0; attempt < 100 && !readWorkerState(uncertainTurn.worker!.statePath)?.childPid; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
		const ownedWorker = readWorkerState(uncertainTurn.worker!.statePath)!;
		expect(await ownsProcessIdentity(ownedWorker.workerPid, ownedWorker.workerIdentity)).toBe(true);
		writeWorkerState(uncertainTurn.worker!.statePath, { ...ownedWorker, workerIdentity: "mismatched-worker-identity" });
		const attentionRunner = new BridgeRunner(configPath, readRunnerConfig(configPath), undefined, { herdrIdentity: async () => ({ paneId: "pane_bridge", terminalId: "term_bridge" }) });
		await attentionRunner.start();
		expect(attentionRunner.state()).toMatchObject({ status: "needs_attention", turns: expect.arrayContaining([expect.objectContaining({ eventId: uncertainTurn.eventId, state: "needs_attention" })]) });
		expect(await ownsProcessIdentity(ownedWorker.workerPid, ownedWorker.workerIdentity)).toBe(true);
		expect(await quiesceProcessGroup(ownedWorker.workerPid)).toBe(true);
	});

	it("fails closed when a starting worker has no durable identity", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-bridge-runner-recovery-"));
		roots.push(root);
		const now = Date.now();
		const config: BridgeRunnerConfig = { version: 1, bridgeId: "bridge_recovery", driver: "fake", root, runtimeSocket: join(root, "missing.sock"), projectRoot: root, cwd: root, clientGeneration: "client_recovery", protocol: "review", participantId: "fake", reconnectToken: "r".repeat(43), targetKey: "bridge_target", wallMs: 1_000 };
		const initial: BridgeJournal = { version: 1, bridgeId: config.bridgeId, driver: "fake", protocol: config.protocol, participantId: config.participantId, nextSequence: 2, admissions: [{ claimId: "claim_1", eventIds: ["event_1"], ack: "confirmed", createdAt: now }], turns: [{ turnId: "turn_1", sequence: 1, eventId: "event_1", claimId: "claim_1", senderParticipantKey: "sender_1", body: "hello", state: "starting", attempt: 1, replySendId: "reply_1", reply: "unsent", worker: { attempt: 1, statePath: join(root, "missing-worker.json") }, createdAt: now, updatedAt: now }], status: "running", updatedAt: now };
		const runner = new BridgeRunner(join(root, "config.v1.json"), config, initial);
		await (runner as unknown as { recover(): Promise<void> }).recover();
		expect(runner.state()).toMatchObject({ status: "needs_attention", turns: [{ state: "needs_attention" }] });
	});

	it("quiesces an exact detached worker that misses its readiness deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-bridge-runner-timeout-"));
		roots.push(root);
		const marker = join(root, "late-execution");
		const workerPath = join(root, "stalled-worker.mjs");
		writeFileSync(workerPath, `import { writeFileSync } from "node:fs"; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "late"), 300); setInterval(() => {}, 1_000);`);
		const now = Date.now();
		const config: BridgeRunnerConfig = { version: 1, bridgeId: "bridge_timeout", driver: "fake", root, runtimeSocket: join(root, "missing.sock"), projectRoot: root, cwd: root, clientGeneration: "client_timeout", protocol: "review", participantId: "fake", reconnectToken: "r".repeat(43), targetKey: "bridge_target", wallMs: 1_000 };
		const initial: BridgeJournal = { version: 1, bridgeId: config.bridgeId, driver: "fake", protocol: config.protocol, participantId: config.participantId, nextSequence: 2, admissions: [{ claimId: "claim_1", eventIds: ["event_1"], ack: "confirmed", createdAt: now }], turns: [{ turnId: "turn_1", sequence: 1, eventId: "event_1", claimId: "claim_1", senderParticipantKey: "sender_1", body: "hello", state: "pending", attempt: 0, replySendId: "reply_1", reply: "unsent", createdAt: now, updatedAt: now }], status: "running", updatedAt: now };
		const runner = new BridgeRunner(join(root, "config.v1.json"), config, initial, { workerPath, readyTimeoutMs: 50 });
		await (runner as unknown as { launchWorker(turn: BridgeJournal["turns"][number]): Promise<void> }).launchWorker(runner.state().turns[0]!);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(runner.state().turns[0]?.state).toBe("pending");
		expect(runner.state().turns[0]?.worker).toBeUndefined();
		expect(() => readFileSync(marker)).toThrow();
	});
});
