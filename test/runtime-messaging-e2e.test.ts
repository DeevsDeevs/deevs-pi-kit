import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import { MessagingMcpClient } from "../extensions/runtime/mcp/client.ts";
import { messagingDescriptorPath } from "../extensions/runtime/service/messaging.ts";
import { HOSTED_ACK_RETENTION_MS } from "../extensions/runtime/hosted-types.ts";
import type { HostedLiveAgent, RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";
import { HostedStateStorageError, HostedStateStore, readHostedRuntimeState, runtimeStatePaths, writeHostedRuntimeState } from "../extensions/runtime/service/state.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Auth = { registrationId: string; registrationKey: string; targetKey: string };
type Participant = { participantKey: string; generation: string };
type Call = { name: string; arguments: Record<string, string> };
type Message = { eventId: string; from: string; body: string; createdAt: number; inReplyToEventId?: string; readAt?: number };
type Result = { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: { namespaceId: string; eventId: string; readAt?: number; message?: Message; event?: { eventId: string; body: string; readAt?: number; inReplyToEventId?: string; delivery: { status: string } }; peers?: Array<{ participantId: string }> } };

async function setup(monitor: { scanIntervalMs?: number; onError?: (error: Error) => void; onEvents?: (targetKey: string) => void; now?: () => number } = {}, recipientReady = true) {
	const root = mkdtempSync(join(tmpdir(), "messaging-e2e-"));
	const projectRoot = join(root, "project");
	mkdirSync(projectRoot);
	const runtimeRoot = join(root, "runtime");
	const sessionRoot = join(root, "proof-sessions");
	mkdirSync(sessionRoot);
	let now = 1000;
	const agents = new Map<string, HostedLiveAgent>();
	const inputs = new Map<string, RegisterPiInput>();
	for (const name of ["sender", "recipient", "outsider"]) {
		const cwd = name === "outsider" ? join(root, "other-project") : projectRoot;
		mkdirSync(cwd, { recursive: true });
		const file = join(sessionRoot, `${name}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd })}\n`);
		agents.set(name, { name, cwd });
		inputs.set(name, { projectRoot: cwd, piSessionId: name, piSessionFile: file, admittedClaims: [] });
	}
	// Only Herdr identity is a fixture. MCP is a real child; RPC, authorization,
	// publication, delivery claims and restart recovery use the actual service/store.
	const options = { root: runtimeRoot, monitor, host: { async getAgent(name: string) { return agents.get(name)!; } }, registration: { now: () => now }, participant: { now: () => now }, wake: { now: () => now } };
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
	const issue = async (participant = senderParticipant) => await client.call("messaging.issue", { registrationId: sender.registrationId, registrationKey: sender.registrationKey, participantKey: participant.participantKey, expectedGeneration: participant.generation, confirmed: true }) as { namespaceId: string; descriptorPath: string };
	const issued = await issue();
	if (recipientReady) await issue(recipientParticipant);
	const { namespaceId, secret } = JSON.parse(readFileSync(issued.descriptorPath, "utf8")) as { namespaceId: string; secret: string };
	const descriptor = { namespaceId, secret };
	return { root, runtimeRoot, client, sender, recipient, outsider, senderParticipant, recipientParticipant, issued, issue, descriptor, inputs, register, setNow(value: number) { now = value; }, async restart() { await server.close(); server = await startRuntimeServer(options); Object.assign(sender, await register("sender")); Object.assign(recipient, await register("recipient")); }, readState() { return readHostedRuntimeState(runtimeRoot); } };
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
		expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["collaborator_peers", "collaborator_send", "collaborator_status", "collaborator_receive", "collaborator_received", "collaborator_reply"]);
		expect(responses).toHaveLength(calls.length + 2);
		const secret = (JSON.parse(readFileSync(path, "utf8")) as { secret: string }).secret;
		expect(stdout + stderr).not.toContain(secret);
		return responses.slice(2).map(response => response.result) as Result[];
	} finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL"); }
}

async function piSession(test: Awaited<ReturnType<typeof setup>>, extraArgs: string[] = [], defaultRuntime = false) {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: defaultRuntime ? test.root : join(test.root, "pi-home") };
	delete env.PI_PACKAGE_DIR;
	if (defaultRuntime) {
		const bin = join(test.root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "herdr"), `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["pane", "current", "--current"])) process.exit(1);\nconsole.log(JSON.stringify({result:{pane:{pane_id:"sender",terminal_id:"terminal_sender"}}}));\n`, { mode: 0o700 });
		env.PATH = `${bin}:${env.PATH}`;
	}
	const binary = process.env.PI_KIT_MCP_TEST_PI;
	const child = spawn(binary ?? process.execPath, [...(binary ? [] : [resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js")]), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "collaborator_peers,collaborator_send,collaborator_status", "-e", resolve(defaultRuntime ? "extensions/runtime/index.ts" : "test/fixtures/mcp-pi-adapter.ts"), "-e", resolve("test/fixtures/mcp-pi-provider.ts"), "--provider", "mcp-proof", "--model", "proof", "--session", test.inputs.get("sender")!.piSessionFile, ...(defaultRuntime ? [] : ["--runtime-mcp-descriptor", test.issued.descriptorPath]), ...extraArgs], { cwd: test.inputs.get("sender")!.projectRoot, env, stdio: "pipe" });
	const completed = once(child, "close");
	const events = new EventEmitter();
	events.on("error", () => {});
	child.once("close", () => events.emit("error", new Error(`Pi exited: ${stderr}`)));
	const frames: any[] = [];
	let pending = "";
	let stderr = "";
	let bytes = 0;
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > 8 * 1024 * 1024) { child.kill("SIGTERM"); return; }
		pending += chunk;
		let newline: number;
		while ((newline = pending.indexOf("\n")) >= 0) {
			const frame = JSON.parse(pending.slice(0, newline));
			pending = pending.slice(newline + 1);
			frames.push(frame);
			events.emit(frame.type === "response" ? frame.id : frame.type, frame);
		}
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16384); });
	const timer = setTimeout(() => child.kill("SIGTERM"), 40_000);
	const kill = setTimeout(() => child.kill("SIGKILL"), 45_000);
	let id = 0;
	const command = async (input: object) => {
		const requestId = `rpc-${++id}`;
		const response = once(events, requestId);
		child.stdin.write(`${JSON.stringify({ ...input, id: requestId })}\n`);
		const [result] = await response;
		expect(result, stderr).toMatchObject({ success: true });
		return result.data;
	};
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		child.stdin.end();
		try {
			const [code] = await completed;
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			expect(JSON.stringify(frames) + stderr).not.toContain(test.descriptor.secret);
		} finally { clearTimeout(timer); clearTimeout(kill); }
	};
	cleanups.push(close);
	await command({ type: "get_state" });
	return { command, close, frames, async call(call: Call) {
		const start = frames.length;
		const settled = once(events, "agent_settled");
		await command({ type: "prompt", message: JSON.stringify(call) });
		await settled;
		const result = frames.slice(start).find(frame => frame.type === "tool_execution_end");
		expect(result, JSON.stringify(frames.slice(start))).toBeDefined();
		return result;
	} };
}

const send = (operationId: string, body = "Please inspect."): Call => ({ name: "collaborator_send", arguments: { participantId: "recipient", operationId, body } });
const status = (operationId: string): Call => ({ name: "collaborator_status", arguments: { operationId } });

const receive = (eventId: string): Call => ({ name: "collaborator_receive", arguments: { eventId } });
const received = (eventId: string): Call => ({ name: "collaborator_received", arguments: { eventId } });
const reply = (eventId: string, operationId = "reply-1", body = "Reply."): Call => ({ name: "collaborator_reply", arguments: { eventId, operationId, body } });

it("delivers a full body, records readAt, correlates a reply, and keeps ordinary mail out of native claims", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [sent] = await mcp(test.issued.descriptorPath, [send("offer", "\u0000".repeat(16384))]);
	const eventId = sent!.structuredContent.eventId;
	const [offered, repeated] = await mcp(recipient.descriptorPath, [receive(eventId), receive(eventId)]);
	expect(offered!.isError).toBe(false);
	expect(offered!.structuredContent.message).toEqual({ eventId, from: "sender", body: "\u0000".repeat(16384), createdAt: 1000 });
	expect(repeated!.structuredContent.message).toEqual(offered!.structuredContent.message);
	expect(test.readState().events[eventId]!.delivery.status).toBe("pending");
	const auth = { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey };
	await expect(test.client.call("inbox.claim", { ...auth, maxEvents: 1 })).rejects.toMatchObject({ code: "not_found" });
	const [replied, receipted, exactAgain] = await mcp(recipient.descriptorPath, [reply(eventId), received(eventId), receive(eventId)]);
	expect(replied!.isError).toBe(false);
	expect(receipted!.structuredContent).toEqual({ namespaceId: recipient.namespaceId, eventId, readAt: 1000 });
	expect(exactAgain!.structuredContent.message?.readAt).toBe(1000);
	expect(test.readState().events[eventId]!.delivery.status).toBe("pending");
	const [seen, lookup] = await mcp(test.issued.descriptorPath, [receive(replied!.structuredContent.eventId), status("offer")]);
	expect(seen!.structuredContent.message).toMatchObject({ body: "Reply.", inReplyToEventId: eventId });
	expect(lookup!.structuredContent.event).toMatchObject({ eventId, readAt: 1000 });
	await test.restart();
	const [retry] = await mcp(recipient.descriptorPath, [reply(eventId)]);
	expect(retry!.structuredContent.eventId).toBe(replied!.structuredContent.eventId);
	await test.client.call("participant.stand_down", { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey, participantKey: test.senderParticipant.participantKey, expectedGeneration: test.senderParticipant.generation });
	const [vacantRetry, changed, queued] = await mcp(recipient.descriptorPath, [reply(eventId), reply(eventId, "reply-1", "changed"), reply(eventId, "fresh")]);
	expect(vacantRetry!.structuredContent.eventId).toBe(replied!.structuredContent.eventId);
	expect(changed!.isError).toBe(true);
	// A vacant original sender still owns its participant identity, so the reply queues instead of failing.
	expect(queued!.isError).toBe(false);
	expect(Object.keys(test.readState().events)).toHaveLength(3);
});

it("hints the oldest unread message on the recipient heartbeat and stops once it is marked read", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const auth = { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey };
	await expect(test.client.call("pi.heartbeat", auth)).resolves.not.toHaveProperty("mail");
	const published = await mcp(test.issued.descriptorPath, [send("hint-1"), send("hint-2")]);
	// Both land at the same frozen clock, so the hint order falls back to the event ID.
	const [eventId] = published.map(result => result.structuredContent.eventId).sort();
	await expect(test.client.call("pi.heartbeat", auth)).resolves.toMatchObject({ mail: { namespaceId: recipient.namespaceId, eventId } });
	await mcp(recipient.descriptorPath, [receive(eventId)]);
	await expect(test.client.call("pi.heartbeat", auth)).resolves.toMatchObject({ mail: { eventId } });
	await mcp(recipient.descriptorPath, [received(eventId)]);
	const next = await test.client.call("pi.heartbeat", auth) as { mail: { eventId: string } };
	expect(next.mail.eventId).not.toBe(eventId);
	await expect(test.client.call("pi.heartbeat", { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey })).resolves.not.toHaveProperty("mail");
});

it("publishes before the recipient has a namespace, fences other participants' mail, and keeps the sender's retry", async () => {
	const test = await setup({}, false);
	const [sent] = await mcp(test.issued.descriptorPath, [send("before-issuance")]);
	expect(sent!.isError).toBe(false);
	const eventId = sent!.structuredContent.eventId;
	expect(test.readState().messaging[test.issued.namespaceId]!.operations).toEqual({ "before-issuance": eventId });
	const [wrongOwner] = await mcp(test.issued.descriptorPath, [receive(eventId)]);
	expect(wrongOwner!.isError).toBe(true);
	expect(wrongOwner!.content[0]!.text).toContain("not addressed to this namespace's participant");
	const recipient = await test.issue(test.recipientParticipant);
	const [late] = await mcp(recipient.descriptorPath, [receive(eventId)]);
	expect(late!.structuredContent.message).toMatchObject({ eventId, body: "Please inspect." });
	// A replacement client of the same holder inherits the namespace and reads the same participant's mail.
	Object.assign(test.recipient, await test.register("recipient"));
	const replacement = await test.issue(test.recipientParticipant);
	expect(replacement.namespaceId).toBe(recipient.namespaceId);
	const [inherited] = await mcp(replacement.descriptorPath, [received(eventId)]);
	expect(inherited!.structuredContent.readAt).toBe(1000);
	await test.client.call("participant.stand_down", { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey, participantKey: test.recipientParticipant.participantKey, expectedGeneration: test.recipientParticipant.generation });
	const [committedRetry, queued] = await mcp(test.issued.descriptorPath, [send("before-issuance"), send("recipient-stood-down")]);
	expect(committedRetry!.structuredContent.eventId).toBe(eventId);
	expect(queued!.isError).toBe(false);
	expect(Object.keys(test.readState().events)).toHaveLength(2);
	expect(test.readState().events[eventId]!.delivery.status).toBe("pending");
});

it("uses the default Runtime registrar, real registration and private issuance through the actual MCP child", async () => {
	const test = await setup();
	const sessionFile = test.inputs.get("sender")!.piSessionFile;
	writeFileSync(sessionFile, readFileSync(sessionFile, "utf8") + JSON.stringify({ type: "custom", id: "b00c0001", parentId: null, timestamp: new Date().toISOString(), customType: "deevs.hosted-runtime.v2", data: { version: 2, participant: { protocol: "proof", participantId: "sender", participantKey: test.senderParticipant.participantKey, generation: test.senderParticipant.generation, disposition: "held" } } }) + "\n");
	expect(readFileSync(sessionFile, "utf8")).toContain('"customType":"deevs.hosted-runtime.v2"');
	expect(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!).id).toBe("sender");
	const recipient = await test.issue(test.recipientParticipant);
	const pi = await piSession(test, ["--tools", "collaborator_peers,collaborator_send,collaborator_status,collaborator_receive,collaborator_received,collaborator_reply"], true);
	const peers = await pi.call({ name: "collaborator_peers", arguments: {} });
	expect(peers.isError, JSON.stringify({ content: peers.result.content, errors: pi.frames.filter(frame => frame.type === "extension_error") })).toBe(false);
	const namespaceId = peers.result.details.namespaceId as string;
	// One namespace per held participant generation: a replacement client of the same holder inherits it.
	expect(namespaceId).toBe(test.issued.namespaceId);
	const grant = test.readState().messaging[namespaceId]!;
	expect(grant.participantKey).toBe(test.senderParticipant.participantKey);
	expect(grant.holderGeneration).toBe(test.senderParticipant.generation);
	const args = { ...send("default-runtime").arguments, namespaceId };
	const sent = await pi.call({ name: "collaborator_send", arguments: args });
	expect(sent.isError).toBe(false);
	const lookup = await pi.call({ name: "collaborator_status", arguments: { namespaceId, operationId: "default-runtime" } });
	expect(lookup.result.details.event.eventId).toBe(sent.result.details.eventId);
	const oldArguments = await pi.call({ name: "collaborator_send", arguments: { messages: [] } } as never);
	expect(oldArguments.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(1);
	const [incoming] = await mcp(recipient.descriptorPath, [{ name: "collaborator_send", arguments: { participantId: "sender", operationId: "headless-incoming", body: "No synthetic empty-editor authority." } }]);
	expect(incoming!.isError).toBe(false);
	await new Promise(resolve => setTimeout(resolve, 2500));
	// RPC mode has no authoritative empty editor, so its heartbeat hint is never delivered.
	expect(test.readState().events[incoming!.structuredContent.eventId]).toMatchObject({ type: "mailbox.message" });
	expect(test.readState().events[incoming!.structuredContent.eventId]).not.toHaveProperty("readAt");
	await pi.close();
	const transcript = readFileSync(sessionFile, "utf8");
	expect(transcript).not.toContain("deevs.hosted-runtime.messaging-mail.v1");
	const descriptor = JSON.parse(readFileSync(messagingDescriptorPath(test.runtimeRoot, grant.targetKey), "utf8"));
	expect(transcript).not.toContain(descriptor.secret);
	expect(transcript).toContain('"toolName":"collaborator_send"');
}, 30_000);

it("persists native Pi receive results while keeping read receipts separate from native admission", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [incoming] = await mcp(recipient.descriptorPath, [{ name: "collaborator_send", arguments: { participantId: "sender", operationId: "incoming", body: "\u0000".repeat(16384) } }]);
	const eventId = incoming!.structuredContent.eventId;
	const allTools = "collaborator_peers,collaborator_send,collaborator_status,collaborator_receive,collaborator_received,collaborator_reply";
	const pi = await piSession(test, ["--tools", allTools]);
	const fetched = await pi.call({ ...receive(eventId), arguments: { namespaceId: test.issued.namespaceId, eventId } });
	expect(fetched.isError).toBe(false);
	expect(fetched.result.details.message.body).toBe("\u0000".repeat(16384));
	const acknowledged = await pi.call({ name: "collaborator_received", arguments: { namespaceId: test.issued.namespaceId, eventId } });
	expect(acknowledged.isError).toBe(false);
	const replied = await pi.call({ name: "collaborator_reply", arguments: { namespaceId: test.issued.namespaceId, ...reply(eventId).arguments } });
	expect(replied.isError).toBe(false);
	await pi.close();
	const transcript = readFileSync(test.inputs.get("sender")!.piSessionFile, "utf8");
	const persisted = transcript.trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.message?.role === "toolResult" && entry.message.toolName === "collaborator_receive");
	expect(persisted.message.details).toEqual(fetched.result.details);
	expect(persisted.message.isError).toBe(false);
	expect(test.readState().events[eventId]!.delivery.status).toBe("pending");
	expect(transcript).not.toContain(test.descriptor.secret);
	const restarted = await piSession(test, ["--tools", allTools]);
	const recovered = await restarted.call({ ...receive(eventId), arguments: { namespaceId: test.issued.namespaceId, eventId } });
	expect(recovered.isError).toBe(false);
	expect(recovered.result.details.message.readAt).toBe(1000);
}, 30_000);

it("rejects actual Monitor events through MCP while preserving the shared native claim", async () => {
	const events = new EventEmitter();
	const test = await setup({ scanIntervalMs: 10, now: () => 1000, onEvents: () => events.emit("ready") });
	const recipient = await test.issue(test.recipientParticipant);
	const directory = join(test.inputs.get("recipient")!.projectRoot, "watched");
	mkdirSync(directory);
	const auth = { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey };
	await test.client.call("monitor.create", { ...auth, directory, settleMs: 0 });
	const ready = once(events, "ready");
	writeFileSync(join(directory, "new.txt"), "monitor");
	await ready;
	const monitor = Object.values(test.readState().events).find(event => event.type === "filesystem.created")!;
	expect(monitor).toBeDefined();
	const [sent] = await mcp(test.issued.descriptorPath, [send("alongside-monitor")]);
	const eventId = sent!.structuredContent.eventId;
	const [denied, offered] = await mcp(recipient.descriptorPath, [receive(monitor.eventId), receive(eventId)]);
	expect(denied!.isError).toBe(true);
	expect(offered!.isError).toBe(false);
	const claim = await test.client.call("inbox.claim", { ...auth, maxEvents: 12 }) as { events: Array<{ eventId: string }> };
	expect(claim.events.map(event => event.eventId)).toEqual([monitor.eventId]);
	await mcp(recipient.descriptorPath, [received(eventId)]);
	expect(test.readState().events[monitor.eventId]!.delivery.status).toBe("claimed");
	expect(test.readState().events[eventId]!.delivery.status).toBe("pending");
});

it("does not record a read receipt or half a reply on pre-rename storage failure", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [sent] = await mcp(test.issued.descriptorPath, [send("write-fault")]);
	const eventId = sent!.structuredContent.eventId;
	const file = runtimeStatePaths(test.runtimeRoot).state;
	const failWrite = async (call: Call) => {
		renameSync(file, `${file}.saved`);
		mkdirSync(file);
		try { const [result] = await mcp(recipient.descriptorPath, [call]); expect(result!.isError).toBe(true); }
		finally { rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file); }
	};
	await failWrite(received(eventId));
	expect(test.readState().events[eventId]).not.toHaveProperty("readAt");
	await failWrite(reply(eventId));
	const state = test.readState();
	expect(state.events[eventId]).not.toHaveProperty("readAt");
	expect(state.messaging[recipient.namespaceId]!.operations).toEqual({});
	expect(Object.keys(state.events)).toEqual([eventId]);
	const [retry] = await mcp(recipient.descriptorPath, [reply(eventId)]);
	expect(retry!.isError).toBe(false);
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
	expect(Object.keys(test.readState().events)).toHaveLength(2);
});

it("retains a published body until its sender retry authority expires, then prunes it", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	test.setNow(1100);
	const [sent] = await mcp(test.issued.descriptorPath, [send("retry-protection")]);
	const eventId = sent!.structuredContent.eventId;
	const state = test.readState();
	const receiver = state.messaging[recipient.namespaceId]!;
	const publisher = state.messaging[test.issued.namespaceId]!;
	publisher.createdAt += 100;
	publisher.expiresAt += 100;
	const root = mkdtempSync(join(tmpdir(), "messaging-retention-"));
	cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
	writeHostedRuntimeState(root, state);
	const store = new HostedStateStore(root);
	store.apply({ type: "retention.prune", before: receiver.expiresAt + 1 });
	expect(store.read().messaging[receiver.namespaceId]!.status).toBe("expired");
	expect(store.read().events[eventId]!.delivery).toEqual({ status: "pending" });
	expect(Object.values(store.read().dedupe)).toContain(eventId);
	expect(store.read().claims).toEqual({});
	expect(readHostedRuntimeState(root)).toEqual(store.read());
	const retained = store.read();
	expect(store.apply({ type: "messaging.send", namespaceId: test.issued.namespaceId, operationId: "retry-protection", recipientParticipantKey: test.recipientParticipant.participantKey, body: "Please inspect.", eventId: "must-not-publish", at: receiver.expiresAt + 1 })).toBe(retained);
	store.apply({ type: "retention.prune", before: publisher.expiresAt + 1 });
	expect(store.read().events[eventId]).toBeUndefined();
	expect(Object.values(store.read().dedupe)).not.toContain(eventId);
	expect(readHostedRuntimeState(root)).toEqual(store.read());
});

it("refuses new operations at the record cap and retains ordinary bodies until terminal expiry without native ACK", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [first] = await mcp(test.issued.descriptorPath, [send("capacity-1")]);
	const eventId = first!.structuredContent.eventId;
	const state = test.readState();
	expect(state.claims).toEqual({});
	const publisher = state.messaging[test.issued.namespaceId]!;
	const grant = state.messaging[recipient.namespaceId]!;
	for (let i = Object.keys(state.messaging).length + 1; i < 10_000; i++) {
		const namespaceId = `msg_00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
		state.messaging[namespaceId] = { ...grant, namespaceId, status: "expired", operations: {} };
	}
	// A separate store exercises capacity/retention without introducing a second writer to the live Runtime.
	const root = mkdtempSync(join(tmpdir(), "messaging-capacity-"));
	cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
	writeHostedRuntimeState(root, state);
	const store = new HostedStateStore(root);
	const retry = { type: "messaging.send" as const, namespaceId: publisher.namespaceId, operationId: "capacity-1", recipientParticipantKey: test.recipientParticipant.participantKey, body: "Please inspect.", eventId: "evt_ignored", at: 1000 };
	expect(store.apply(retry)).toBe(store.read());
	expect(() => store.apply({ ...retry, operationId: "at-capacity", eventId: "evt_at_capacity" })).toThrow("exceed capacity");
	expect(Object.keys(store.read().messaging[publisher.namespaceId]!.operations)).toEqual(["capacity-1"]);
	store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventId, at: 1000 });
	expect(store.read().events[eventId]).toMatchObject({ readAt: 1000 });
	store.apply({ type: "retention.prune", before: 1001 });
	expect(store.read().events[eventId]).toBeDefined();
	store.apply({ type: "retention.prune", before: publisher.expiresAt + 1 });
	expect(store.read().events[eventId]).toBeUndefined();
	expect(store.read().messaging[publisher.namespaceId]!.operations).toEqual({});
	expect(() => store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventId, at: 1000 })).toThrow("expired");
});

it("publishes and retrieves only through MCP, rejects native claiming, and recovers the exact event after Runtime and MCP restart", async () => {
	const test = await setup();
	const [peers, sent, firstStatus] = await mcp(test.issued.descriptorPath, [{ name: "collaborator_peers", arguments: {} }, send("op-1"), status("op-1")]);
	expect(peers!.structuredContent.peers).toEqual([{ participantId: "recipient", state: "held", holderLive: true }]);
	expect(sent!.isError).toBe(false);
	const eventId = sent!.structuredContent.eventId;
	expect(firstStatus!.structuredContent.event?.delivery.status).toBe("pending");
	const auth = { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey };
	await expect(test.client.call("inbox.claim", { ...auth, maxEvents: 1 })).rejects.toMatchObject({ code: "not_found" });
	await expect(test.client.call("inbox.ack", { ...auth, claimId: "forged_native_claim", eventIds: [eventId] })).rejects.toMatchObject({ code: "not_found" });
	const recipient = await test.issue(test.recipientParticipant);
	const [offered] = await mcp(recipient.descriptorPath, [receive(eventId)]);
	expect(offered!.structuredContent.message).toMatchObject({ eventId, body: "Please inspect." });
	await mcp(recipient.descriptorPath, [received(eventId)]);
	expect(test.readState().claims).toEqual({});
	await test.restart();
	const [retry, recovered] = await mcp(test.issued.descriptorPath, [send("op-1"), status("op-1")]);
	expect(retry!.structuredContent.eventId).toBe(eventId);
	expect(recovered!.structuredContent.event).toMatchObject({ eventId, readAt: 1000, delivery: { status: "pending" } });
	expect(Object.keys(test.readState().events)).toEqual([eventId]);
	expect(statSync(test.issued.descriptorPath).mode & 0o777).toBe(0o600);
	expect(readFileSync(runtimeStatePaths(test.runtimeRoot).state, "utf8")).not.toContain(test.descriptor.secret);
});

it("recovers publication, read receipt and reply when committed Runtime responses are dropped", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
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
		expect(recovered!.structuredContent.eventId).toBe(committed[0]!.eventId);
		expect(Object.keys(test.readState().events)).toHaveLength(1);
		const receiverDescriptor = join(test.runtimeRoot, "drop-receive.json");
		writeFileSync(receiverDescriptor, JSON.stringify({ ...JSON.parse(readFileSync(recipient.descriptorPath, "utf8")), socketPath: proxyPath }), { mode: 0o600 });
		const eventId = committed[0]!.eventId;
		const [lostRead] = await mcp(receiverDescriptor, [received(eventId)]);
		expect(lostRead!.isError).toBe(true);
		expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
		const [lostReply] = await mcp(receiverDescriptor, [reply(eventId)]);
		expect(lostReply!.isError).toBe(true);
		const replyEventId = test.readState().messaging[recipient.namespaceId]!.operations["reply-1"]!;
		expect(test.readState().events[replyEventId]).toMatchObject({ type: "mailbox.message", inReplyToEventId: eventId });
		const [recoveredReply] = await mcp(recipient.descriptorPath, [reply(eventId)]);
		expect(recoveredReply!.structuredContent.eventId).toBe(replyEventId);
		expect(Object.keys(test.readState().events)).toHaveLength(2);
	} finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

it("transports the real maximum escaped event, recovers an ended-recipient retry, and rejects changed retries", async () => {
	const test = await setup();
	const body = "\u0000".repeat(16 * 1024);
	const [sent, seen] = await mcp(test.issued.descriptorPath, [send("escaped", body), status("escaped")]);
	expect(seen!.isError).toBe(false);
	expect(seen!.structuredContent.event?.body).toBe(body);
	expect(JSON.parse(seen!.content[0]!.text)).toEqual(seen!.structuredContent);
	await expect(test.client.call("messaging.status", { ...test.descriptor, operationId: "escaped" })).rejects.toMatchObject({ code: "invalid_response" });
	await test.client.call("participant.release", { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey, participantKey: test.recipientParticipant.participantKey });
	const [retry, conflict, fresh] = await mcp(test.issued.descriptorPath, [send("escaped", body), send("escaped", "changed"), send("new")]);
	expect(retry!.structuredContent.eventId).toBe(sent!.structuredContent.eventId);
	expect(conflict!.isError).toBe(true);
	expect(fresh!.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(1);
});

it("never grants lifecycle authority to the messaging secret and fences a cross-wired namespace", async () => {
	const test = await setup();
	const forbidden: Array<[string, Record<string, unknown>]> = [
		["pi.heartbeat", {}],
		["inbox.claim", { maxEvents: 1 }],
		["participant.acquire", { protocol: "proof", participantId: "forged" }],
		["participant.stop_confirmed", { participantKey: test.recipientParticipant.participantKey, expectedGeneration: test.recipientParticipant.generation, confirmed: true }],
		["worktree.remove", { callerParticipantKey: test.senderParticipant.participantKey, expectedCallerGeneration: test.senderParticipant.generation, protocol: "proof", participantId: "recipient", discardConfirmed: true }],
	];
	for (const [method, params] of forbidden) {
		await expect(test.client.call(method, { ...params, registrationId: test.descriptor.namespaceId, registrationKey: test.descriptor.secret })).rejects.toMatchObject({ code: "registration_stale" });
	}
	await expect(test.client.call("messaging.peers", { ...test.descriptor, secret: test.sender.registrationKey })).rejects.toMatchObject({ code: "registration_stale" });
	await expect(test.client.call("messaging.send", { ...test.descriptor, operationId: "forged", participantId: "recipient", bodyBase64: Buffer.from("forged").toString("base64"), senderParticipantKey: test.recipientParticipant.participantKey })).rejects.toMatchObject({ code: "invalid_request" });
	const [wrongNamespace] = await mcp(test.issued.descriptorPath, [{ ...send("cross-wired"), arguments: { ...send("cross-wired").arguments, namespaceId: "msg_00000000-0000-0000-0000-000000000000" } }]);
	expect(wrongNamespace!.isError).toBe(true);
	Object.assign(test.sender, await test.register("sender"));
	const [reconnected] = await mcp(test.issued.descriptorPath, [send("after-reconnect")]);
	expect(reconnected!.isError).toBe(false);
	await test.client.call("participant.stand_down", { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey, participantKey: test.senderParticipant.participantKey, expectedGeneration: test.senderParticipant.generation });
	const [denied] = await mcp(test.issued.descriptorPath, [send("after-stand-down")]);
	expect(denied!.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(1);
});

it("rejects publication once its holder has stood down", async () => {
	const test = await setup();
	await test.client.call("participant.stand_down", { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey, participantKey: test.senderParticipant.participantKey, expectedGeneration: test.senderParticipant.generation });
	const [result] = await mcp(test.issued.descriptorPath, [send("raced")]);
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
	expect(test.readState().messaging[test.issued.namespaceId]?.operations).toEqual({});
	const [retry] = await mcp(test.issued.descriptorPath, [send("failed-commit")]);
	expect(retry!.isError).toBe(false);
});

it("preserves an issued descriptor after an uncertain state commit", async () => {
	const test = await setup({}, false);
	const descriptorPath = messagingDescriptorPath(test.runtimeRoot, test.recipient.targetKey);
	const originalSync = fs.fsyncSync;
	let injected = 0;
	const fault = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
		if (fs.fstatSync(fd).isDirectory() && fs.existsSync(descriptorPath)) {
			injected++;
			throw Object.assign(new Error("Injected issuance directory-sync failure"), { code: "EIO" });
		}
		originalSync(fd);
	});
	syncBuiltinESMExports();
	try {
		await expect(test.issue(test.recipientParticipant)).rejects.toMatchObject({ code: "storage_error" });
		expect(injected).toBe(1);
	} finally { fault.mockRestore(); syncBuiltinESMExports(); }
	expect(fs.existsSync(descriptorPath)).toBe(true);
	const descriptor = readFileSync(descriptorPath, "utf8");
	const grants = Object.values(test.readState().messaging).filter(grant => grant.participantKey === test.recipientParticipant.participantKey);
	expect(grants).toHaveLength(1);
	await expect(test.issue(test.recipientParticipant)).rejects.toMatchObject({ code: "storage_error" });
	await test.restart();
	const recovered = await test.issue(test.recipientParticipant);
	expect(recovered.namespaceId).toBe(grants[0]!.namespaceId);
	expect(recovered.descriptorPath).toBe(descriptorPath);
	expect(readFileSync(descriptorPath, "utf8") === descriptor).toBe(true);
	const [peers] = await mcp(descriptorPath, [{ name: "collaborator_peers", arguments: {} }]);
	expect(peers!.isError).toBe(false);
	expect(Object.keys(test.readState().messaging)).toHaveLength(2);
});

it("removes an uncommitted descriptor after a definite issuance failure", async () => {
	const test = await setup({}, false);
	const descriptorPath = messagingDescriptorPath(test.runtimeRoot, test.recipient.targetKey);
	const statePath = runtimeStatePaths(test.runtimeRoot).state;
	const originalRename = fs.renameSync;
	let injected = 0;
	const fault = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
		if (destination === statePath && fs.existsSync(descriptorPath)) {
			injected++;
			throw Object.assign(new Error("Injected issuance pre-rename failure"), { code: "EIO" });
		}
		originalRename(source, destination);
	});
	syncBuiltinESMExports();
	try {
		await expect(test.issue(test.recipientParticipant)).rejects.toMatchObject({ code: "storage_error" });
		expect(injected).toBe(1);
	} finally { fault.mockRestore(); syncBuiltinESMExports(); }
	expect(fs.existsSync(descriptorPath)).toBe(false);
	expect(Object.keys(test.readState().messaging)).toHaveLength(1);
	const issued = await test.issue(test.recipientParticipant);
	const [peers] = await mcp(issued.descriptorPath, [{ name: "collaborator_peers", arguments: {} }]);
	expect(peers!.isError).toBe(false);
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
	const publishedId = persisted.messaging[test.issued.namespaceId]!.operations.uncertain!;
	expect((await monitorFailure)[0]).toMatchObject({ code: "storage_error", uncertain: true });
	expect(Object.keys(persisted.events)).toEqual([publishedId]);
	const [retry, other, lookup] = await mcp(test.issued.descriptorPath, [send("uncertain"), send("must-not-overwrite"), status("uncertain")]);
	for (const result of [retry, other, lookup]) {
		expect(result!.isError).toBe(true);
		expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ code: "storage_error" });
	}
	expect(readFileSync(file, "utf8")).toBe(snapshot);
	await test.restart();
	const [recovered] = await mcp(test.issued.descriptorPath, [send("uncertain")]);
	expect(recovered!.isError).toBe(false);
	expect(recovered!.structuredContent.eventId).toBe(publishedId);
	expect(test.readState().messaging[test.issued.namespaceId]!.operations.uncertain).toBe(publishedId);
	expect(Object.keys(test.readState().events)).toEqual([publishedId]);
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

it("negotiates actual MCP before descriptor issuance, transports escaped results, and settles cancellation", async () => {
	const test = await setup();
	const future = `${test.issued.descriptorPath}.future`;
	const client = new MessagingMcpClient(future);
	cleanups.push(() => client.close());
	await client.initialize();
	expect((await client.callTool("collaborator_peers", {})).isError).toBe(true);
	writeFileSync(future, readFileSync(test.issued.descriptorPath), { mode: 0o600 });
	const args: Record<string, string> = { ...send("client-escaped", "\u0000".repeat(16384)).arguments, namespaceId: test.issued.namespaceId };
	expect((await client.callTool("collaborator_send", args)).isError).toBe(false);
	const result = await client.callTool("collaborator_status", { namespaceId: test.issued.namespaceId, operationId: args.operationId });
	expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
	expect((result.structuredContent as Result["structuredContent"]).event?.body).toBe(args.body);
	const abort = new AbortController();
	const cancelledArgs = { ...args, operationId: "cancelled-send" };
	const pending = client.callTool("collaborator_send", cancelledArgs, abort.signal);
	const rejected = expect(pending).rejects.toThrow("MCP transport stopped");
	abort.abort();
	await rejected;
	await client.close();
	expect(client.closed).toBe(true);
	const replacement = new MessagingMcpClient(future);
	cleanups.push(() => replacement.close());
	await replacement.initialize();
	const recovered = await replacement.callTool("collaborator_send", cancelledArgs);
	const committed = await replacement.callTool("collaborator_status", { namespaceId: test.issued.namespaceId, operationId: cancelledArgs.operationId });
	expect(committed.isError).toBe(false);
	expect(recovered.structuredContent?.eventId).toBe((committed.structuredContent as Result["structuredContent"]).event?.eventId);
	expect(Object.keys(test.readState().events)).toHaveLength(2);
});

it("runs real Pi tool calls over MCP, preserves errors and full results, and recovers after Pi restart", async () => {
	const test = await setup();
	const pi = await piSession(test);
	const peers = await pi.call({ name: "collaborator_peers", arguments: {} });
	expect(peers.isError).toBe(false);
	expect(peers.result.details.binding).toEqual({ kind: "pi", sessionId: "sender", sessionFile: test.inputs.get("sender")!.piSessionFile, cwd: test.inputs.get("sender")!.projectRoot });
	const args: Record<string, string> = { ...send("pi-wire", "\u0000".repeat(16384)).arguments, namespaceId: test.issued.namespaceId };
	const sent = await pi.call({ name: "collaborator_send", arguments: args });
	expect(sent.isError).toBe(false);
	const seen = await pi.call({ name: "collaborator_status", arguments: { namespaceId: test.issued.namespaceId, operationId: args.operationId } });
	expect(seen.isError).toBe(false);
	expect(seen.result.details.event.body).toBe(args.body);
	const conflict = await pi.call({ name: "collaborator_send", arguments: { ...args, body: "changed" } });
	expect(conflict.isError).toBe(true);
	expect(JSON.parse(conflict.result.content[0].text).code).toBe("conflict");
	const end = pi.frames.filter(frame => frame.type === "message_end" && frame.message.role === "assistant").at(-1);
	expect(JSON.parse(end.message.content[0].text)).toEqual({ tools: ["collaborator_peers", "collaborator_send", "collaborator_status"], sharedSkill: true });
	await pi.close();
	const transcript = readFileSync(test.inputs.get("sender")!.piSessionFile, "utf8");
	expect(transcript).not.toContain(test.descriptor.secret);
	const persisted = transcript.trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.message?.role === "toolResult");
	expect(persisted.map(entry => entry.message.isError)).toEqual([false, false, false, true]);
	expect(persisted[2].message.details.event.body).toBe(args.body);
	const restarted = await piSession(test);
	const retry = await restarted.call({ name: "collaborator_send", arguments: args });
	expect(retry.isError).toBe(false);
	expect(retry.result.details.eventId).toBe(sent.result.details.eventId);
	expect(Object.keys(test.readState().events)).toEqual([sent.result.details.eventId]);
}, 30_000);

it("blocks a new Pi session using an old descriptor and respects an explicit tool allowlist", async () => {
	const test = await setup();
	const pi = await piSession(test);
	await pi.command({ type: "new_session" });
	const denied = await pi.call({ name: "collaborator_send", arguments: { ...send("wrong-session").arguments, namespaceId: test.issued.namespaceId } });
	expect(denied.isError).toBe(true);
	expect(denied.result.content[0].text).toContain("does not belong to this exact Pi session");
	expect(Object.keys(test.readState().events)).toHaveLength(0);
	await pi.close();
	const limited = await piSession(test, ["--tools", "collaborator_peers"]);
	const absent = await limited.call({ name: "collaborator_send", arguments: { ...send("disallowed").arguments, namespaceId: test.issued.namespaceId } });
	expect(absent.isError).toBe(true);
	expect(absent.result.content[0].text).toContain("not found");
	await limited.command({ type: "prompt", message: "/proof-add-command" });
	const peers = await limited.call({ name: "collaborator_peers", arguments: {} });
	expect(peers.isError).toBe(false);
	expect(Object.keys(test.readState().events)).toHaveLength(0);
}, 30_000);
