import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedRuntimeClient, HostedRuntimeClientError } from "../extensions/runtime/client.ts";
import { HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/registration.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";

const roots: string[] = [];
const servers: RuntimeServerHandle[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeHost implements HostedHostVerifier {
	agent: HostedLiveAgent;
	getBarrier?: Promise<void>;
	onGet?: () => void;
	constructor(agent: HostedLiveAgent) { this.agent = agent; }
	async getPane(): Promise<HostedLiveAgent> { this.onGet?.(); await this.getBarrier; return this.agent; }
	async findTerminal(): Promise<HostedLiveAgent> { return this.agent; }
}

describe("hosted runtime client vertical", () => {
	it("registers and authorizes Monitor operations through the real Unix socket", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-client-"));
		roots.push(root);
		const projectRoot = join(root, "project");
		const watchRoot = join(projectRoot, "reviews");
		const sessionFile = join(root, "session.jsonl");
		mkdirSync(watchRoot, { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		const host = new FakeHost({
			paneId: "w1:p1",
			terminalId: "term_1",
			cwd: projectRoot,
			agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile },
			stateChangeSeq: 4,
		});
		const server = await startRuntimeServer({
			root: join(root, "runtime"),
			epoch: "epoch_client",
			host,
			monitor: { automatic: false, now: () => 1_000, createId: (prefix) => `${prefix}_client` },
			registration: { now: () => 1_000, createId: () => "reg_client", createKey: () => "secret_client" },
		});
		servers.push(server);
		const client = new HostedRuntimeClient(server.socketPath);
		expect(await client.hello()).toMatchObject({ epoch: "epoch_client", capabilities: { agentWake: "none" } });
		const registration = await client.call("pi.register", {
			projectRoot,
			piSessionId: "session_1",
			piSessionFile: sessionFile,
			clientGeneration: "client_1",
			admittedClaims: [],
			herdr: { paneId: "w1:p1", terminalId: "term_1" },
		}) as Record<string, unknown>;
		expect(registration).toMatchObject({ registrationId: "reg_client", registrationKey: "secret_client", hostStateChangeSeq: 4 });
		const auth = { registrationId: "reg_client", registrationKey: "secret_client" };
		expect(await client.call("monitor.create", { ...auth, directory: watchRoot, settleMs: 250 })).toMatchObject({ monitorId: "mon_client", status: "watching" });
		expect(await client.call("monitor.get", auth)).toMatchObject({ monitor: { monitorId: "mon_client" } });
		host.agent = { ...host.agent, paneId: "w1:p9", stateChangeSeq: 5 };
		expect(await client.call("pi.heartbeat", auth)).toMatchObject({ paneId: "w1:p9", hostStateChangeSeq: 5 });
		await expect(client.call("monitor.get", { ...auth, registrationKey: "wrong" })).rejects.toMatchObject({ code: "registration_stale" });
		await client.call("monitor.delete", { ...auth, monitorId: "mon_client" });
		expect(await client.call("monitor.get", auth)).toEqual({ monitor: null });
	});

	it("unregisters a registration that finishes after Pi session shutdown", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-client-race-"));
		roots.push(root);
		const projectRoot = join(root, "project");
		const sessionFile = join(root, "session.jsonl");
		mkdirSync(projectRoot);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		let release!: () => void;
		let entered!: () => void;
		const host = new FakeHost({ paneId: "w1:p1", terminalId: "term_1", cwd: projectRoot, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, stateChangeSeq: 1 });
		host.getBarrier = new Promise<void>((resolve) => { release = resolve; });
		const getEntered = new Promise<void>((resolve) => { entered = resolve; });
		host.onGet = entered;
		const runtimeRoot = join(root, "runtime");
		const server = await startRuntimeServer({ root: runtimeRoot, host, monitor: { automatic: false }, registration: { createId: () => "reg_race", createKey: () => "key_race" } });
		servers.push(server);
		const pi = { exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false }) };
		const ctx = { cwd: projectRoot, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session_1" } };
		const integration = new HostedRuntimeIntegration(pi as never, runtimeRoot);
		const starting = integration.sessionStart(ctx as never);
		await getEntered;
		await integration.sessionShutdown();
		release();
		await starting;
		const client = new HostedRuntimeClient(server.socketPath);
		await expect(client.call("monitor.get", { registrationId: "reg_race", registrationKey: "key_race" })).rejects.toMatchObject({ code: "registration_stale" });
	});

	it("returns a typed unavailable error for an absent socket", async () => {
		const client = new HostedRuntimeClient(join(tmpdir(), `missing-runtime-${Date.now()}.sock`), 100);
		await expect(client.hello()).rejects.toBeInstanceOf(HostedRuntimeClientError);
		await expect(client.hello()).rejects.toMatchObject({ code: "unavailable" });
	});
});
