import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const { HostedRuntimeClient } = await import(pathToFileURL(join(repo, "extensions/runtime/client.ts")));
const { startRuntimeServer } = await import(pathToFileURL(join(repo, "extensions/runtime/service/server.ts")));
const base = mkdtempSync(join(tmpdir(), "pi-kit-runtime-release-"));
const sessionName = `pi-kit-runtime-release-${process.pid}`;
const herdrSocket = join(homedir(), ".config", "herdr", "sessions", sessionName, "herdr.sock");
const agentDir = join(base, "agent");
const runtimeRoot = join(agentDir, "runtime");
const projectRoot = join(base, "project");
const watchRoot = join(projectRoot, "reviews");
const targetSessionFile = join(base, "target.jsonl");
const foreignSessionFile = join(base, "foreign.jsonl");
const targetSessionId = "019f0000-0000-7000-8000-000000000006";
const foreignSessionId = "019f0000-0000-7000-8000-000000000007";
const herdrIntegration = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
const runtimeExtension = join(repo, "extensions", "runtime", "index.ts");

if (!existsSync(herdrIntegration)) throw new Error(`Herdr Pi integration is missing: ${herdrIntegration}`);
mkdirSync(watchRoot, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(targetSessionFile, `${JSON.stringify({ type: "session", version: 3, id: targetSessionId, timestamp: new Date().toISOString(), cwd: projectRoot })}\n`);
writeFileSync(foreignSessionFile, `${JSON.stringify({ type: "session", version: 3, id: foreignSessionId, timestamp: new Date().toISOString(), cwd: projectRoot })}\n`);

const herdrEnv = { ...process.env, HERDR_SOCKET_PATH: herdrSocket, PI_CODING_AGENT_DIR: agentDir };
delete herdrEnv.PI_PACKAGE_DIR;
let herdrServer;
let runtime;
const panes = new Set();

function cli(...args) {
	const output = execFileSync("herdr", ["--session", sessionName, ...args], { encoding: "utf8", env: herdrEnv }).trim();
	return output ? JSON.parse(output) : {};
}

function readPane(paneId, lines = 80) {
	return execFileSync("herdr", ["--session", sessionName, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], { encoding: "utf8", env: herdrEnv });
}

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

function readState() {
	return JSON.parse(readFileSync(join(runtimeRoot, "state.v1.json"), "utf8"));
}

function sessionEntries(path = targetSessionFile) {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function hostedMessages() {
	return sessionEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "deevs.hosted-runtime.v1");
}

async function startRuntime(epoch) {
	process.env.HERDR_SOCKET_PATH = herdrSocket;
	runtime = await startRuntimeServer({ root: runtimeRoot, epoch, monitor: { scanIntervalMs: 100, watchDebounceMs: 10 } });
	return runtime;
}

async function stopRuntime() {
	if (!runtime) return;
	await runtime.close();
	runtime = undefined;
}

async function startPi(name, sessionFile, withRuntime = true) {
	const created = cli("workspace", "create", "--cwd", projectRoot, "--label", name, "--no-focus");
	const pane = created.result.root_pane;
	panes.add(pane.pane_id);
	const args = ["agent", "start", name, "--kind", "pi", "--pane", pane.pane_id, "--timeout", "10000", "--", "--session", sessionFile, "--extension", herdrIntegration];
	if (withRuntime) args.push("--extension", runtimeExtension);
	cli(...args);
	const live = await waitFor(() => {
		const agent = cli("agent", "get", pane.pane_id).result.agent;
		return agent.agent_session?.kind === "path" ? agent : undefined;
	}, `${name} did not report a Pi session`);
	assert.equal(live.terminal_id, pane.terminal_id);
	assert.equal(live.agent_session.value, sessionFile);
	return { pane, live };
}

async function closePane(paneId) {
	try { cli("pane", "close", paneId); } catch {}
	panes.delete(paneId);
	await waitFor(() => {
		try {
			execFileSync("herdr", ["--session", sessionName, "agent", "get", paneId], { stdio: "pipe", env: herdrEnv });
			return false;
		} catch {
			return true;
		}
	}, `pane ${paneId} remained live`);
}

async function assertRuntimeRegistered(paneId) {
	cli("agent", "prompt", paneId, "/runtime status");
	await waitFor(() => readPane(paneId).includes("registered until"), `Pi pane ${paneId} did not report a live Runtime registration`);
}

function simulatedPreAckCrashState() {
	const state = readState();
	const claim = Object.values(state.claims).find((candidate) => candidate.status === "acked");
	assert.ok(claim, "acknowledged claim is missing before crash simulation");
	claim.status = "active";
	delete claim.settledAt;
	for (const eventId of claim.eventIds) state.events[eventId].delivery = { status: "claimed", claimId: claim.claimId };
	writeFileSync(join(runtimeRoot, "state.v1.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	return claim;
}

try {
	herdrServer = spawn("herdr", ["--session", sessionName, "server"], { stdio: ["ignore", "pipe", "pipe"], env: herdrEnv });
	await waitFor(() => existsSync(herdrSocket), "isolated Herdr socket did not start");
	await startRuntime("epoch_release_1");

	const initial = await startPi("runtime-release-target-1", targetSessionFile);
	await assertRuntimeRegistered(initial.pane.pane_id);
	cli("agent", "prompt", initial.pane.pane_id, "/runtime monitor reviews");
	await waitFor(() => Object.keys(readState().monitors).length === 1, "target did not create its Monitor");
	assert.equal(Object.keys(readState().events).length, 0, "Monitor baseline emitted unexpectedly");
	await closePane(initial.pane.pane_id);

	writeFileSync(join(watchRoot, "0050-release-review.md"), "# release review\n");
	const pendingEvent = await waitFor(() => {
		const events = Object.values(readState().events);
		return events.length === 1 && events[0].delivery.status === "pending" ? events[0] : undefined;
	}, "offline file did not become one durable pending event");
	assert.equal(Object.keys(readState().wakes).length, 0, "offline target received a wake");

	await stopRuntime();
	await startRuntime("epoch_release_2");
	assert.equal(readState().events[pendingEvent.eventId].delivery.status, "pending");

	const foreign = await startPi("runtime-release-foreign", foreignSessionFile, false);
	const client = new HostedRuntimeClient(runtime.socketPath);
	const foreignRegistration = await client.call("pi.register", {
		projectRoot,
		piSessionId: foreignSessionId,
		piSessionFile: foreignSessionFile,
		clientGeneration: "foreign_client",
		admittedClaims: [],
		herdr: { paneId: foreign.pane.pane_id, terminalId: foreign.pane.terminal_id },
	});
	await assert.rejects(() => client.call("pi.register", {
		projectRoot,
		piSessionId: targetSessionId,
		piSessionFile: targetSessionFile,
		clientGeneration: "foreign_steal",
		admittedClaims: [],
		herdr: { paneId: foreign.pane.pane_id, terminalId: foreign.pane.terminal_id },
	}), (error) => error?.code === "identity_mismatch");
	await assert.rejects(() => client.call("inbox.claim", { registrationId: foreignRegistration.registrationId, registrationKey: foreignRegistration.registrationKey }), (error) => error?.code === "not_found");

	const resumed = await startPi("runtime-release-target-2", targetSessionFile);
	await assertRuntimeRegistered(resumed.pane.pane_id);
	const acknowledgedEvent = await waitFor(() => {
		const event = readState().events[pendingEvent.eventId];
		return event?.delivery.status === "acked" ? event : undefined;
	}, "resumed exact target did not admit and acknowledge its event", 30_000);
	await waitFor(() => hostedMessages().length === 1, "exact hosted custom message was not persisted");
	const acknowledgedClaim = readState().claims[acknowledgedEvent.delivery.claimId];
	await assert.rejects(() => client.call("inbox.ack", {
		registrationId: foreignRegistration.registrationId,
		registrationKey: foreignRegistration.registrationKey,
		claimId: acknowledgedClaim.claimId,
		eventIds: acknowledgedClaim.eventIds,
	}), (error) => error?.code === "claim_conflict");

	await closePane(resumed.pane.pane_id);
	await stopRuntime();
	const simulatedClaim = simulatedPreAckCrashState();
	assert.equal(hostedMessages().length, 1, "crash simulation lost the admitted Pi receipt");
	await startRuntime("epoch_release_3");
	const reconciler = await startPi("runtime-release-target-3", targetSessionFile);
	await assertRuntimeRegistered(reconciler.pane.pane_id);
	await waitFor(() => readState().claims[simulatedClaim.claimId]?.status === "acked", "historical Pi receipt did not reconcile after restart");
	assert.equal(hostedMessages().length, 1, "historical reconciliation redelivered the event");

	await closePane(reconciler.pane.pane_id);
	await stopRuntime();
	await startRuntime("epoch_release_4");
	const finalPi = await startPi("runtime-release-target-4", targetSessionFile);
	await assertRuntimeRegistered(finalPi.pane.pane_id);
	// Cover one full client heartbeat interval as well as register/scan-triggered wake paths.
	await sleep(11_000);
	assert.equal(readState().events[pendingEvent.eventId].delivery.status, "acked");
	assert.equal(Object.keys(readState().wakes).length, 0);
	assert.equal(hostedMessages().length, 1, "acknowledged event was redelivered after the second restart");

	console.log(JSON.stringify({
		status: "pass",
		eventId: pendingEvent.eventId,
		offlineQueued: true,
		runtimeRestarts: 3,
		piRestarts: 3,
		historicalReconciled: true,
		noRedelivery: true,
		foreignRejected: true,
		customMessages: hostedMessages().length,
	}));
} catch (error) {
	for (const paneId of panes) {
		try {
			console.error(JSON.stringify({ paneId, output: readPane(paneId, 100) }));
		} catch {}
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
	rmSync(base, { recursive: true, force: true });
}
