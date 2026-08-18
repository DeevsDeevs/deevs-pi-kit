import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const { HostedRuntimeClient } = await import(pathToFileURL(join(repo, "extensions/runtime/client.ts")));
const { startRuntimeServer } = await import(pathToFileURL(join(repo, "extensions/runtime/service/server.ts")));
const base = mkdtempSync(join(tmpdir(), "pi-kit-collaborator-release-"));
const cleanupBase = () => rmSync(base, { recursive: true, force: true });
process.once("exit", cleanupBase);
const sessionName = `pi-kit-collaborator-release-${process.pid}`;
const herdrSocket = join(homedir(), ".config", "herdr", "sessions", sessionName, "herdr.sock");
const agentDir = join(base, "agent");
const runtimeRoot = join(agentDir, "runtime");
const projectRoot = join(base, "project");
const alphaSessionFile = join(base, "alpha.jsonl");
const betaSessionFile = join(base, "beta.jsonl");
const alphaSessionId = "019f0000-0000-7000-8000-000000000101";
const betaSessionId = "019f0000-0000-7000-8000-000000000102";
const herdrIntegration = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
const runtimeExtension = join(repo, "extensions", "runtime", "index.ts");
const participantEntry = "deevs.hosted-runtime.participant.v1";
const hostedEntry = "deevs.hosted-runtime.v1";

if (!existsSync(herdrIntegration)) throw new Error(`Herdr Pi integration is missing: ${herdrIntegration}`);
mkdirSync(projectRoot, { recursive: true });
mkdirSync(agentDir, { recursive: true });
for (const [path, id] of [[alphaSessionFile, alphaSessionId], [betaSessionFile, betaSessionId]]) {
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: projectRoot })}\n`);
}

const herdrEnv = { ...process.env, HERDR_SOCKET_PATH: herdrSocket, PI_CODING_AGENT_DIR: agentDir };
delete herdrEnv.PI_PACKAGE_DIR;
let herdrServer;
let runtime;
let runtimeNow = Date.now();
const panes = new Set();

function cli(...args) {
	const output = execFileSync("herdr", ["--session", sessionName, ...args], { encoding: "utf8", env: herdrEnv }).trim();
	return output ? JSON.parse(output) : {};
}

function readPane(paneId, lines = 100) {
	return execFileSync("herdr", ["--session", sessionName, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], { encoding: "utf8", env: herdrEnv });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeoutMs = 30_000) {
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

function readState() {
	return JSON.parse(readFileSync(join(runtimeRoot, "state.v1.json"), "utf8"));
}

function sessionEntries(path) {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function hostedMessages(path) {
	return sessionEntries(path).filter((entry) => entry.type === "custom_message" && entry.customType === hostedEntry);
}

function participant(protocol, participantId) {
	return Object.values(readState().participants).find((candidate) => candidate.protocol === protocol && candidate.participantId === participantId);
}

function auth(registration) {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

async function startRuntime(epoch) {
	process.env.HERDR_SOCKET_PATH = herdrSocket;
	runtimeNow += 1_000;
	runtime = await startRuntimeServer({
		root: runtimeRoot,
		epoch,
		registration: { now: () => runtimeNow },
		// Reconnect grace has deterministic unit coverage; zero keeps this destructive takeover gate bounded.
		participant: { now: () => runtimeNow, reconnectGraceMs: 0, epochStartedAt: runtimeNow },
		wake: { now: () => runtimeNow, claimLeaseMs: 1_000 },
	});
	return runtime;
}

async function stopRuntime() {
	if (!runtime) return;
	await runtime.close();
	runtime = undefined;
}

async function startPi(name, sessionFile) {
	const created = cli("workspace", "create", "--cwd", projectRoot, "--label", name, "--no-focus");
	const pane = created.result.root_pane;
	panes.add(pane.pane_id);
	cli("agent", "start", name, "--kind", "pi", "--pane", pane.pane_id, "--timeout", "10000", "--", "--session", sessionFile, "--extension", herdrIntegration, "--extension", runtimeExtension);
	const live = await waitFor(() => {
		const agent = cli("agent", "get", pane.pane_id).result.agent;
		return agent.agent_session?.kind === "path" ? agent : undefined;
	}, `${name} did not report a Pi session`);
	assert.equal(live.terminal_id, pane.terminal_id);
	assert.equal(live.agent_session.value, sessionFile);
	return { pane, live, sessionFile };
}

async function closePi(pi) {
	try { cli("pane", "close", pi.pane.pane_id); } catch {}
	panes.delete(pi.pane.pane_id);
	await waitFor(() => {
		try {
			execFileSync("herdr", ["--session", sessionName, "agent", "get", pi.pane.pane_id], { stdio: "pipe", env: herdrEnv });
			return false;
		} catch {
			return true;
		}
	}, `pane ${pi.pane.pane_id} remained live`);
}

async function waitIdle(pi) {
	await waitFor(() => cli("agent", "get", pi.pane.pane_id).result.agent.agent_status === "idle", `${pi.pane.pane_id} did not become idle`, 60_000);
}

async function assertRuntimeRegistered(pi) {
	cli("agent", "prompt", pi.pane.pane_id, "/runtime register");
	await waitFor(() => {
		const output = readPane(pi.pane.pane_id);
		if (output.includes("Runtime error")) throw new Error(output.split("\n").filter((line) => line.includes("Runtime error")).at(-1));
		return output.includes("registered with Runtime");
	}, `Pi pane ${pi.pane.pane_id} did not report a live Runtime registration`);
}

async function acquire(pi, participantId) {
	const before = sessionEntries(pi.sessionFile).filter((entry) => entry.type === "custom" && entry.customType === participantEntry).length;
	cli("agent", "prompt", pi.pane.pane_id, `/runtime collaborate review ${participantId}`);
	await waitFor(() => participant("review", participantId)?.state === "held", `${participantId} did not become held`);
	await waitFor(() => {
		const entries = sessionEntries(pi.sessionFile).filter((entry) => entry.type === "custom" && entry.customType === participantEntry);
		const latest = entries.at(-1);
		return entries.length > before && latest?.data?.participantId === participantId && latest.data.disposition === "held";
	}, `${participantId} identity was not persisted`);
}

async function directRegistration(pi, sessionId, clientGeneration) {
	const client = new HostedRuntimeClient(runtime.socketPath);
	const receipts = hostedMessages(pi.sessionFile).map((entry) => ({ claimId: entry.details.claimId, eventIds: entry.details.eventIds }));
	const registration = await client.call("pi.register", {
		projectRoot,
		piSessionId: sessionId,
		piSessionFile: pi.sessionFile,
		clientGeneration,
		admittedClaims: receipts,
		herdr: { paneId: pi.pane.pane_id, terminalId: pi.pane.terminal_id },
	});
	return { client, registration };
}

async function send(sender, recipientKey, sendId, body) {
	return sender.client.call("mailbox.send", { ...auth(sender.registration), recipientParticipantKey: recipientKey, sendId, body });
}

async function waitMessage(path, body, count) {
	return waitFor(() => {
		const messages = hostedMessages(path);
		return messages.length === count && messages.some((entry) => String(entry.content).includes(body)) ? messages : undefined;
	}, `Pi session did not admit ${body}`, 60_000);
}

function appendParticipantIdentity(path, value) {
	const entries = sessionEntries(path);
	const parent = entries.at(-1);
	appendFileSync(path, `${JSON.stringify({
		type: "custom",
		id: randomUUID(),
		parentId: parent?.id ?? null,
		timestamp: new Date().toISOString(),
		customType: participantEntry,
		data: value,
	})}\n`);
}

function simulatePreAckCrash(eventId) {
	const state = readState();
	const event = state.events[eventId];
	assert.equal(event.delivery.status, "acked");
	const claim = state.claims[event.delivery.claimId];
	assert.ok(claim);
	claim.status = "active";
	delete claim.settledAt;
	event.delivery = { status: "claimed", claimId: claim.claimId };
	writeFileSync(join(runtimeRoot, "state.v1.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	return claim;
}

try {
	herdrServer = spawn("herdr", ["--session", sessionName, "server"], { stdio: ["ignore", "pipe", "pipe"], env: herdrEnv });
	await waitFor(() => existsSync(herdrSocket), "isolated Herdr socket did not start");
	await startRuntime("epoch_collaborator_1");

	let alphaPi = await startPi("collaborator-alpha-1", alphaSessionFile);
	let betaPi = await startPi("collaborator-beta-1", betaSessionFile);
	await assertRuntimeRegistered(alphaPi);
	await assertRuntimeRegistered(betaPi);
	await acquire(alphaPi, "alpha");
	await acquire(betaPi, "beta");
	const alphaKey = participant("review", "alpha").participantKey;
	const betaKey = participant("review", "beta").participantKey;
	assert.notEqual(alphaKey, betaKey);

	let alphaDirect = await directRegistration(alphaPi, alphaSessionId, "direct_alpha_1");
	const alphaToBeta = await send(alphaDirect, betaKey, "send_alpha_beta", "alpha-to-beta release marker; do not use tools or modify files");
	await waitMessage(betaSessionFile, "alpha-to-beta release marker", 1);
	await waitFor(() => readState().events[alphaToBeta.eventId].delivery.status === "acked", "alpha-to-beta mail was not acknowledged");
	await waitIdle(betaPi);
	await alphaDirect.client.call("pi.unregister", auth(alphaDirect.registration));
	await closePi(alphaPi);
	alphaPi = await startPi("collaborator-alpha-2", alphaSessionFile);
	await assertRuntimeRegistered(alphaPi);
	await waitFor(() => participant("review", "alpha")?.holderTargetKey === alphaDirect.registration.targetKey, "alpha identity did not restore to its stable target");

	let betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_1");
	const betaToAlpha = await send(betaDirect, alphaKey, "send_beta_alpha", "beta-to-alpha release marker; do not use tools or modify files");
	await waitMessage(alphaSessionFile, "beta-to-alpha release marker", 1);
	await waitFor(() => readState().events[betaToAlpha.eventId].delivery.status === "acked", "beta-to-alpha mail was not acknowledged");
	await waitIdle(alphaPi);
	await assert.rejects(() => betaDirect.client.call("participant.acquire", { ...auth(betaDirect.registration), protocol: "review", participantId: "alpha", revive: false }), (error) => error?.code === "conflict");

	cli("agent", "prompt", alphaPi.pane.pane_id, "/runtime stand-down");
	await waitFor(() => participant("review", "alpha").state === "vacant", "restored alpha identity could not stand down");
	await waitFor(() => sessionEntries(alphaSessionFile).filter((entry) => entry.type === "custom" && entry.customType === participantEntry).at(-1)?.data?.disposition === "vacant", "alpha stand-down disposition was not persisted");
	betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_2");
	const queuedWhileVacant = await send(betaDirect, alphaKey, "send_vacant", "vacant-queue release marker; do not use tools or modify files");
	assert.equal(readState().events[queuedWhileVacant.eventId].delivery.status, "pending");
	await closePi(alphaPi);
	// The pane died before its best-effort unregister could be observed; advance the isolated clock past the registration lease.
	runtimeNow += 31_000;
	alphaPi = await startPi("collaborator-alpha-3", alphaSessionFile);
	await assertRuntimeRegistered(alphaPi);
	await sleep(250);
	assert.equal(readState().events[queuedWhileVacant.eventId].delivery.status, "pending", "vacant identity auto-reacquired");
	await acquire(alphaPi, "alpha");
	await waitMessage(alphaSessionFile, "vacant-queue release marker", 2);
	await waitIdle(alphaPi);

	alphaDirect = await directRegistration(alphaPi, alphaSessionId, "direct_alpha_3");
	await alphaDirect.client.call("participant.release", { ...auth(alphaDirect.registration), participantKey: alphaKey });
	assert.equal(participant("review", "alpha").state, "ended");
	betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_3");
	await assert.rejects(() => send(betaDirect, alphaKey, "send_ended", "must reject"), (error) => error?.code === "not_found");
	const revived = await alphaDirect.client.call("participant.acquire", { ...auth(alphaDirect.registration), protocol: "review", participantId: "alpha", revive: true });
	assert.equal(revived.revived, true);
	assert.equal(revived.participant.state, "held");

	betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_4");
	const takeoverMail = await send(betaDirect, alphaKey, "send_takeover", "takeover-claim release marker; do not use tools or modify files");
	const claimed = await alphaDirect.client.call("inbox.claim", auth(alphaDirect.registration));
	assert.ok(claimed.events.some((event) => event.eventId === takeoverMail.eventId));
	await closePi(alphaPi);
	await alphaDirect.client.call("pi.unregister", auth(alphaDirect.registration));
	await betaDirect.client.call("participant.stand_down", { ...auth(betaDirect.registration), participantKey: betaKey });
	const generationBeforeTakeover = participant("review", "alpha").generation;
	await assert.rejects(() => betaDirect.client.call("participant.takeover", { ...auth(betaDirect.registration), participantKey: alphaKey, expectedGeneration: generationBeforeTakeover, confirmed: true }), (error) => error?.code === "busy");
	runtimeNow += 2_000;
	const taken = await betaDirect.client.call("participant.takeover", { ...auth(betaDirect.registration), participantKey: alphaKey, expectedGeneration: generationBeforeTakeover, confirmed: true });
	assert.equal(taken.holderTargetKey, betaDirect.registration.targetKey);
	assert.equal(readState().events[takeoverMail.eventId].delivery.status, "pending");

	await closePi(betaPi);
	await betaDirect.client.call("pi.unregister", auth(betaDirect.registration));
	appendParticipantIdentity(betaSessionFile, { version: 1, protocol: "review", participantId: "alpha", participantKey: alphaKey, generation: taken.generation, disposition: "held" });
	betaPi = await startPi("collaborator-beta-2-takeover", betaSessionFile);
	await assertRuntimeRegistered(betaPi);
	await waitMessage(betaSessionFile, "takeover-claim release marker", 2);
	await waitFor(() => readState().events[takeoverMail.eventId].delivery.status === "acked", "taken-over mailbox event was not acknowledged");
	await waitIdle(betaPi);

	await closePi(betaPi);
	await stopRuntime();
	const simulatedClaim = simulatePreAckCrash(takeoverMail.eventId);
	const beforeReconcileMessages = hostedMessages(betaSessionFile).length;
	await startRuntime("epoch_collaborator_2");
	betaPi = await startPi("collaborator-beta-3-reconcile", betaSessionFile);
	await assertRuntimeRegistered(betaPi);
	await waitFor(() => readState().claims[simulatedClaim.claimId]?.status === "acked", "historical mailbox receipt did not reconcile");
	assert.equal(hostedMessages(betaSessionFile).length, beforeReconcileMessages, "historical reconciliation redelivered mailbox mail");

	await closePi(betaPi);
	await stopRuntime();
	await startRuntime("epoch_collaborator_3");
	betaPi = await startPi("collaborator-beta-4-final", betaSessionFile);
	await assertRuntimeRegistered(betaPi);
	await sleep(11_000);
	assert.equal(readState().events[takeoverMail.eventId].delivery.status, "acked");
	assert.equal(Object.keys(readState().wakes).length, 0);
	assert.equal(hostedMessages(betaSessionFile).length, beforeReconcileMessages, "mailbox event redelivered after final restart");

	console.log(JSON.stringify({
		status: "pass",
		participants: 2,
		alphaToBeta: alphaToBeta.eventId,
		betaToAlpha: betaToAlpha.eventId,
		standDownQueued: queuedWhileVacant.eventId,
		releaseRejected: true,
		revived: true,
		claimedTakeover: takeoverMail.eventId,
		historicalReconciled: true,
		noRedelivery: true,
		runtimeRestarts: 2,
		piStarts: { alpha: 3, beta: 4 },
	}));
} catch (error) {
	for (const paneId of panes) {
		try { console.error(JSON.stringify({ paneId, output: readPane(paneId) })); } catch {}
	}
	throw error;
} finally {
	await stopRuntime().catch(() => {});
	try { execFileSync("herdr", ["session", "stop", sessionName], { stdio: "ignore" }); } catch {}
	if (herdrServer && herdrServer.exitCode === null) {
		herdrServer.kill("SIGTERM");
		await once(herdrServer, "exit").catch(() => {});
	}
	try { execFileSync("herdr", ["session", "delete", sessionName], { stdio: "ignore" }); } catch {}
	cleanupBase();
	process.off("exit", cleanupBase);
}
