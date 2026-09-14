import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedRuntimeClient, HostedRuntimeClientError } from "../extensions/runtime/client.ts";
import { HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";

const roots: string[] = [];
const servers: RuntimeServerHandle[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeHost implements HostedHostVerifier {
	agent: HostedLiveAgent;
	constructor(agent: HostedLiveAgent) { this.agent = agent; }
	async getAgent(): Promise<HostedLiveAgent> { return this.agent; }
}

describe("hosted runtime client vertical", () => {
	it("registers and authorizes Monitor operations through the real Unix socket", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-client-"));
		roots.push(root);
		const projectRoot = join(root, "project");
		const watchRoot = join(projectRoot, "reviews");
		const sessionFile = join(root, "session.jsonl");
		const fableSessionFile = join(root, "fable.jsonl");
		mkdirSync(watchRoot, { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		writeFileSync(fableSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_2", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		const host = new FakeHost({ name: "pi-main", cwd: projectRoot });
		const registrationIds = ["reg_client", "reg_fable"];
		const registrationKeys = ["secret_client", "secret_fable"];
		const server = await startRuntimeServer({
			root: join(root, "runtime"),
			host,
			monitor: { automatic: false, now: () => 1_000, createId: (prefix) => `${prefix}_client` },
			registration: { now: () => 1_000, createId: () => registrationIds.shift()!, createKey: () => registrationKeys.shift()! },
		});
		servers.push(server);
		const client = new HostedRuntimeClient(server.socketPath);
		expect(await client.hello()).toMatchObject({ capabilities: { agentWake: "none", mailbox: { maxBodyBytes: 16_384 } } });
		const registration = await client.call("pi.register", {
			projectRoot,
			piSessionId: "session_1",
			piSessionFile: sessionFile,
		}) as Record<string, unknown>;
		expect(registration).toMatchObject({ registrationId: "reg_client", registrationKey: "secret_client" });
		const auth = { registrationId: "reg_client", registrationKey: "secret_client" };
		const sender = await client.call("participant.acquire", { ...auth, protocol: "review", participantId: "main" }) as { participant: { participantKey: string; generation: string } };
		expect(sender).toMatchObject({ participant: { participantId: "main", holderLive: true }, revived: false });
		const fableRegistration = await client.call("pi.register", { projectRoot, piSessionId: "session_2", piSessionFile: fableSessionFile }) as Record<string, unknown>;
		const fableAuth = { registrationId: String(fableRegistration.registrationId), registrationKey: String(fableRegistration.registrationKey) };
		const recipient = await client.call("participant.acquire", { ...fableAuth, protocol: "review", participantId: "fable" }) as { participant: { participantKey: string } };
		expect(await client.call("participant.list", auth)).toMatchObject({ participants: [{ participantId: "fable" }, { participantId: "main" }] });
		expect(await client.call("monitor.create", { ...auth, directory: watchRoot, settleMs: 250 })).toMatchObject({ monitorId: "mon_client", status: "watching" });
		expect(await client.call("monitor.get", auth)).toMatchObject({ monitor: { monitorId: "mon_client" } });
		await client.call("mailbox.send", { ...auth, senderParticipantKey: sender.participant.participantKey, expectedSenderGeneration: sender.participant.generation, recipientParticipantKey: recipient.participant.participantKey, sendId: "send_client", body: "Focused mail" });
		expect(await client.call("pi.heartbeat", fableAuth)).toMatchObject({ registrationId: fableAuth.registrationId });
		expect(await client.call("pi.heartbeat", { ...auth, admit: true })).toMatchObject({ registrationId: "reg_client" });
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
		const host = new FakeHost({ name: "pi-main", cwd: projectRoot });
		const runtimeRoot = join(root, "runtime");
		const server = await startRuntimeServer({ root: runtimeRoot, host, monitor: { automatic: false }, registration: { createId: () => "reg_race", createKey: () => "key_race" } });
		servers.push(server);
		const pi = { exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }) };
		const ctx = { cwd: projectRoot, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session_1", getBranch: () => [] } };
		const integration = new HostedRuntimeIntegration(pi as never, runtimeRoot);
		const starting = integration.sessionStart(ctx as never);
		await integration.sessionShutdown();
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
