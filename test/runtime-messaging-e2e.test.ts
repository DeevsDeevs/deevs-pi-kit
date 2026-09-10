import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import { HOSTED_ACK_RETENTION_MS, type HostedMessagingReceipt } from "../extensions/runtime/hosted-types.ts";
import type { HostedLiveAgent, RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";
import { HostedStateStorageError, HostedStateStore, readHostedRuntimeState, runtimeStatePaths } from "../extensions/runtime/service/state.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Auth = { registrationId: string; registrationKey: string; targetKey: string };
type Participant = { participantKey: string; generation: string };
type Call = { name: string; arguments: Record<string, string> };
type Result = { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: { namespaceId: string; publication: Omit<HostedMessagingReceipt, "fingerprint">; event?: { eventId: string; payload: { body: string }; delivery: { status: string } }; peers?: Array<{ participantId: string }> } };

async function setup(monitor: { scanIntervalMs?: number; onError?: (error: Error) => void } = {}) {
	const root = mkdtempSync(join(tmpdir(), "messaging-e2e-"));
	const projectRoot = join(root, "project");
	mkdirSync(projectRoot);
	const runtimeRoot = join(root, "runtime");
	let now = 1000;
	let beforeVerify = async () => {};
	const agents = new Map<string, HostedLiveAgent>();
	const inputs = new Map<string, RegisterPiInput>();
	for (const name of ["sender", "recipient", "outsider"]) {
		const cwd = name === "outsider" ? join(root, "other-project") : projectRoot;
		mkdirSync(cwd, { recursive: true });
		const file = join(root, `${name}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd })}\n`);
		agents.set(name, { paneId: name, terminalId: `terminal_${name}`, cwd, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: file }, status: "idle", stateChangeSeq: 1 });
		inputs.set(name, { projectRoot: cwd, piSessionId: name, piSessionFile: file, clientGeneration: `client_${name}`, admittedClaims: [], herdr: { paneId: name, terminalId: `terminal_${name}` } });
	}
	// Only Herdr identity is a fixture. MCP is a real child; RPC, authorization,
	// publication, delivery claims and restart recovery use the actual service/store.
	const options = { root: runtimeRoot, monitor, host: { async getPane(id: string) { return agents.get(id)!; }, async findTerminal(id: string) { await beforeVerify(); return [...agents.values()].find(a => a.terminalId === id)!; } }, registration: { now: () => now }, participant: { now: () => now }, wake: { now: () => now } };
	let server: RuntimeServerHandle = await startRuntimeServer(options);
	cleanups.push(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
	const client = new HostedRuntimeClient(server.socketPath);
	const register = async (name: string) => await client.call("pi.register", inputs.get(name)!) as Auth;
	const sender = await register("sender");
	const recipient = await register("recipient");
	const outsider = await register("outsider");
	const acquire = async (auth: Auth, name: string) => (await client.call("participant.acquire", { registrationId: auth.registrationId, registrationKey: auth.registrationKey, protocol: "proof", participantId: name }) as { participant: Participant }).participant;
	const senderParticipant = await acquire(sender, "sender");
	const recipientParticipant = await acquire(recipient, "recipient");
	await acquire(outsider, "outsider");
	const issue = async () => await client.call("messaging.issue", { registrationId: sender.registrationId, registrationKey: sender.registrationKey, participantKey: senderParticipant.participantKey, expectedGeneration: senderParticipant.generation, confirmed: true }) as { namespaceId: string; descriptorPath: string };
	const issued = await issue();
	const { namespaceId, secret } = JSON.parse(readFileSync(issued.descriptorPath, "utf8")) as { namespaceId: string; secret: string };
	const descriptor = { namespaceId, secret };
	return { root, runtimeRoot, client, sender, recipient, outsider, senderParticipant, recipientParticipant, issued, descriptor, inputs, register, setVerificationHook(hook: () => Promise<void>) { beforeVerify = hook; }, setNow(value: number) { now = value; }, async restart() { await server.close(); server = await startRuntimeServer(options); Object.assign(sender, await register("sender")); Object.assign(recipient, await register("recipient")); }, readState() { return readHostedRuntimeState(runtimeRoot); } };
}

async function mcp(path: string, calls: Call[]): Promise<Result[]> {
	const { namespaceId } = JSON.parse(readFileSync(path, "utf8")) as { namespaceId: string };
	const child = spawn(process.execPath, [resolve("extensions/runtime/mcp/main.mjs"), path], { stdio: ["pipe", "pipe", "pipe"] });
	const completed = once(child, "close");
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		const requests = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "tools/list" }, ...calls.map((call, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { ...call, arguments: call.name === "collaborator_peers" ? call.arguments : { namespaceId, ...call.arguments } } }))];
		child.stdin.end(requests.map(r => JSON.stringify(r)).join("\n") + "\n");
		const [code] = await completed;
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const frames = stdout.trim().split("\n");
		for (const line of frames) expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(256 * 1024);
		const responses = frames.map(line => JSON.parse(line));
		expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["collaborator_peers", "collaborator_send", "collaborator_status"]);
		expect(responses).toHaveLength(calls.length + 2);
		const secret = (JSON.parse(readFileSync(path, "utf8")) as { secret: string }).secret;
		expect(stdout + stderr).not.toContain(secret);
		return responses.slice(2).map(response => response.result) as Result[];
	} finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); }
}

const send = (operationId: string, body = "Please inspect."): Call => ({ name: "collaborator_send", arguments: { participantId: "recipient", operationId, body } });
const status = (operationId: string): Call => ({ name: "collaborator_status", arguments: { operationId } });

it("publishes through MCP/socket/store, claims and acknowledges through native RPC, then recovers the exact receipt after Runtime and MCP restart", async () => {
	const test = await setup();
	const [peers, sent, firstStatus] = await mcp(test.issued.descriptorPath, [{ name: "collaborator_peers", arguments: {} }, send("op-1"), status("op-1")]);
	expect(peers!.structuredContent.peers).toEqual([{ participantId: "recipient", state: "held", holderLive: true }]);
	expect(sent!.isError).toBe(false);
	const receipt = sent!.structuredContent.publication;
	expect(firstStatus!.structuredContent.event?.delivery.status).toBe("pending");
	const auth = { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey };
	const claim = await test.client.call("inbox.claim", { ...auth, maxEvents: 1 }) as { claimId: string; events: Array<{ eventId: string; payload: { body: string } }> };
	expect(claim.events).toMatchObject([{ eventId: receipt.eventId, payload: { body: "Please inspect." } }]);
	await test.client.call("inbox.ack", { ...auth, claimId: claim.claimId, eventIds: [receipt.eventId] });
	await test.restart();
	const [retry, recovered] = await mcp(test.issued.descriptorPath, [send("op-1"), status("op-1")]);
	expect(retry!.structuredContent.publication).toEqual(receipt);
	expect(recovered!.structuredContent.event?.delivery.status).toBe("acked");
	expect(Object.keys(test.readState().events)).toEqual([receipt.eventId]);
	expect(statSync(test.issued.descriptorPath).mode & 0o777).toBe(0o600);
	expect(readFileSync(runtimeStatePaths(test.runtimeRoot).state, "utf8")).not.toContain(test.descriptor.secret);
});

it("recovers a publication when the Runtime response is actually dropped on the socket", async () => {
	const test = await setup();
	const proxyPath = join(test.runtimeRoot, "drop.sock");
	const proxy = createServer(front => {
		const backend = createConnection(test.client.socketPath);
		front.on("error", () => {});
		backend.on("error", () => front.destroy());
		front.pipe(backend);
		// The actual service has committed before it emits any success bytes.
		backend.once("data", () => { front.destroy(); backend.destroy(); });
		front.once("close", () => backend.destroy());
	});
	proxy.listen(proxyPath);
	await once(proxy, "listening");
	const descriptor = join(test.runtimeRoot, "drop-response.json");
	writeFileSync(descriptor, JSON.stringify({ version: 1, socketPath: proxyPath, ...test.descriptor }), { mode: 0o600 });
	try {
		const [lost] = await mcp(descriptor, [send("lost-response")]);
		expect(lost!.isError).toBe(true);
		const committed = Object.values(test.readState().events);
		expect(committed).toHaveLength(1);
		const [recovered] = await mcp(test.issued.descriptorPath, [send("lost-response")]);
		expect(recovered!.structuredContent.publication.eventId).toBe(committed[0]!.eventId);
		expect(Object.keys(test.readState().events)).toHaveLength(1);
	} finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

it("transports the real maximum escaped event, recovers an ended-recipient retry, and rejects changed retries", async () => {
	const test = await setup();
	const body = "\u0000".repeat(16 * 1024);
	const [sent, seen] = await mcp(test.issued.descriptorPath, [send("escaped", body), status("escaped")]);
	expect(seen!.isError).toBe(false);
	expect(seen!.structuredContent.event?.payload.body).toBe(body);
	expect(JSON.parse(seen!.content[0]!.text)).toEqual(seen!.structuredContent);
	await expect(test.client.call("messaging.status", { ...test.descriptor, operationId: "escaped" })).rejects.toMatchObject({ code: "invalid_response" });
	await test.client.call("participant.release", { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey, participantKey: test.recipientParticipant.participantKey });
	const [retry, conflict, fresh] = await mcp(test.issued.descriptorPath, [send("escaped", body), send("escaped", "changed"), send("new")]);
	expect(retry!.structuredContent.publication).toEqual(sent!.structuredContent.publication);
	expect(conflict!.isError).toBe(true);
	expect(fresh!.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(1);
});

it("never grants lifecycle authority to the messaging secret and fences client replacement", async () => {
	const test = await setup();
	const forbidden: Array<[string, Record<string, unknown>]> = [
		["pi.heartbeat", {}],
		["inbox.claim", { maxEvents: 1 }],
		["participant.acquire", { protocol: "proof", participantId: "forged" }],
		["participant.stop_confirmed", { participantKey: test.recipientParticipant.participantKey, expectedGeneration: test.recipientParticipant.generation, confirmed: true }],
		["workspace.integration.finalize", { callerParticipantKey: test.senderParticipant.participantKey, expectedCallerGeneration: test.senderParticipant.generation, integrationId: "missing" }],
	];
	for (const [method, params] of forbidden) {
		await expect(test.client.call(method, { ...params, registrationId: test.descriptor.namespaceId, registrationKey: test.descriptor.secret })).rejects.toMatchObject({ code: "registration_stale" });
	}
	await expect(test.client.call("messaging.peers", { ...test.descriptor, secret: test.sender.registrationKey })).rejects.toMatchObject({ code: "registration_stale" });
	await expect(test.client.call("messaging.send", { ...test.descriptor, operationId: "forged", participantId: "recipient", bodyBase64: Buffer.from("forged").toString("base64"), senderParticipantKey: test.recipientParticipant.participantKey })).rejects.toMatchObject({ code: "invalid_request" });
	const [wrongNamespace] = await mcp(test.issued.descriptorPath, [{ ...send("cross-wired"), arguments: { ...send("cross-wired").arguments, namespaceId: "msg_00000000-0000-0000-0000-000000000000" } }]);
	expect(wrongNamespace!.isError).toBe(true);
	test.inputs.get("sender")!.clientGeneration = "replacement-client";
	await test.register("sender");
	test.inputs.get("sender")!.clientGeneration = "client_sender";
	await test.register("sender");
	const [denied] = await mcp(test.issued.descriptorPath, [send("stale")]);
	expect(denied!.isError).toBe(true);
	expect(test.readState().messaging[test.issued.namespaceId]?.status).toBe("revoked");
	expect(Object.keys(test.readState().events)).toHaveLength(0);
});

it("rejects a holder change across asynchronous host verification before publication", async () => {
	const test = await setup();
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const blocked = new Promise<void>(resolve => { release = resolve; });
	test.setVerificationHook(async () => { entered(); await blocked; });
	const sending = mcp(test.issued.descriptorPath, [send("raced")]);
	await started;
	try {
		await test.client.call("participant.stand_down", { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey, participantKey: test.senderParticipant.participantKey, expectedGeneration: test.senderParticipant.generation });
	} finally { release(); }
	const [result] = await sending;
	expect(result!.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(0);
});

it("returns no success or receipt on a real persistence failure", async () => {
	const test = await setup();
	const file = runtimeStatePaths(test.runtimeRoot).state;
	const backup = `${file}.backup`;
	renameSync(file, backup);
	mkdirSync(file);
	try {
		const [failed] = await mcp(test.issued.descriptorPath, [send("failed-commit")]);
		expect(failed!.isError).toBe(true);
	} finally { rmSync(file, { recursive: true }); renameSync(backup, file); }
	const [stillAvailable] = await mcp(test.issued.descriptorPath, [{ name: "collaborator_peers", arguments: {} }]);
	expect(stillAvailable!.isError).toBe(false);
	await test.restart();
	expect(Object.keys(test.readState().events)).toHaveLength(0);
	expect(test.readState().messaging[test.issued.namespaceId]?.receipts).toEqual({});
	const [retry] = await mcp(test.issued.descriptorPath, [send("failed-commit")]);
	expect(retry!.isError).toBe(false);
});

it("fences a post-rename directory-sync failure until restart, preserving the original publication", async () => {
	const errors = new EventEmitter();
	const monitorFailure = once(errors, "monitor-error");
	const test = await setup({ scanIntervalMs: 20, onError: error => errors.emit("monitor-error", error) });
	const originalSync = fs.fsyncSync;
	let injected = 0;
	const fault = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
		if (fs.fstatSync(fd).isDirectory()) {
			injected++;
			throw Object.assign(new Error("Injected directory-sync failure"), { code: "EIO" });
		}
		originalSync(fd);
	});
	syncBuiltinESMExports();
	try {
		const [failed] = await mcp(test.issued.descriptorPath, [send("uncertain")]);
		expect(injected).toBe(1);
		expect(failed!.isError).toBe(true);
		// Recovery must confirm directory durability, not merely reread page cache.
		expect(() => new HostedStateStore(test.runtimeRoot)).toThrow(HostedStateStorageError);
		expect(injected).toBe(2);
	} finally { fault.mockRestore(); syncBuiltinESMExports(); }
	const file = runtimeStatePaths(test.runtimeRoot).state;
	const snapshot = readFileSync(file, "utf8");
	const persisted = test.readState();
	const receipt = persisted.messaging[test.issued.namespaceId]!.receipts.uncertain!;
	const { fingerprint: _fingerprint, ...publication } = receipt;
	expect((await monitorFailure)[0]).toMatchObject({ code: "storage_error", uncertain: true });
	expect(Object.keys(persisted.events)).toEqual([receipt.eventId]);
	const [retry, other, lookup] = await mcp(test.issued.descriptorPath, [send("uncertain"), send("must-not-overwrite"), status("uncertain")]);
	for (const result of [retry, other, lookup]) {
		expect(result!.isError).toBe(true);
		expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ code: "storage_error" });
	}
	expect(readFileSync(file, "utf8")).toBe(snapshot);
	await test.restart();
	const [recovered] = await mcp(test.issued.descriptorPath, [send("uncertain")]);
	expect(recovered!.isError).toBe(false);
	expect(recovered!.structuredContent.publication).toEqual(publication);
	expect(test.readState().messaging[test.issued.namespaceId]!.receipts.uncertain).toEqual(receipt);
	expect(Object.keys(test.readState().events)).toEqual([receipt.eventId]);
});

it("persists terminal expiry across clock rollback and restart without republishing", async () => {
	const test = await setup();
	await mcp(test.issued.descriptorPath, [send("expiry")]);
	test.setNow(1000 + HOSTED_ACK_RETENTION_MS);
	const [expired] = await mcp(test.issued.descriptorPath, [send("expiry")]);
	expect(expired!.isError).toBe(true);
	test.setNow(1000);
	await test.restart();
	const [rolledBack] = await mcp(test.issued.descriptorPath, [send("expiry")]);
	expect(rolledBack!.isError).toBe(true);
	expect(test.readState().messaging[test.issued.namespaceId]?.status).toBe("expired");
	expect(Object.keys(test.readState().events)).toHaveLength(1);
});
