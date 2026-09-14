import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const { HostedRuntimeClient } = await import(pathToFileURL(join(repo, "extensions/runtime/client.ts")));
const serviceMain = join(repo, "extensions/runtime/service/main.ts");
const mcpMain = join(repo, "extensions/runtime/mcp/main.mjs");
const base = mkdtempSync(join(tmpdir(), "pi-kit-runtime-release-"));
const sessionName = `pi-kit-runtime-release-${process.pid}`;
const herdrSocket = join(homedir(), ".config", "herdr", "sessions", sessionName, "herdr.sock");
const agentDir = join(base, "agent");
const runtimeRoot = join(agentDir, "runtime");
const projectRoot = join(base, "project");
const herdrEnv = { ...process.env, HERDR_SOCKET_PATH: herdrSocket, PI_CODING_AGENT_DIR: agentDir };
delete herdrEnv.PI_PACKAGE_DIR;

mkdirSync(projectRoot, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

const client = new HostedRuntimeClient(join(runtimeRoot, "runtime.sock"), 10_000);
const peers = new Set();
let herdrServer;
let daemon;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(50);
	}
	throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

/** One Pi session file per target: the header alone is what proves that target still live. */
function piSession(name, sessionId) {
	const file = join(base, `${name}.jsonl`);
	const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: projectRoot };
	writeFileSync(file, `${JSON.stringify(header)}\n`);
	return { name, sessionId, file };
}

function auth(registration) {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

function call(method, params) {
	return client.call(method, params);
}

function register(session) {
	return call("pi.register", { projectRoot, piSessionId: session.sessionId, piSessionFile: session.file });
}

async function acquire(registration, protocol, participantId) {
	const acquired = await call("participant.acquire", { ...auth(registration), protocol, participantId, revive: false });
	assert.equal(acquired.participant.state, "held", `${protocol}/${participantId} did not become held`);
	return acquired.participant;
}

async function issue(registration, participant) {
	return call("messaging.issue", {
		...auth(registration),
		participantKey: participant.participantKey,
		expectedGeneration: participant.generation,
		confirmed: true,
	});
}

/** The production stdio MCP endpoint, driven exactly as a provider would drive its six tools. */
class MessagingPeer {
	constructor(descriptorPath) {
		this.child = spawn(process.execPath, ["--experimental-strip-types", mcpMain, descriptorPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: herdrEnv,
		});
		this.pending = new Map();
		this.nextId = 1;
		this.stderr = "";
		this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			const response = JSON.parse(line);
			const settle = this.pending.get(response.id);
			if (!settle) return;
			this.pending.delete(response.id);
			settle(response);
		});
		peers.add(this);
	}

	send(method, params) {
		const id = this.nextId++;
		const settled = new Promise((resolve, reject) => {
			this.pending.set(id, (response) => response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result));
		});
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return settled;
	}

	async initialize() {
		const info = await this.send("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "pi-kit-runtime-release", version: "0.1.0" },
		});
		assert.equal(info.serverInfo.name, "pi-kit-messaging");
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const listed = await this.send("tools/list", {});
		assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
			"collaborator_peers", "collaborator_received", "collaborator_receive", "collaborator_reply",
			"collaborator_send", "collaborator_status",
		].sort(), "MCP endpoint does not expose the six collaborator tools");
		return this;
	}

	async tool(name, args) {
		const result = await this.send("tools/call", { name, arguments: args });
		if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
		return result.structuredContent;
	}

	close() {
		peers.delete(this);
		this.child.kill("SIGTERM");
	}
}

async function startDaemon() {
	daemon = spawn(process.execPath, ["--experimental-strip-types", serviceMain, "--root", runtimeRoot], {
		stdio: ["ignore", "pipe", "pipe"],
		env: herdrEnv,
	});
	let failure = "";
	daemon.stderr.on("data", (chunk) => { failure += chunk.toString(); });
	const [line] = await Promise.race([
		once(createInterface({ input: daemon.stdout }), "line"),
		once(daemon, "exit").then(() => { throw new Error(`Runtime daemon exited: ${failure}`); }),
	]);
	const ready = JSON.parse(line);
	assert.equal(ready.status, "ready", "Runtime daemon did not report readiness");
	return ready;
}

async function stopDaemon() {
	if (!daemon || daemon.exitCode !== null) return;
	daemon.kill("SIGTERM");
	await once(daemon, "exit");
	daemon = undefined;
}

const alphaSession = piSession("alpha", "019f0000-0000-7000-8000-000000000201");
const betaSession = piSession("beta", "019f0000-0000-7000-8000-000000000202");
const gammaSession = piSession("gamma", "019f0000-0000-7000-8000-000000000203");
const heirSession = piSession("heir", "019f0000-0000-7000-8000-000000000204");
const alphaBody = "alpha-to-beta runtime release marker";
const betaBody = "beta-to-alpha runtime release reply";

try {
	herdrServer = spawn("herdr", ["--session", sessionName, "server"], { stdio: ["ignore", "pipe", "pipe"], env: herdrEnv });
	await waitFor(() => existsSync(herdrSocket), "isolated Herdr socket did not start");
	const started = await startDaemon();

	const hello = await client.hello();
	assert.equal(hello.version, 1);
	assert.equal(hello.runtimeId, started.runtimeId);
	assert.deepEqual(hello.capabilities.targets, ["pi", "claude-code", "codex"]);

	// A Pi registers and heartbeats; a wrong registration key is rejected before anything else.
	let alpha = await register(alphaSession);
	const beat = await call("pi.heartbeat", auth(alpha));
	assert.equal(beat.targetKey, alpha.targetKey);
	assert.ok(beat.leaseUntil >= alpha.leaseUntil);
	assert.equal(beat.mail, undefined, "an empty mailbox offered a mail hint");
	await assert.rejects(
		() => call("pi.heartbeat", { registrationId: alpha.registrationId, registrationKey: "not-the-minted-key" }),
		(error) => error?.code === "registration_stale",
		"a wrong registration key was accepted",
	);
	await assert.rejects(
		() => call("participant.list", { registrationId: "reg_invented", registrationKey: alpha.registrationKey }),
		(error) => error?.code === "registration_stale",
		"an invented registration ID was accepted",
	);

	// Two Pi targets hold two participants of one project.
	const beta = await register(betaSession);
	const alphaHeld = await acquire(alpha, "review", "alpha");
	const betaHeld = await acquire(beta, "review", "beta");
	assert.notEqual(alphaHeld.participantKey, betaHeld.participantKey);

	const alphaGrant = await issue(alpha, alphaHeld);
	const betaGrant = await issue(beta, betaHeld);
	const alphaPeer = await new MessagingPeer(alphaGrant.descriptorPath).initialize();
	const betaPeer = await new MessagingPeer(betaGrant.descriptorPath).initialize();

	const listed = await alphaPeer.tool("collaborator_peers", {});
	assert.equal(listed.caller, "alpha");
	assert.equal(listed.protocol, "review");
	assert.deepEqual(listed.peers.map((peer) => peer.participantId), ["beta"]);
	assert.equal(listed.binding.sessionId, alphaSession.sessionId);

	// A sends to B through the MCP send; B's next heartbeat carries the hint.
	const sendArguments = { namespaceId: alphaGrant.namespaceId, participantId: "beta", operationId: "op_alpha_1", body: alphaBody };
	const sent = await alphaPeer.tool("collaborator_send", sendArguments);
	const betaBeat = await call("pi.heartbeat", auth(beta));
	assert.deepEqual(betaBeat.mail, { namespaceId: betaGrant.namespaceId, eventId: sent.eventId }, "B did not receive its mail hint");

	// A retry of the same operation ID returns the original event rather than publishing a second one.
	const retried = await alphaPeer.tool("collaborator_send", sendArguments);
	assert.equal(retried.eventId, sent.eventId, "an identical retry published a second event");
	await assert.rejects(
		() => alphaPeer.tool("collaborator_send", { ...sendArguments, body: "changed input" }),
		(error) => /conflict|different input/i.test(error.message),
		"a reused operation ID accepted changed input",
	);

	// B receives, records receipt and replies; A's heartbeat then carries the reply hint.
	const received = await betaPeer.tool("collaborator_receive", { namespaceId: betaGrant.namespaceId, eventId: sent.eventId });
	assert.equal(received.message.from, "alpha");
	assert.equal(received.message.body, alphaBody);
	assert.equal(received.message.readAt, undefined);
	const marked = await betaPeer.tool("collaborator_received", { namespaceId: betaGrant.namespaceId, eventId: sent.eventId });
	assert.ok(marked.readAt > 0, "receipt did not record a read time");
	const replied = await betaPeer.tool("collaborator_reply", {
		namespaceId: betaGrant.namespaceId,
		operationId: "op_beta_1",
		eventId: sent.eventId,
		body: betaBody,
	});
	const alphaBeat = await call("pi.heartbeat", auth(alpha));
	assert.deepEqual(alphaBeat.mail, { namespaceId: alphaGrant.namespaceId, eventId: replied.eventId }, "A did not receive its reply hint");
	const status = await alphaPeer.tool("collaborator_status", { namespaceId: alphaGrant.namespaceId, operationId: "op_alpha_1" });
	assert.equal(status.event.eventId, sent.eventId);
	assert.equal(status.event.readAt, marked.readAt, "A's status does not show the recipient's read time");

	// A restart keeps participants and mail: the same namespace and event survive a SIGTERM.
	await stopDaemon();
	await startDaemon();
	alpha = await register(alphaSession);
	const survivors = (await call("participant.list", auth(alpha))).participants;
	assert.deepEqual(survivors.map((participant) => `${participant.protocol}/${participant.participantId}:${participant.state}`), [
		"review/alpha:held", "review/beta:held",
	], "participants did not survive the daemon restart");
	assert.equal(survivors.find((participant) => participant.participantId === "alpha").generation, alphaHeld.generation);
	const restarted = await alphaPeer.tool("collaborator_status", { namespaceId: alphaGrant.namespaceId, operationId: "op_alpha_1" });
	assert.deepEqual(restarted.event, status.event, "mail did not survive the daemon restart");
	const restoredReply = await alphaPeer.tool("collaborator_receive", { namespaceId: alphaGrant.namespaceId, eventId: replied.eventId });
	assert.equal(restoredReply.message.body, betaBody, "the reply body did not survive the daemon restart");
	alphaPeer.close();
	betaPeer.close();

	// Takeover, stand-down and release of a participant whose holder went away.
	const gamma = await register(gammaSession);
	const gammaHeld = await acquire(gamma, "review", "gamma");
	await call("pi.unregister", auth(gamma));
	await assert.rejects(
		() => call("participant.stand_down", { ...auth(alpha), participantKey: gammaHeld.participantKey }),
		(error) => error?.code === "conflict",
		"a non-holder stood down another target's participant",
	);
	const heir = await register(heirSession);
	const taken = await call("participant.takeover", {
		...auth(heir),
		participantKey: gammaHeld.participantKey,
		expectedGeneration: gammaHeld.generation,
		confirmed: true,
	});
	assert.equal(taken.holderTargetKey, heir.targetKey, "takeover did not move the participant to its new holder");
	assert.equal(taken.state, "held");
	const stoodDown = await call("participant.stand_down", { ...auth(heir), participantKey: gammaHeld.participantKey });
	assert.equal(stoodDown.state, "vacant");
	assert.equal((await acquire(heir, "review", "gamma")).participantKey, gammaHeld.participantKey);
	const released = await call("participant.release", { ...auth(heir), participantKey: gammaHeld.participantKey });
	assert.equal(released.state, "ended");
	await assert.rejects(
		() => call("participant.acquire", { ...auth(heir), protocol: "review", participantId: "gamma", revive: false }),
		(error) => error?.code === "conflict",
		"an ended participant was reacquired without explicit revival",
	);

	console.log(JSON.stringify({
		status: "pass",
		runtimeId: started.runtimeId,
		registrations: 5,
		wrongKeyRejected: true,
		mail: { sent: sent.eventId, reply: replied.eventId, readAt: marked.readAt, retriedSameEvent: true },
		mcpTools: 6,
		daemonRestarts: 1,
		participants: ["review/alpha", "review/beta", "review/gamma"],
	}));
} catch (error) {
	for (const peer of peers) if (peer.stderr) console.error(JSON.stringify({ mcpStderr: peer.stderr }));
	throw error;
} finally {
	for (const peer of [...peers]) peer.close();
	await stopDaemon().catch(() => {});
	try { execFileSync("herdr", ["session", "stop", sessionName], { stdio: "ignore", env: herdrEnv }); } catch {}
	if (herdrServer && herdrServer.exitCode === null) {
		herdrServer.kill("SIGTERM");
		await once(herdrServer, "exit").catch(() => {});
	}
	try { execFileSync("herdr", ["session", "delete", sessionName], { stdio: "ignore", env: herdrEnv }); } catch {}
	rmSync(base, { recursive: true, force: true });
}
