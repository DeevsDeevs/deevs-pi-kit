import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { HerdrCliHostVerifier } from "../extensions/runtime/service/herdr-cli.ts";
import { RuntimeError } from "../extensions/runtime/errors.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore, piTargetKey } from "../extensions/runtime/service/state.ts";

const herdrResult = vi.hoisted(() => ({ value: {} as unknown, failure: undefined as string | undefined }));
vi.mock("node:child_process", async importOriginal => ({
	...await importOriginal<typeof import("node:child_process")>(),
	execFile: vi.fn((_command: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
		if (herdrResult.failure !== undefined) return callback(new Error("herdr exited non-zero"), herdrResult.failure);
		return callback(null, JSON.stringify({ result: herdrResult.value }));
	}),
}));

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	agent: HostedLiveAgent;
	available = true;

	constructor(agent: HostedLiveAgent) { this.agent = agent; }
	async getAgent(_agentName: string): Promise<HostedLiveAgent> {
		if (!this.available) throw new RuntimeError("host_unavailable", "offline");
		return this.agent;
	}
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-registration-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	const sessionFile = join(root, "session.jsonl");
	mkdirSync(projectRoot, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	const store = new HostedStateStore(join(root, "runtime"));
	const host = new FakeHost({ name: "collab-1", cwd: projectRoot, tabId: "w1:t1", workspaceId: "w1" });
	let now = 1_000;
	let nextId = 0;
	const registrations = new RuntimeRegistrationManager(store, host, {
		now: () => now,
		leaseMs: 30_000,
		createId: () => `reg_${++nextId}`,
		createKey: () => `key_${nextId}`,
	});
	const input: RegisterPiInput = { projectRoot, piSessionId: "session_1", piSessionFile: sessionFile };
	return { root, projectRoot, sessionFile, store, host, registrations, input, setNow: (value: number) => { now = value; } };
}

describe("Herdr agent queries", () => {
	it("resolves one exact agent and separates a refusal from an unanswered query", async () => {
		herdrResult.value = { agent: { name: "collab-1", cwd: "/project", tab_id: "w1:t1", workspace_id: "w1" } };
		await expect(new HerdrCliHostVerifier().getAgent("collab-1")).resolves.toEqual({ name: "collab-1", cwd: "/project", tabId: "w1:t1", workspaceId: "w1" });
		expect(execFile).toHaveBeenCalledWith("herdr", ["agent", "get", "collab-1"], expect.objectContaining({ timeout: 2000 }), expect.any(Function));
		herdrResult.value = { agent: { name: "collab-1" } };
		await expect(new HerdrCliHostVerifier().getAgent("collab-1")).rejects.toMatchObject({ code: "host_unavailable" });
		herdrResult.failure = JSON.stringify({ error: { code: "agent_not_found" } });
		await expect(new HerdrCliHostVerifier().getAgent("gone")).rejects.toMatchObject({ code: "identity_mismatch" });
		herdrResult.failure = "herdr: command not found";
		await expect(new HerdrCliHostVerifier().getAgent("gone")).rejects.toMatchObject({ code: "host_unavailable" });
		herdrResult.failure = undefined;
	});
});

describe("hosted Pi registration", () => {
	it("keys a durable target by its Pi session ID and mints fresh credentials for each client", async () => {
		const test = setup();
		const first = await test.registrations.register(test.input);
		expect(first).toEqual({ targetKey: piTargetKey("session_1"), registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 31_000 });
		expect(test.store.read().targets[first.targetKey]).toMatchObject({ projectRoot: test.projectRoot, piSessionFile: test.sessionFile });
		test.setNow(2_000);
		const replacement = await test.registrations.register(test.input);
		expect(replacement).toMatchObject({ targetKey: first.targetKey, registrationId: "reg_2", leaseUntil: 32_000 });
		expect(() => test.registrations.authorize(first.registrationId, first.registrationKey)).toThrow(RuntimeError);
		test.setNow(32_001);
		expect(() => test.registrations.authorize(replacement.registrationId, replacement.registrationKey)).toThrow(RuntimeError);
	});

	it("rejects a session file that does not carry the registered session identity", async () => {
		const test = setup();
		await expect(test.registrations.register({ ...test.input, piSessionId: "wrong_session" })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(test.registrations.register({ ...test.input, projectRoot: test.root })).rejects.toMatchObject({ code: "invalid_request" });
		await expect(test.registrations.register({ ...test.input, piSessionFile: join(test.root, "missing.jsonl") })).rejects.toMatchObject({ code: "invalid_request" });
		expect(test.store.read().targets).toEqual({});
	});

	it("keeps a heartbeat from resurrecting a registration removed while it verified", async () => {
		const test = setup();
		const registration = await test.registrations.register(test.input);
		const heartbeat = test.registrations.heartbeat(registration.registrationId, registration.registrationKey);
		test.registrations.unregister(registration.registrationId, registration.registrationKey);
		await expect(heartbeat).rejects.toMatchObject({ code: "registration_stale" });
		expect(() => test.registrations.authorize(registration.registrationId, registration.registrationKey)).toThrow(RuntimeError);
	});

});

describe("registration-authorized protocol", () => {
	it("registers, renews its lease, and rejects a stale key or an unknown params field", async () => {
		const test = setup();
		const context: HostedProtocolContext = { runtimeId: "rt_test", registrations: test.registrations };
		const call = (method: string, params: unknown) => dispatchHostedLine(JSON.stringify({ v: 1, id: method, method, params }), context);
		const registered = await call("pi.register", test.input);
		expect(registered).toMatchObject({ ok: true, result: { registrationId: "reg_1", registrationKey: "key_1" } });
		const auth = { registrationId: "reg_1", registrationKey: "key_1" };
		expect(await call("pi.heartbeat", auth)).toMatchObject({ ok: true, result: { registrationId: "reg_1", leaseUntil: 31_000 } });
		expect(await call("pi.heartbeat", { ...auth, registrationKey: "wrong" })).toMatchObject({ ok: false, error: { code: "registration_stale" } });
		expect(await call("pi.heartbeat", { ...auth, extra: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await call("pi.unregister", auth)).toMatchObject({ ok: true, result: { unregistered: true } });
		expect(await call("pi.heartbeat", auth)).toMatchObject({ ok: false, error: { code: "registration_stale" } });
	});
});
