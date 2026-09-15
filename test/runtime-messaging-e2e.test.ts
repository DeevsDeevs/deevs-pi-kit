import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs, { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import { MessagingMcpClient } from "../extensions/runtime/mcp/client.ts";
import { messagingDescriptorPath } from "../extensions/runtime/service/messaging.ts";
import { HOSTED_ACK_RETENTION_MS } from "../extensions/runtime/schemas/common.ts";
import type { HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import type { RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";
import { HostedStateStorageError, HostedStateStore, readHostedRuntimeState, runtimeStatePaths, writeHostedRuntimeState } from "../extensions/runtime/service/state.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Auth = { registrationId: string; registrationKey: string; targetKey: string };
type Participant = { participantKey: string; generation: string };
type Call = { name: string; arguments: Record<string, string> };
type Message = { eventId: string; from: string; body: string };
type Result = { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: { eventId?: string; me?: string; binding?: { kind: string; sessionId: string; sessionFile: string; cwd: string }; peers?: Array<{ participantId: string; live: boolean }>; messages?: Message[]; truncated?: boolean } };

async function setup(recipientReady = true) {
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
		inputs.set(name, { projectRoot: cwd, piSessionId: name, piSessionFile: file });
	}
	// Only Herdr identity is a fixture. MCP is a real child; RPC, authorization,
	// publication, authorization and restart recovery use the actual service/store.
	const options = { root: runtimeRoot, host: { async getAgent(name: string) { return agents.get(name)!; } }, registration: { now: () => now }, participant: { now: () => now } };
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

/** The descriptor a failed issuance may have staged, before it is renamed over the live one. */
function pendingDescriptor(descriptorPath: string): boolean {
	const directory = dirname(descriptorPath);
	const prefix = `${basename(descriptorPath)}.`;
	return fs.readdirSync(directory).some(entry => entry.startsWith(prefix));
}

async function mcp(path: string, calls: Call[]): Promise<Result[]> {
	const child = spawn(process.execPath, [resolve("extensions/runtime/mcp/main.mjs"), path], { stdio: ["pipe", "pipe", "pipe"] });
	const completed = once(child, "close");
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
	const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		const requests = [{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "tools/list" }, ...calls.map((call, i) => ({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: call }))];
		child.stdin.end(requests.map(r => JSON.stringify(r)).join("\n") + "\n");
		const [code] = await completed;
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const frames = stdout.trim().split("\n");
		for (const line of frames) expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(256 * 1024);
		const responses = frames.map(line => JSON.parse(line));
		expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["collaborator_peers", "collaborator_inbox", "collaborator_send", "collaborator_reply"]);
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
	const child = spawn(binary ?? process.execPath, [...(binary ? [] : [resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js")]), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "collaborator_peers,collaborator_inbox,collaborator_send,collaborator_reply", "-e", resolve(defaultRuntime ? "extensions/runtime/index.ts" : "test/fixtures/mcp-pi-adapter.ts"), "-e", resolve("test/fixtures/mcp-pi-provider.ts"), "--provider", "mcp-proof", "--model", "proof", "--session", test.inputs.get("sender")!.piSessionFile, ...(defaultRuntime ? [] : ["--runtime-mcp-descriptor", test.issued.descriptorPath]), ...extraArgs], { cwd: test.inputs.get("sender")!.projectRoot, env, stdio: "pipe" });
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

const peers = (): Call => ({ name: "collaborator_peers", arguments: {} });
const inbox = (): Call => ({ name: "collaborator_inbox", arguments: {} });
const send = (body = "Please inspect.", participantId = "recipient"): Call => ({ name: "collaborator_send", arguments: { participantId, body } });
const reply = (eventId: string, body = "Reply."): Call => ({ name: "collaborator_reply", arguments: { eventId, body } });

it("lists the recipient's unread mail with bodies, oldest first, and caps the listing at 50", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const published = await mcp(test.issued.descriptorPath, [send("first"), send("second")]);
	// Both land at the same frozen clock, so the listing order falls back to the event ID.
	const expected = published
		.map((result, index) => ({ eventId: result.structuredContent.eventId!, from: "sender", body: index === 0 ? "first" : "second" }))
		.sort((left, right) => left.eventId.localeCompare(right.eventId));
	const [listed] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(listed!.structuredContent).toEqual({ messages: expected, truncated: false });
	// The sender's own inbox is separate: it lists nothing until a reply arrives.
	await expect(mcp(test.issued.descriptorPath, [inbox()])).resolves.toMatchObject([{ structuredContent: { messages: [] } }]);
	await mcp(test.issued.descriptorPath, Array.from({ length: 51 }, (_unused, index) => send(`bulk ${index}`)));
	const [full] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(full!.structuredContent.messages).toHaveLength(50);
	expect(full!.structuredContent.truncated).toBe(true);
	const [rest] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(rest!.structuredContent.messages).toHaveLength(1);
	expect(rest!.structuredContent.truncated).toBe(false);
});

it("pages a heavy inbox by bytes so no marked-read page can exceed the response cap", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const body = "x".repeat(16 * 1024);
	// 51 maximal bodies: a 50-message page would be ~800 KiB against a 128 KiB response cap.
	await mcp(test.issued.descriptorPath, Array.from({ length: 51 }, () => send(body)));
	const delivered: string[] = [];
	for (let pages = 0; pages < 20 && delivered.length < 51; pages += 1) {
		const [page] = await mcp(recipient.descriptorPath, [inbox()]);
		expect(page!.isError).toBe(false);
		expect(page!.structuredContent.messages!.length).toBeGreaterThan(0);
		expect(page!.structuredContent.truncated).toBe(delivered.length + page!.structuredContent.messages!.length < 51);
		delivered.push(...page!.structuredContent.messages!.map(message => message.eventId));
	}
	expect(new Set(delivered).size).toBe(51);
	const [empty] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(empty!.structuredContent).toEqual({ messages: [], truncated: false });
});

it("marks every returned message read, so a repeated inbox call returns nothing", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [sent] = await mcp(test.issued.descriptorPath, [send("read once")]);
	const eventId = sent!.structuredContent.eventId!;
	const [delivered, repeated] = await mcp(recipient.descriptorPath, [inbox(), inbox()]);
	expect(delivered!.structuredContent).toEqual({ messages: [{ eventId, from: "sender", body: "read once" }], truncated: false });
	expect(repeated!.structuredContent).toEqual({ messages: [], truncated: false });
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
});

it("publishes a distinct event for every send, because MCP mints a fresh operation each time", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [first, second] = await mcp(test.issued.descriptorPath, [send("twice"), send("twice")]);
	expect(first!.isError).toBe(false);
	expect(second!.structuredContent.eventId).not.toBe(first!.structuredContent.eventId);
	expect(Object.keys(test.readState().events)).toHaveLength(2);
	const [delivered] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(delivered!.structuredContent.messages!.map(message => message.body)).toEqual(["twice", "twice"]);
});

it("delivers a full body, records readAt, and correlates a reply", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const body = " ".repeat(16384);
	const [sent] = await mcp(test.issued.descriptorPath, [send(body)]);
	const eventId = sent!.structuredContent.eventId!;
	const [delivered] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(delivered!.isError).toBe(false);
	expect(delivered!.structuredContent.messages).toEqual([{ eventId, from: "sender", body }]);
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
	const [replied] = await mcp(recipient.descriptorPath, [reply(eventId)]);
	expect(replied!.isError).toBe(false);
	const replyEventId = replied!.structuredContent.eventId!;
	const [seen] = await mcp(test.issued.descriptorPath, [inbox()]);
	expect(seen!.structuredContent.messages).toEqual([{ eventId: replyEventId, from: "recipient", body: "Reply." }]);
	expect(test.readState().events[replyEventId]).toMatchObject({ inReplyToEventId: eventId });
	expect(Object.keys(test.readState().events)).toHaveLength(2);
});

it("hints the oldest unread message on the recipient heartbeat and stops once the inbox returns it", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const auth = { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey };
	await expect(test.client.call("pi.heartbeat", auth)).resolves.not.toHaveProperty("mail");
	const published = await mcp(test.issued.descriptorPath, [send("hint one"), send("hint two")]);
	// Both land at the same frozen clock, so the hint order falls back to the event ID.
	const [eventId] = published.map(result => result.structuredContent.eventId!).sort();
	await expect(test.client.call("pi.heartbeat", auth)).resolves.toMatchObject({ mail: { namespaceId: recipient.namespaceId, eventId } });
	await mcp(recipient.descriptorPath, [inbox()]);
	await expect(test.client.call("pi.heartbeat", auth)).resolves.not.toHaveProperty("mail");
	const [later] = await mcp(test.issued.descriptorPath, [send("hint three")]);
	await expect(test.client.call("pi.heartbeat", auth)).resolves.toMatchObject({ mail: { eventId: later!.structuredContent.eventId } });
	await expect(test.client.call("pi.heartbeat", { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey })).resolves.not.toHaveProperty("mail");
});

it("publishes before the recipient has a namespace and fences another participant's mail", async () => {
	const test = await setup(false);
	const [sent] = await mcp(test.issued.descriptorPath, [send()]);
	expect(sent!.isError).toBe(false);
	const eventId = sent!.structuredContent.eventId!;
	expect(Object.values(test.readState().messaging[test.issued.namespaceId]!.operations)).toEqual([eventId]);
	const [wrongOwner] = await mcp(test.issued.descriptorPath, [reply(eventId)]);
	expect(wrongOwner!.isError).toBe(true);
	expect(wrongOwner!.content[0]!.text).toContain("not addressed to this namespace's participant");
	const recipient = await test.issue(test.recipientParticipant);
	// A replacement client of the same holder inherits the namespace and reads the same participant's mail.
	Object.assign(test.recipient, await test.register("recipient"));
	const replacement = await test.issue(test.recipientParticipant);
	expect(replacement.namespaceId).toBe(recipient.namespaceId);
	const [inherited] = await mcp(replacement.descriptorPath, [inbox()]);
	expect(inherited!.structuredContent.messages).toEqual([{ eventId, from: "sender", body: "Please inspect." }]);
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
	// A descriptor that no longer names the reusable grant holds an unrecoverable secret, so issuance mints a new one.
	const stale = JSON.parse(readFileSync(replacement.descriptorPath, "utf8")) as { namespaceId: string };
	writeFileSync(replacement.descriptorPath, `${JSON.stringify({ ...stale, namespaceId: "msg_00000000-0000-0000-0000-000000000000" })}\n`, { mode: 0o600 });
	const minted = await test.issue(test.recipientParticipant);
	expect(minted.namespaceId).not.toBe(replacement.namespaceId);
	expect(JSON.parse(readFileSync(minted.descriptorPath, "utf8")).namespaceId).toBe(minted.namespaceId);
	await test.client.call("participant.stand_down", { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey, participantKey: test.recipientParticipant.participantKey, expectedGeneration: test.recipientParticipant.generation });
	// A vacant recipient still owns its participant identity, so the mail queues instead of failing.
	const [queued] = await mcp(test.issued.descriptorPath, [send("recipient-stood-down")]);
	expect(queued!.isError).toBe(false);
	expect(Object.keys(test.readState().events)).toHaveLength(2);
	expect(test.readState().events[eventId]).toBeDefined();
});

it("uses the default Runtime registrar, real registration and private issuance through the actual MCP child", async () => {
	const test = await setup();
	const sessionFile = test.inputs.get("sender")!.piSessionFile;
	writeFileSync(sessionFile, readFileSync(sessionFile, "utf8") + JSON.stringify({ type: "custom", id: "b00c0001", parentId: null, timestamp: new Date().toISOString(), customType: "deevs.hosted-runtime.v3", data: { version: 3, participant: { protocol: "proof", participantId: "sender", participantKey: test.senderParticipant.participantKey, generation: test.senderParticipant.generation, disposition: "held" } } }) + "\n");
	expect(readFileSync(sessionFile, "utf8")).toContain('"customType":"deevs.hosted-runtime.v3"');
	expect(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!).id).toBe("sender");
	const recipient = await test.issue(test.recipientParticipant);
	const pi = await piSession(test, [], true);
	const listed = await pi.call(peers());
	expect(listed.isError, JSON.stringify({ content: listed.result.content, errors: pi.frames.filter(frame => frame.type === "extension_error") })).toBe(false);
	expect(listed.result.details).toEqual({ me: "sender", peers: [{ participantId: "recipient", live: true }] });
	// One namespace per held participant generation: a replacement client of the same holder inherits it.
	const grant = Object.values(test.readState().messaging).find(candidate => candidate.targetKey === test.sender.targetKey && candidate.status === "active")!;
	expect(grant.namespaceId).toBe(test.issued.namespaceId);
	expect(grant.participantKey).toBe(test.senderParticipant.participantKey);
	expect(grant.holderGeneration).toBe(test.senderParticipant.generation);
	const sent = await pi.call(send("default-runtime"));
	expect(sent.isError).toBe(false);
	expect(test.readState().events[sent.result.details.eventId]).toMatchObject({ body: "default-runtime" });
	const oldArguments = await pi.call({ name: "collaborator_send", arguments: { messages: [] } } as never);
	expect(oldArguments.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(1);
	const [incoming] = await mcp(recipient.descriptorPath, [send("Delivered into an idle RPC session.", "sender")]);
	expect(incoming!.isError).toBe(false);
	await new Promise(resolve => setTimeout(resolve, 2500));
	// An idle RPC session has no editor to guard, so its heartbeat delivers the body and marks the mail read.
	expect(test.readState().events[incoming!.structuredContent.eventId!]).toMatchObject({ type: "mailbox.message", readAt: 1000 });
	await pi.close();
	const transcript = readFileSync(sessionFile, "utf8");
	expect(transcript).toContain("deevs.hosted-runtime.messaging-mail.v1");
	expect(transcript).toContain("Delivered into an idle RPC session.");
	const descriptor = JSON.parse(readFileSync(messagingDescriptorPath(test.runtimeRoot, grant.targetKey), "utf8"));
	expect(transcript).not.toContain(descriptor.secret);
	expect(transcript).toContain('"toolName":"collaborator_send"');
}, 30_000);

it("persists native Pi inbox results and keeps delivered mail read across a Pi restart", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const body = " ".repeat(16384);
	const [incoming] = await mcp(recipient.descriptorPath, [send(body, "sender")]);
	const eventId = incoming!.structuredContent.eventId!;
	const pi = await piSession(test);
	const delivered = await pi.call(inbox());
	expect(delivered.isError).toBe(false);
	expect(delivered.result.details.messages).toEqual([{ eventId, from: "recipient", body }]);
	const replied = await pi.call(reply(eventId));
	expect(replied.isError).toBe(false);
	await pi.close();
	const transcript = readFileSync(test.inputs.get("sender")!.piSessionFile, "utf8");
	const persisted = transcript.trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.message?.role === "toolResult" && entry.message.toolName === "collaborator_inbox");
	expect(persisted.message.details).toEqual(delivered.result.details);
	expect(persisted.message.isError).toBe(false);
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
	expect(transcript).not.toContain(test.descriptor.secret);
	const restarted = await piSession(test);
	const recovered = await restarted.call(inbox());
	expect(recovered.isError).toBe(false);
	expect(recovered.result.details).toEqual({ messages: [], truncated: false });
}, 30_000);

it("does not record a read receipt or half a reply on pre-rename storage failure", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [sent] = await mcp(test.issued.descriptorPath, [send()]);
	const eventId = sent!.structuredContent.eventId!;
	const file = runtimeStatePaths(test.runtimeRoot).state;
	const failWrite = async (call: Call) => {
		renameSync(file, `${file}.saved`);
		mkdirSync(file);
		try { const [result] = await mcp(recipient.descriptorPath, [call]); expect(result!.isError).toBe(true); }
		finally { rmSync(file, { recursive: true }); renameSync(`${file}.saved`, file); }
	};
	await failWrite(inbox());
	expect(test.readState().events[eventId]).not.toHaveProperty("readAt");
	await failWrite(reply(eventId));
	const state = test.readState();
	expect(state.events[eventId]).not.toHaveProperty("readAt");
	expect(state.messaging[recipient.namespaceId]!.operations).toEqual({});
	expect(Object.keys(state.events)).toEqual([eventId]);
	const [delivered] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(delivered!.structuredContent.messages).toEqual([{ eventId, from: "sender", body: "Please inspect." }]);
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
	const [retry] = await mcp(recipient.descriptorPath, [reply(eventId)]);
	expect(retry!.isError).toBe(false);
	expect(Object.keys(test.readState().events)).toHaveLength(2);
});

it("retains a published body until its sender retry authority expires, then prunes it", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	test.setNow(1100);
	const [sent] = await mcp(test.issued.descriptorPath, [send()]);
	const eventId = sent!.structuredContent.eventId!;
	const state = test.readState();
	const receiver = state.messaging[recipient.namespaceId]!;
	const publisher = state.messaging[test.issued.namespaceId]!;
	const [operationId] = Object.keys(publisher.operations);
	publisher.createdAt += 100;
	publisher.expiresAt += 100;
	const root = mkdtempSync(join(tmpdir(), "messaging-retention-"));
	cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
	writeHostedRuntimeState(root, state);
	const store = new HostedStateStore(root);
	store.apply({ type: "retention.prune", before: receiver.expiresAt + 1 });
	expect(store.read().messaging[receiver.namespaceId]!.status).toBe("expired");
	expect(store.read().events[eventId]).toBeDefined();
	expect(Object.values(store.read().dedupe)).toContain(eventId);
	expect(readHostedRuntimeState(root)).toEqual(store.read());
	const retained = store.read();
	expect(store.apply({ type: "messaging.send", namespaceId: test.issued.namespaceId, operationId: operationId!, recipientParticipantKey: test.recipientParticipant.participantKey, body: "Please inspect.", eventId: "must-not-publish", at: receiver.expiresAt + 1 })).toBe(retained);
	store.apply({ type: "retention.prune", before: publisher.expiresAt + 1 });
	expect(store.read().events[eventId]).toBeUndefined();
	expect(Object.values(store.read().dedupe)).not.toContain(eventId);
	expect(readHostedRuntimeState(root)).toEqual(store.read());
});

it("refuses new operations at the record cap and retains ordinary bodies until terminal expiry without native ACK", async () => {
	const test = await setup();
	const recipient = await test.issue(test.recipientParticipant);
	const [first] = await mcp(test.issued.descriptorPath, [send()]);
	const eventId = first!.structuredContent.eventId!;
	const state = test.readState();
	const publisher = state.messaging[test.issued.namespaceId]!;
	const grant = state.messaging[recipient.namespaceId]!;
	const [operationId] = Object.keys(publisher.operations);
	for (let i = Object.keys(state.messaging).length + 1; i < 10_000; i++) {
		const namespaceId = `msg_00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
		state.messaging[namespaceId] = { ...grant, namespaceId, status: "expired", operations: {} };
	}
	// A separate store exercises capacity/retention without introducing a second writer to the live Runtime.
	const root = mkdtempSync(join(tmpdir(), "messaging-capacity-"));
	cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
	writeHostedRuntimeState(root, state);
	const store = new HostedStateStore(root);
	const retry = { type: "messaging.send" as const, namespaceId: publisher.namespaceId, operationId: operationId!, recipientParticipantKey: test.recipientParticipant.participantKey, body: "Please inspect.", eventId: "evt_ignored", at: 1000 };
	expect(store.apply(retry)).toBe(store.read());
	expect(() => store.apply({ ...retry, operationId: "at-capacity", eventId: "evt_at_capacity" })).toThrow("exceed capacity");
	expect(Object.keys(store.read().messaging[publisher.namespaceId]!.operations)).toEqual([operationId]);
	store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventIds: [eventId], at: 1000 });
	expect(store.read().events[eventId]).toMatchObject({ readAt: 1000 });
	store.apply({ type: "retention.prune", before: 1001 });
	expect(store.read().events[eventId]).toBeDefined();
	store.apply({ type: "retention.prune", before: publisher.expiresAt + 1 });
	expect(store.read().events[eventId]).toBeUndefined();
	expect(store.read().messaging[publisher.namespaceId]!.operations).toEqual({});
	expect(() => store.apply({ type: "messaging.read", namespaceId: grant.namespaceId, eventIds: [eventId], at: 1000 })).toThrow("expired");
});

it("publishes and reads only through MCP and keeps its namespace usable across a Runtime restart", async () => {
	const test = await setup();
	const [listed, sent] = await mcp(test.issued.descriptorPath, [peers(), send()]);
	expect(listed!.structuredContent).toEqual({
		me: "sender",
		binding: { kind: "pi", sessionId: "sender", sessionFile: test.inputs.get("sender")!.piSessionFile, cwd: test.inputs.get("sender")!.projectRoot },
		peers: [{ participantId: "recipient", live: true }],
	});
	expect(sent!.isError).toBe(false);
	const eventId = sent!.structuredContent.eventId!;
	expect(test.readState().events[eventId]).toBeDefined();
	const recipient = await test.issue(test.recipientParticipant);
	const [delivered] = await mcp(recipient.descriptorPath, [inbox()]);
	expect(delivered!.structuredContent.messages).toEqual([{ eventId, from: "sender", body: "Please inspect." }]);
	await test.restart();
	const [drained, again] = await mcp(recipient.descriptorPath, [inbox(), send("after restart", "sender")]);
	expect(drained!.structuredContent).toEqual({ messages: [], truncated: false });
	expect(again!.isError).toBe(false);
	expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
	expect(Object.keys(test.readState().events)).toHaveLength(2);
	expect(statSync(test.issued.descriptorPath).mode & 0o777).toBe(0o600);
	expect(readFileSync(runtimeStatePaths(test.runtimeRoot).state, "utf8")).not.toContain(test.descriptor.secret);
});

it("commits publication, read receipt and reply when committed Runtime responses are dropped", async () => {
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
		const [lost] = await mcp(descriptor, [send()]);
		expect(lost!.isError).toBe(true);
		const committed = Object.values(test.readState().events);
		expect(committed).toHaveLength(1);
		const eventId = committed[0]!.eventId;
		const receiverDescriptor = join(test.runtimeRoot, "drop-receive.json");
		writeFileSync(receiverDescriptor, JSON.stringify({ ...JSON.parse(readFileSync(recipient.descriptorPath, "utf8")), socketPath: proxyPath }), { mode: 0o600 });
		const [lostRead] = await mcp(receiverDescriptor, [inbox()]);
		expect(lostRead!.isError).toBe(true);
		expect(test.readState().events[eventId]).toMatchObject({ readAt: 1000 });
		const [lostReply] = await mcp(receiverDescriptor, [reply(eventId)]);
		expect(lostReply!.isError).toBe(true);
		const [replyEventId] = Object.values(test.readState().messaging[recipient.namespaceId]!.operations);
		expect(test.readState().events[replyEventId!]).toMatchObject({ type: "mailbox.message", inReplyToEventId: eventId });
		expect(Object.keys(test.readState().events)).toHaveLength(2);
	} finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

it("transports the real maximum escaped body, refuses the removed daemon methods, and rejects a send to a released recipient", async () => {
	const test = await setup();
	const body = " ".repeat(16 * 1024);
	const [sent] = await mcp(test.issued.descriptorPath, [send(body)]);
	expect(sent!.isError).toBe(false);
	expect(JSON.parse(sent!.content[0]!.text)).toEqual(sent!.structuredContent);
	const eventId = sent!.structuredContent.eventId!;
	for (const method of ["messaging.status", "messaging.receive", "messaging.received"]) {
		await expect(test.client.call(method, { ...test.descriptor, eventId })).rejects.toMatchObject({ code: "not_found" });
	}
	await expect(test.client.call("messaging.inbox", { ...test.descriptor, cursor: eventId })).rejects.toMatchObject({ code: "invalid_request" });
	await test.client.call("participant.release", { registrationId: test.recipient.registrationId, registrationKey: test.recipient.registrationKey, participantKey: test.recipientParticipant.participantKey });
	const [released] = await mcp(test.issued.descriptorPath, [send("after release")]);
	expect(released!.isError).toBe(true);
	expect(Object.keys(test.readState().events)).toHaveLength(1);
});

it("never grants lifecycle authority to the messaging secret and rejects unexpected tool arguments", async () => {
	const test = await setup();
	const forbidden: Array<[string, Record<string, unknown>]> = [
		["pi.heartbeat", {}],
		["participant.acquire", { protocol: "proof", participantId: "forged" }],
		["participant.stop_confirmed", { participantKey: test.recipientParticipant.participantKey, expectedGeneration: test.recipientParticipant.generation, confirmed: true }],
		["worktree.remove", { callerParticipantKey: test.senderParticipant.participantKey, expectedCallerGeneration: test.senderParticipant.generation, protocol: "proof", participantId: "recipient", discardConfirmed: true }],
	];
	for (const [method, params] of forbidden) {
		await expect(test.client.call(method, { ...params, registrationId: test.descriptor.namespaceId, registrationKey: test.descriptor.secret })).rejects.toMatchObject({ code: "registration_stale" });
	}
	await expect(test.client.call("messaging.peers", { ...test.descriptor, secret: test.sender.registrationKey })).rejects.toMatchObject({ code: "registration_stale" });
	await expect(test.client.call("messaging.send", { ...test.descriptor, operationId: "forged", participantId: "recipient", bodyBase64: Buffer.from("forged").toString("base64"), senderParticipantKey: test.recipientParticipant.participantKey })).rejects.toMatchObject({ code: "invalid_request" });
	const [unexpected] = await mcp(test.issued.descriptorPath, [{ name: "collaborator_send", arguments: { ...send().arguments, namespaceId: test.descriptor.namespaceId } }]);
	expect(unexpected!.isError).toBe(true);
	expect(unexpected!.content[0]!.text).toContain("Unexpected or missing tool arguments");
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
	const [stillAvailable] = await mcp(test.issued.descriptorPath, [peers()]);
	expect(stillAvailable!.isError).toBe(false);
	await test.restart();
	expect(Object.keys(test.readState().events)).toHaveLength(0);
	expect(test.readState().messaging[test.issued.namespaceId]?.operations).toEqual({});
	const [retry] = await mcp(test.issued.descriptorPath, [send("failed-commit")]);
	expect(retry!.isError).toBe(false);
});

it("preserves an issued descriptor after an uncertain state commit", async () => {
	const test = await setup(false);
	const descriptorPath = messagingDescriptorPath(test.runtimeRoot, test.recipient.targetKey);
	const originalSync = fs.fsyncSync;
	let injected = 0;
	const fault = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
		if (fs.fstatSync(fd).isDirectory() && pendingDescriptor(descriptorPath)) {
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
	const [listed] = await mcp(descriptorPath, [peers()]);
	expect(listed!.isError).toBe(false);
	expect(Object.keys(test.readState().messaging)).toHaveLength(2);
});

it("supersedes a target's previous namespace so one descriptor never serves two live grants", async () => {
	const test = await setup();
	const descriptorPath = messagingDescriptorPath(test.runtimeRoot, test.sender.targetKey);
	expect(test.issued.descriptorPath).toBe(descriptorPath);
	const auth = { registrationId: test.sender.registrationId, registrationKey: test.sender.registrationKey };
	await test.client.call("participant.release", { ...auth, participantKey: test.senderParticipant.participantKey });
	const acquired = await test.client.call("participant.acquire", { ...auth, protocol: "proof", participantId: "sender", revive: true });
	const reacquired = (acquired as { participant: Participant }).participant;
	expect(reacquired.generation).not.toBe(test.senderParticipant.generation);
	const reissued = await test.issue(reacquired);
	expect(reissued.namespaceId).not.toBe(test.issued.namespaceId);
	expect(reissued.descriptorPath).toBe(descriptorPath);
	expect(test.readState().messaging[test.issued.namespaceId]?.status).toBe("expired");
	expect(JSON.parse(readFileSync(descriptorPath, "utf8")).namespaceId).toBe(reissued.namespaceId);
	const [listed] = await mcp(descriptorPath, [peers()]);
	expect(listed!.isError).toBe(false);
});

it("removes an uncommitted descriptor after a definite issuance failure", async () => {
	const test = await setup(false);
	const descriptorPath = messagingDescriptorPath(test.runtimeRoot, test.recipient.targetKey);
	const statePath = runtimeStatePaths(test.runtimeRoot).state;
	const originalRename = fs.renameSync;
	let injected = 0;
	const fault = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
		if (destination === statePath && pendingDescriptor(descriptorPath)) {
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
	expect(pendingDescriptor(descriptorPath)).toBe(false);
	expect(Object.keys(test.readState().messaging)).toHaveLength(1);
	const issued = await test.issue(test.recipientParticipant);
	const [listed] = await mcp(issued.descriptorPath, [peers()]);
	expect(listed!.isError).toBe(false);
});

it("fences a post-rename directory-sync failure until restart, preserving the original publication", async () => {
	const test = await setup();
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
	const [publishedId] = Object.values(persisted.messaging[test.issued.namespaceId]!.operations);
	expect(Object.keys(persisted.events)).toEqual([publishedId]);
	const [fenced, alsoFenced] = await mcp(test.issued.descriptorPath, [send("must-not-publish"), inbox()]);
	for (const result of [fenced, alsoFenced]) {
		expect(result!.isError).toBe(true);
		expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ code: "storage_error" });
	}
	expect(readFileSync(file, "utf8")).toBe(snapshot);
	await test.restart();
	const [recovered] = await mcp(test.issued.descriptorPath, [send("after-recovery")]);
	expect(recovered!.isError).toBe(false);
	expect(test.readState().events[publishedId!]).toMatchObject({ body: "uncertain" });
	expect(Object.keys(test.readState().events)).toHaveLength(2);
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
	const escaped = await client.callTool("collaborator_send", send(" ".repeat(16384)).arguments);
	expect(escaped.isError).toBe(false);
	expect(JSON.parse(escaped.content[0]!.text)).toEqual(escaped.structuredContent);
	const abort = new AbortController();
	const pending = client.callTool("collaborator_send", send("cancelled").arguments, abort.signal);
	const rejected = expect(pending).rejects.toThrow("MCP transport stopped");
	abort.abort();
	await rejected;
	await client.close();
	expect(client.closed).toBe(true);
	const replacement = new MessagingMcpClient(future);
	cleanups.push(() => replacement.close());
	await replacement.initialize();
	const recovered = await replacement.callTool("collaborator_send", send("after cancellation").arguments);
	expect(recovered.isError).toBe(false);
	const events = Object.values(test.readState().events);
	expect(events.map(event => event.eventId)).toContain(recovered.structuredContent?.eventId);
	expect(events.find(event => event.eventId === escaped.structuredContent?.eventId)?.body).toBe(" ".repeat(16384));
});

it("runs real Pi tool calls over MCP, preserves errors and full results, and recovers after Pi restart", async () => {
	const test = await setup();
	const pi = await piSession(test);
	const listed = await pi.call(peers());
	expect(listed.isError).toBe(false);
	// The bridge strips the descriptor binding it verifies, so the model never sees it.
	expect(listed.result.details).toEqual({ me: "sender", peers: [{ participantId: "recipient", live: true }] });
	const body = " ".repeat(16384);
	const sent = await pi.call(send(body));
	expect(sent.isError).toBe(false);
	const conflict = await pi.call(reply("evt_absent"));
	expect(conflict.isError).toBe(true);
	expect(JSON.parse(conflict.result.content[0].text).code).toBe("conflict");
	const end = pi.frames.filter(frame => frame.type === "message_end" && frame.message.role === "assistant").at(-1);
	expect(JSON.parse(end.message.content[0].text).tools.sort()).toEqual(["collaborator_inbox", "collaborator_peers", "collaborator_reply", "collaborator_send"]);
	await pi.close();
	const transcript = readFileSync(test.inputs.get("sender")!.piSessionFile, "utf8");
	expect(transcript).not.toContain(test.descriptor.secret);
	const persisted = transcript.trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.message?.role === "toolResult");
	expect(persisted.map(entry => entry.message.isError)).toEqual([false, false, true]);
	expect(persisted[1].message.details.eventId).toBe(sent.result.details.eventId);
	expect(test.readState().events[sent.result.details.eventId]).toMatchObject({ body });
	const restarted = await piSession(test);
	const again = await restarted.call(send("after Pi restart"));
	expect(again.isError).toBe(false);
	expect(again.result.details.eventId).not.toBe(sent.result.details.eventId);
	expect(Object.keys(test.readState().events)).toHaveLength(2);
}, 30_000);

it("blocks a new Pi session using an old descriptor and respects an explicit tool allowlist", async () => {
	const test = await setup();
	const pi = await piSession(test);
	await pi.command({ type: "new_session" });
	const denied = await pi.call(send("wrong-session"));
	expect(denied.isError).toBe(true);
	expect(denied.result.content[0].text).toContain("does not belong to this exact Pi session");
	expect(Object.keys(test.readState().events)).toHaveLength(0);
	await pi.close();
	const limited = await piSession(test, ["--tools", "collaborator_peers"]);
	const absent = await limited.call(send("disallowed"));
	expect(absent.isError).toBe(true);
	expect(absent.result.content[0].text).toContain("not found");
	await limited.command({ type: "prompt", message: "/proof-add-command" });
	const listed = await limited.call(peers());
	expect(listed.isError).toBe(false);
	expect(Object.keys(test.readState().events)).toHaveLength(0);
}, 30_000);
