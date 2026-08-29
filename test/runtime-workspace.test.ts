import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeBridgeCoordinator } from "../extensions/runtime/service/bridge.ts";
import { DirectoryMonitorManager } from "../extensions/runtime/service/monitor.ts";
import { HostedParticipantCoordinator } from "../extensions/runtime/service/participant.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type HostedPaneIdentity, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, readHostedRuntimeState, runtimeStatePaths } from "../extensions/runtime/service/state.ts";
import { HostedWakeCoordinator } from "../extensions/runtime/service/wake.ts";
import { RuntimeWorkspaceCoordinator } from "../extensions/runtime/service/workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	readonly panes = new Map<string, HostedPaneIdentity>();
	getPaneBarrier?: Promise<void>;
	onGetPane?: () => void;
	async getPane(paneId: string): Promise<HostedLiveAgent> { this.onGetPane?.(); await this.getPaneBarrier; const value = this.agents.get(paneId); if (!value) throw new Error("missing agent"); return value; }
	async findTerminal(terminalId: string): Promise<HostedLiveAgent> { const values = [...this.agents.values()].filter((agent) => agent.terminalId === terminalId); if (values.length !== 1) throw new Error("missing terminal"); return values[0]!; }
	async getPaneIdentity(paneId: string): Promise<HostedPaneIdentity> { const value = this.panes.get(paneId); if (!value) throw new Error("missing pane"); return value; }
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-workspace-"));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(project);
	git(project, ["init", "-b", "main"]);
	writeFileSync(join(project, "app.txt"), "base\n");
	git(project, ["add", "-A"]);
	git(project, ["commit", "-m", "base"]);
	const sessionFile = join(root, "main.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_main", timestamp: "2026-01-01T00:00:00.000Z", cwd: project })}\n`);
	const host = new FakeHost();
	host.agents.set("w1:p1", { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", terminalId: "term_main", cwd: project, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, status: "idle", stateChangeSeq: 1 });
	const store = new HostedStateStore(join(root, "runtime"));
	let registrationId = 0;
	const registrationOptions = { createId: () => `reg_${++registrationId}`, createKey: () => `key_${registrationId}` };
	const registrations = new RuntimeRegistrationManager(store, host, registrationOptions);
	let participantGeneration = 0;
	const participants = new HostedParticipantCoordinator(store, registrations, { request() {} }, { createGeneration: () => `lease_${++participantGeneration}` });
	const input: RegisterPiInput = { projectRoot: project, piSessionId: "session_main", piSessionFile: sessionFile, clientGeneration: "client_main", admittedClaims: [], herdr: { paneId: "w1:p1", terminalId: "term_main" } };
	const ids = ["workspace_1", "integration_1"];
	const coordinator = new RuntimeWorkspaceCoordinator(join(root, "runtime"), store, registrations, host, { createId: () => ids.shift()!, createGeneration: () => "lease_writer", createSecret: () => Buffer.alloc(32, 9).toString("base64url") });
	return { root, project, host, store, registrations, registrationOptions, participants, input, coordinator };
}

describe("Runtime isolated collaborator workspace", () => {
	it("provisions, binds, reconnects, checkpoints, integrates, and cleans an exact workspace", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		const provisioned = await test.coordinator.create(main, { requestId: "request_1", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "writer", piSessionId: "session_writer" });
		expect(provisioned.workspace).toMatchObject({ state: "ready", profile: "workspace-write", baseCommit: provisioned.workspace.headCommit });
		const launchToken = provisioned.launchToken!;
		expect(launchToken).toMatch(/^workspace_launch_/);
		expect(existsSync(provisioned.workspace.worktreePath)).toBe(true);
		expect(readFileSync(join(test.project, "app.txt"), "utf8")).toBe("base\n");
		const migrationRoot = join(test.root, "migration-runtime");
		mkdirSync(migrationRoot);
		const v4 = structuredClone(test.store.read()) as unknown as { version: number; workspaces: Record<string, { ownerKind?: string }> };
		v4.version = 4;
		for (const record of Object.values(v4.workspaces)) delete record.ownerKind;
		writeFileSync(runtimeStatePaths(migrationRoot).state, JSON.stringify(v4));
		expect(readHostedRuntimeState(migrationRoot).workspaces[provisioned.workspace.workspaceId]).toMatchObject({ ownerKind: "pi", piSessionId: "session_writer" });

		test.host.panes.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_writer", cwd: provisioned.workspace.worktreePath, paneCount: 1, revision: 1 });
		await test.coordinator.bind(main, { workspaceId: provisioned.workspace.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, herdr: { paneId: "w1:p9", terminalId: "term_writer" } });
		const writerSession = join(test.root, "writer.jsonl");
		writeFileSync(writerSession, `${JSON.stringify({ type: "session", version: 3, id: "session_writer", timestamp: "2026-01-01T00:00:00.000Z", cwd: provisioned.workspace.worktreePath })}\n`);
		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_writer", cwd: provisioned.workspace.worktreePath, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: writerSession }, status: "idle", stateChangeSeq: 2 });
		let releaseRegistration!: () => void;
		test.host.getPaneBarrier = new Promise<void>((resolve) => { releaseRegistration = resolve; });
		const registrationInput = { launchToken, piSessionId: "session_writer", piSessionFile: writerSession, clientGeneration: "client_writer", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_writer" } };
		const attempts = [test.coordinator.register(registrationInput), test.coordinator.register(registrationInput)];
		await Promise.resolve();
		releaseRegistration();
		const settled = await Promise.allSettled(attempts);
		expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		const writer = (settled.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof test.coordinator.register>>>).value;
		expect(writer).toMatchObject({ participantId: "writer", holderGeneration: "lease_writer", workspace: { state: "active" } });
		expect(test.store.read().targets[writer.registration.targetKey]).toMatchObject({ kind: "pi", projectRoot: test.project, workspaceId: provisioned.workspace.workspaceId, workspaceRoot: provisioned.workspace.worktreePath });
		await expect(test.coordinator.register({ launchToken, piSessionId: "session_writer", piSessionFile: writerSession, clientGeneration: "client_writer", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_writer" } })).rejects.toThrow("consumed");
		test.participants.standDown(writer.registration, writer.participantKey);
		expect(await test.coordinator.reconnect({ workspaceId: provisioned.workspace.workspaceId, piSessionId: "session_writer", piSessionFile: writerSession, clientGeneration: "client_writer", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_writer" } })).toMatchObject({ participantState: "vacant", participantGeneration: "lease_2" });
		const reacquired = test.participants.acquire(writer.registration, "review", "writer").participant;
		expect(test.store.read().workspaces[provisioned.workspace.workspaceId]?.holderGeneration).toBe(reacquired.generation);

		test.registrations.close();
		const restartedRegistrations = new RuntimeRegistrationManager(test.store, test.host, test.registrationOptions);
		const restarted = new RuntimeWorkspaceCoordinator(join(test.root, "runtime"), test.store, restartedRegistrations, test.host, { createId: (kind) => kind === "integration" ? "integration_1" : "unused" });
		const reconnected = await restarted.reconnect({ workspaceId: provisioned.workspace.workspaceId, piSessionId: "session_writer", piSessionFile: writerSession, clientGeneration: "client_writer", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_writer" } });
		expect(reconnected.registration.targetKey).toBe(writer.registration.targetKey);
		const restartedMain = await restartedRegistrations.register(test.input);
		const participants = new HostedParticipantCoordinator(test.store, restartedRegistrations, { request() {} }, { createGeneration: () => "lease_stopped", stopTarget: async () => "closed", onStopped: (target, generation) => restarted.retainTarget(target.targetKey, generation) });
		await participants.stopConfirmed(restartedMain, writer.participantKey, reconnected.holderGeneration);
		expect(restarted.inspect(restartedMain, provisioned.workspace.workspaceId).state).toBe("retained");

		writeFileSync(join(provisioned.workspace.worktreePath, "app.txt"), "writer\n");
		writeFileSync(join(provisioned.workspace.worktreePath, "new.bin"), Buffer.from([4, 5, 6]));
		const checkpoint = await restarted.checkpoint(restartedMain, { workspaceId: provisioned.workspace.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, taskStatus: "completed" });
		expect(checkpoint).toMatchObject({ state: "ready_handoff", changedFiles: 2, commits: [expect.stringMatching(/^[0-9a-f]{40}$/)] });
		expect(readFileSync(join(test.project, "app.txt"), "utf8")).toBe("base\n");
		const originalApply = test.store.apply.bind(test.store);
		let crashPreparation = true;
		test.store.apply = ((operation) => {
			if (crashPreparation && operation.type === "integration.replace") throw new Error("injected preparation crash");
			return originalApply(operation);
		}) as typeof test.store.apply;
		await expect(restarted.prepareIntegration(restartedMain, { workspaceId: checkpoint.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation })).rejects.toThrow();
		expect(Object.values(test.store.read().integrations)).toContainEqual(expect.objectContaining({ state: "preparing" }));
		crashPreparation = false;
		const integration = await restarted.prepareIntegration(restartedMain, { workspaceId: checkpoint.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation });
		expect(integration.state).toBe("prepared");
		let failWorkspaceEvidence = true;
		test.store.apply = ((operation) => {
			if (failWorkspaceEvidence && operation.type === "workspace.replace" && operation.workspace.state === "integrated") { failWorkspaceEvidence = false; throw new Error("injected workspace evidence failure"); }
			return originalApply(operation);
		}) as typeof test.store.apply;
		await expect(restarted.finalizeIntegration(restartedMain, { integrationId: integration.integrationId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation })).rejects.toThrow("injected workspace evidence failure");
		expect(test.store.read().integrations[integration.integrationId]?.state).toBe("finalized");
		const finalized = await restarted.finalizeIntegration(restartedMain, { integrationId: integration.integrationId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation });
		expect(finalized.state).toBe("finalized");
		expect(readFileSync(join(test.project, "app.txt"), "utf8")).toBe("writer\n");
		expect(await restarted.cleanupIntegration(restartedMain, { integrationId: integration.integrationId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, discardConfirmed: false })).toMatchObject({ state: "cleaned" });
		expect(await restarted.cleanupWorkspace(restartedMain, { workspaceId: checkpoint.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, discardConfirmed: false })).toMatchObject({ state: "cleaned" });
		expect(existsSync(provisioned.workspace.worktreePath)).toBe(false);
	});

	it("serializes response-loss recovery behind active workspace creation", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		const internals = test.coordinator as unknown as { git: { createWorktree(...args: unknown[]): Promise<void> } };
		const originalCreate = internals.git.createWorktree.bind(internals.git);
		let release!: () => void;
		let started!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { started = resolve; });
		internals.git.createWorktree = async (...args: unknown[]) => { started(); await barrier; return originalCreate(...args); };
		const input = { requestId: "racing_create", callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review", participantId: "writer", piSessionId: "session_writer" };
		const creating = test.coordinator.create(main, input);
		await entered;
		await expect(test.coordinator.recoverLaunch(main, { requestId: input.requestId, callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation })).rejects.toThrow("Another Runtime Git operation");
		release();
		const created = await creating;
		expect(created.workspace.state).toBe("ready");
		expect(await test.coordinator.recoverLaunch(main, { requestId: input.requestId, callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation })).toMatchObject({ state: "cleaned" });
	});

	it("activates and retains an isolated workspace through its final bridge target", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		const workspace = await test.coordinator.createBridge(main, { requestId: "bridge_workspace", bridgeId: "launch_native", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "native" });
		expect(workspace.workspace).toMatchObject({ ownerKind: "bridge", bridgeId: "launch_native", state: "ready" });
		test.host.panes.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_native", cwd: workspace.workspace.worktreePath, paneCount: 1, revision: 1 });
		await test.coordinator.bind(main, { workspaceId: workspace.workspace.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, herdr: { paneId: "w1:p9", terminalId: "term_native" } });
		const secrets = [Buffer.alloc(32, 7).toString("base64url"), Buffer.alloc(32, 8).toString("base64url")];
		const bridges = new RuntimeBridgeCoordinator(test.store, test.registrations, test.host, { createSecret: () => secrets.shift()! });
		const launch = await bridges.create(main, { requestId: "bridge_launch", launchId: "launch_native", workspaceId: workspace.workspace.workspaceId, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "native", profile: "workspace-write", configurationHash: "a".repeat(64), herdr: { paneId: "w1:p9", terminalId: "term_native" }, metadata: { adapter: "native-v1" } });
		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_native", cwd: workspace.workspace.worktreePath, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: "launch_native" }, status: "idle", stateChangeSeq: 2 });
		const native = await bridges.register({ launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, clientGeneration: "client_native", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_native" } });
		expect(native).toMatchObject({ cwd: workspace.workspace.worktreePath, workspaceId: workspace.workspace.workspaceId, profile: "workspace-write" });
		expect(test.store.read().workspaces[workspace.workspace.workspaceId]).toMatchObject({ state: "active", targetKey: native.registration.targetKey });
		expect(test.store.read().targets[native.registration.targetKey]).toMatchObject({ kind: "bridge", workspaceId: workspace.workspace.workspaceId, workspaceRoot: workspace.workspace.worktreePath });
		writeFileSync(join(workspace.workspace.worktreePath, "task.txt"), "dirty\n");
		const evidence = await test.coordinator.taskEvidence(native.registration.targetKey);
		expect(evidence).toMatchObject({ workspaceId: workspace.workspace.workspaceId, baseCommit: workspace.workspace.baseCommit, headCommit: workspace.workspace.headCommit, dirty: true, artifactRef: workspace.workspace.branchRef });
		const task = test.participants.sendTask(main, mainParticipant.participantKey, mainParticipant.generation, native.participantKey, "task_native", "Write task.txt.");
		const taskResult = test.participants.resultTask(native.registration, native.participantKey, native.holderGeneration, task.eventId, "reply_native", "completed", "Done.", "committed", evidence);
		expect(taskResult.payload.workspace).toEqual(evidence);
		rmSync(join(workspace.workspace.worktreePath, "task.txt"));
		expect(await test.coordinator.taskEvidence(native.registration.targetKey)).toMatchObject({ dirty: false, capturedAt: expect.any(Number) });
		expect(test.participants.recoverTaskResult(native.registration, native.participantKey, native.holderGeneration, task.eventId, "reply_native", "completed", "Done.", "committed")?.payload.workspace).toEqual(evidence);
		expect(test.participants.taskStatus(main, mainParticipant.participantKey, mainParticipant.generation, task.eventId)).toMatchObject({ status: "completed", workspace: { workspaceId: workspace.workspace.workspaceId, dirty: true } });
		const stopping = new HostedParticipantCoordinator(test.store, test.registrations, { request() {} }, { createGeneration: () => "lease_stopped", stopTarget: async () => "closed", onStopped: (target, generation) => test.coordinator.retainTarget(target.targetKey, generation) });
		await stopping.stopConfirmed(main, native.participantKey, native.holderGeneration);
		expect(test.store.read().workspaces[workspace.workspace.workspaceId]?.state).toBe("retained");
		expect(readFileSync(join(test.project, "app.txt"), "utf8")).toBe("base\n");
	});

	it("exposes strict additive workspace RPC and capability discovery", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const mainParticipant = test.participants.acquire(main, "review", "main").participant;
		const monitors = new DirectoryMonitorManager(test.store, { automatic: false });
		const wakes = new HostedWakeCoordinator(test.store);
		const context: HostedProtocolContext = { runtimeId: "rt_test", epoch: "epoch_test", agentWake: "none", registrations: test.registrations, monitors, wakes, participants: test.participants, workspaces: test.coordinator };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		expect(await call("hello", { minVersion: 1, maxVersion: 1 })).toMatchObject({ ok: true, result: { capabilities: { workspace: { isolatedWrite: true, stagedIntegration: true } } } });
		const auth = { registrationId: main.registrationId, registrationKey: main.registrationKey };
		const input = { ...auth, requestId: "rpc_workspace", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "writer", piSessionId: "session_writer" };
		expect(await call("workspace.launch.create", { ...input, extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const created = await call("workspace.launch.create", input);
		expect(created).toMatchObject({ ok: true, result: { workspace: { state: "ready", profile: "workspace-write", worktreePath: expect.stringContaining("workspace_1") }, launchToken: expect.stringMatching(/^workspace_launch_/) } });
		const workspaceId = (created as { result: { workspace: { workspaceId: string } } }).result.workspace.workspaceId;
		expect(await call("workspace.launch.create", input)).toMatchObject({ ok: true, result: { workspace: { workspaceId }, recoveryRequired: true } });
		expect(await call("workspace.inspect", { ...auth, workspaceId })).toMatchObject({ ok: true, result: { workspace: { workspaceId, state: "ready" } } });
		expect(await call("workspace.launch.recover", { ...auth, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, requestId: "rpc_workspace" })).toMatchObject({ ok: true, result: { workspace: { workspaceId, state: "cleaned" } } });
		const bridgeInput = { ...auth, requestId: "rpc_bridge_workspace", callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, protocol: "review", participantId: "native", bridgeId: "launch_native" };
		const bridgeCreated = await call("workspace.bridge.create", bridgeInput);
		expect(bridgeCreated).toMatchObject({ ok: true, result: { workspace: { ownerKind: "bridge", bridgeId: "launch_native", state: "ready" } } });
		expect(await call("workspace.bridge.create", bridgeInput)).toMatchObject({ ok: true, result: { recoveryRequired: true } });
		expect(await call("workspace.launch.recover", { ...auth, callerParticipantKey: mainParticipant.participantKey, expectedCallerGeneration: mainParticipant.generation, requestId: "rpc_bridge_workspace" })).toMatchObject({ ok: true, result: { workspace: { state: "cleaned" } } });
		wakes.close();
	});
});
