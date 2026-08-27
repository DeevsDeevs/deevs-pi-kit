import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const { HostedRuntimeClient } = await import(pathToFileURL(join(repo, "extensions/runtime/client.ts")));
const { startRuntimeServer } = await import(pathToFileURL(join(repo, "extensions/runtime/service/server.ts")));
const { MissionState, MISSION_CUSTOM_TYPE } = await import(pathToFileURL(join(repo, "extensions/mission/state.ts")));
const { MissionRuntime } = await import(pathToFileURL(join(repo, "extensions/mission/runtime.ts")));
const { registerMissionTools } = await import(pathToFileURL(join(repo, "extensions/mission/tools.ts")));
const { setSubagentService, clearSubagentService } = await import(pathToFileURL(join(repo, "extensions/subagents/registry.ts")));
const base = mkdtempSync(join(tmpdir(), "pi-kit-collaborator-release-"));
const cleanupBase = () => rmSync(base, { recursive: true, force: true });
process.once("exit", cleanupBase);
const sessionName = `pi-kit-collaborator-release-${process.pid}`;
const herdrSocket = join(homedir(), ".config", "herdr", "sessions", sessionName, "herdr.sock");
const agentDir = join(base, "agent");
const runtimeRoot = join(agentDir, "runtime");
const projectRoot = join(base, "project");
const alphaSessionFile = join(base, "alpha.jsonl");
let betaSessionFile;
const alphaSessionId = "019f0000-0000-7000-8000-000000000101";
let betaSessionId;
const herdrIntegration = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
const runtimeExtension = join(repo, "extensions", "runtime", "index.ts");
const missionExtension = join(repo, "extensions", "mission", "index.ts");
const missionHoldExtension = join(base, "mission-hold.ts");
const participantEntry = "deevs.hosted-runtime.participant.v1";
const hostedEntry = "deevs.hosted-runtime.v1";

if (!existsSync(herdrIntegration)) throw new Error(`Herdr Pi integration is missing: ${herdrIntegration}`);
mkdirSync(projectRoot, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(projectRoot, "release.txt"), "runtime collaborator Mission release gate\n");
execFileSync("git", ["init", "-q"], { cwd: projectRoot });
execFileSync("git", ["add", "release.txt"], { cwd: projectRoot });
execFileSync("git", ["-c", "user.name=Release Gate", "-c", "user.email=release@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "release baseline"], { cwd: projectRoot });
writeFileSync(alphaSessionFile, `${JSON.stringify({ type: "session", version: 3, id: alphaSessionId, timestamp: new Date().toISOString(), cwd: projectRoot })}\n`);
writeFileSync(missionHoldExtension, `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";\nimport { setJobManager } from ${JSON.stringify(pathToFileURL(join(repo, "extensions/jobs/registry.ts")).href)};\nconst manager = { list: () => [{ spec: { id: "combined-release-hold" }, runtime: { status: "running" } }] };\nlet launchIssued = false;
function stream(model, context) { const events = createAssistantMessageEventStream(); const serialized = JSON.stringify(context); const launch = !launchIssued && serialized.includes("release-gate collaborator tool launch") && !serialized.includes("Started review/beta"); launchIssued ||= launch; const toolCall = { type: "toolCall", id: "release-gate-collaborator-start", name: "collaborator_manage", arguments: { action: "start", participants: [{ participantId: "beta" }], protocol: "review", callerParticipantId: "alpha" } }; const message = { role: "assistant", content: launch ? [toolCall] : [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: launch ? "toolUse" : "stop", timestamp: Date.now() }; queueMicrotask(() => { events.push({ type: "start", partial: message }); if (launch) { events.push({ type: "toolcall_start", contentIndex: 0, partial: message }); events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message }); } events.push({ type: "done", reason: message.stopReason, message }); events.end(); }); return events; }\nexport default function (pi) { setJobManager(manager); pi.registerProvider("release-gate", { name: "Release Gate", baseUrl: "http://release.invalid", apiKey: "test", api: "release-gate", streamSimple: stream, models: [{ id: "noop", name: "No-op", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }] }); }\n`);
writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProjectTrust: "always", extensions: [missionHoldExtension, herdrIntegration, runtimeExtension, missionExtension] }, null, 2)}\n`);

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
	const workspace = cli("workspace", "create", "--cwd", projectRoot, "--label", `${name}-anchor`, "--no-focus").result.workspace;
	const created = cli("tab", "create", "--workspace", workspace.workspace_id, "--cwd", projectRoot, "--label", name, "--no-focus");
	const pane = created.result.root_pane;
	panes.add(pane.pane_id);
	cli("agent", "start", name, "--kind", "pi", "--pane", pane.pane_id, "--timeout", "10000", "--", "--approve", "--model", "release-gate/noop", "--session", sessionFile);
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
	await waitFor(() => ["idle", "done"].includes(cli("agent", "get", pi.pane.pane_id).result.agent.agent_status), `${pi.pane.pane_id} did not become idle or done`, 60_000);
}

async function assertRuntimeRegistered(pi) {
	cli("agent", "prompt", pi.pane.pane_id, "/runtime register");
	await waitFor(() => {
		const output = readPane(pi.pane.pane_id);
		if (output.includes("Runtime error")) throw new Error(output.split("\n").filter((line) => line.includes("Runtime error")).at(-1));
		return output.includes("registered with Runtime");
	}, `Pi pane ${pi.pane.pane_id} did not report a live Runtime registration`);
}

async function createProductionMission(pi) {
	cli("agent", "prompt", pi.pane.pane_id, "/mission Prove collaborator-to-Mission completion once --name combined-release-gate --req 'Reply is durably admitted and typed completion settles once'");
	const snapshot = await waitFor(() => {
		const stateDir = join(projectRoot, ".missions", ".state");
		if (!existsSync(stateDir)) return undefined;
		for (const file of readdirSync(stateDir).filter((name) => name.endsWith(".json"))) {
			const candidate = JSON.parse(readFileSync(join(stateDir, file), "utf8"));
			if (candidate.mission?.title === "combined-release-gate") return candidate;
		}
		return undefined;
	}, "production parent Mission was not created", 60_000);
	await waitIdle(pi);
	return snapshot.mission.missionId;
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

async function launchCollaborator(parent, participantId) {
	const callerEntriesBefore = sessionEntries(parent.sessionFile).filter((entry) => entry.type === "custom" && entry.customType === participantEntry).length;
	cli("agent", "prompt", parent.pane.pane_id, "release-gate collaborator tool launch");
	await waitFor(() => readPane(parent.pane.pane_id, 200).includes("Start Runtime collaborator?"), "collaborator_manage did not request trusted confirmation", 60_000);
	cli("pane", "send-keys", parent.pane.pane_id, "y", "enter");
	await waitFor(() => {
		const current = participant("review", participantId);
		return current?.state === "held" ? current : undefined;
	}, `${participantId} did not acquire through the collaborator_manage tool`, 60_000);
	await waitFor(() => participant("review", "alpha")?.state === "held", "collaborator_manage did not acquire the caller identity");
	await waitFor(() => {
		const entries = sessionEntries(parent.sessionFile).filter((entry) => entry.type === "custom" && entry.customType === participantEntry);
		const latest = entries.at(-1);
		return entries.length > callerEntriesBefore && latest?.data?.participantId === "alpha" && latest.data.disposition === "held";
	}, "collaborator_manage did not persist caller acquisition");
	const launched = await waitFor(() => {
		const tabs = cli("tab", "list", "--workspace", parent.pane.workspace_id).result.tabs;
		const tab = tabs.find((candidate) => candidate.label === `collaborator:${participantId}`);
		if (!tab) return undefined;
		const pane = cli("pane", "list", "--workspace", parent.pane.workspace_id).result.panes.find((candidate) => candidate.tab_id === tab.tab_id);
		if (!pane?.agent_session?.value) return undefined;
		return { pane, live: pane, sessionFile: pane.agent_session.value };
	}, `${participantId} Herdr tab/session was not discoverable`, 60_000);
	panes.add(launched.pane.pane_id);
	const header = sessionEntries(launched.sessionFile)[0];
	assert.equal(header.type, "session");
	assert.equal(header.version, 3);
	assert.equal(header.cwd, projectRoot);
	await waitFor(() => sessionEntries(launched.sessionFile).filter((entry) => entry.type === "custom" && entry.customType === participantEntry).at(-1)?.data?.participantId === participantId, `${participantId} launch identity was not persisted`);
	await waitFor(() => readPane(parent.pane.pane_id, 200).includes(`Started review/${participantId} in`), `parent tool did not confirm ${participantId} production launch`);
	return { ...launched, sessionId: header.id, callerAcquired: true };
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
	return { client, registration, pi, sessionId };
}

async function directCall(sender, method, params) {
	for (let attempt = 0; ; attempt++) {
		try { return await sender.client.call(method, { ...auth(sender.registration), ...params }); }
		catch (error) {
			if (error?.code !== "registration_stale" || attempt >= 4) throw error;
			const refreshed = await directRegistration(sender.pi, sender.sessionId, `direct_retry_${randomUUID()}`);
			sender.client = refreshed.client;
			sender.registration = refreshed.registration;
		}
	}
}

async function send(sender, recipientKey, sendId, body) {
	const identity = Object.values(readState().participants).find((candidate) => candidate.state === "held" && candidate.holderTargetKey === sender.registration.targetKey);
	assert.ok(identity, `registration ${sender.registration.targetKey} has no held sender identity`);
	return directCall(sender, "mailbox.send", { senderParticipantKey: identity.participantKey, expectedSenderGeneration: identity.generation, recipientParticipantKey: recipientKey, sendId, body });
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

async function proveMissionCompletionOnce(replyEventId) {
	const branch = sessionEntries(alphaSessionFile);
	let progressTool;
	let completeTool;
	const pi = {
		appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
		registerTool(tool) {
			if (tool.name === "mission_progress") progressTool = tool;
			if (tool.name === "mission_complete") completeTool = tool;
		},
		registerCommand() {},
		on() {},
		sendMessage() {},
		async exec(command, args, options = {}) {
			try { return { code: 0, stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }), stderr: "", killed: false }; }
			catch (error) { return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "", killed: false }; }
		},
	};
	const ctx = {
		cwd: projectRoot,
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { confirm: async () => true, notify() {}, setStatus() {} },
		sessionManager: { getBranch: () => branch, getSessionFile: () => alphaSessionFile, getSessionId: () => alphaSessionId },
	};
	let reviewRun;
	let reviewerStarts = 0;
	const reviewArtifacts = join(base, "combined-mission-review");
	const service = {
		list: () => ({ runs: reviewRun ? [reviewRun] : [], groups: [] }),
		start: async () => {
			reviewerStarts++;
			mkdirSync(reviewArtifacts, { recursive: true });
			reviewRun = { spec: { id: "typed-release-review", artifactsDir: reviewArtifacts }, runtime: { status: "running", output: "" } };
			return reviewRun;
		},
		executor: { get: (runId) => reviewRun?.spec.id === runId ? reviewRun : undefined, onChange: () => () => undefined },
	};
	let activeService = service;
	setSubagentService(activeService);
	try {
		const state = new MissionState();
		state.loadFromSession(ctx);
		assert.equal(state.read()?.title, "combined-release-gate", "production parent Mission was not restored");
		const missionRuntime = new MissionRuntime(pi, state);
		registerMissionTools(pi, state, () => missionRuntime.restore(ctx), {
			onProgress: (input, currentCtx) => missionRuntime.onProgress(input, currentCtx),
			validateCompletion: (input, currentCtx) => missionRuntime.validateCompletion(input, currentCtx),
			authorizeCompletion: (currentCtx) => missionRuntime.authorizeCompletion(currentCtx),
			completionCandidateId: (currentCtx) => missionRuntime.completionCandidateId(currentCtx),
			onCompleted: (currentCtx, mission) => missionRuntime.onCompleted(currentCtx, mission),
		});
		assert.ok(progressTool && completeTool);
		await progressTool.execute("release-evidence", { summary: "Collaborator reply admitted", evidence: [`Runtime reply event ${replyEventId} acknowledged by the production parent Mission`], validation: [{ command: "runtime collaborator reply acknowledgement", exitCode: 0 }] }, undefined, undefined, ctx);
		state.append(pi, state.reviewEvent("due", { reason: "combined release review" }));
		await missionRuntime.startReview(ctx, state.read());
		assert.equal(reviewerStarts, 1);
		assert.equal(state.read().reviewStatus, "running");
		reviewRun.runtime.status = "completed";
		writeFileSync(join(reviewArtifacts, "review-report.json"), JSON.stringify({ version: 1, verdict: "clear", overallExplanation: "Release review clear.", findings: [] }));

		const recoveredState = new MissionState();
		recoveredState.loadFromSession(ctx);
		const recoveredRuntime = new MissionRuntime(pi, recoveredState);
		await recoveredRuntime.recover(ctx);
		assert.equal(recoveredState.read().reviewStatus, "awaiting_adjudication");
		let recoveredProgressTool;
		const recoveredPi = { ...pi, registerTool(tool) { if (tool.name === "mission_progress") recoveredProgressTool = tool; } };
		registerMissionTools(recoveredPi, recoveredState, () => recoveredRuntime.restore(ctx), { onProgress: (input, currentCtx) => recoveredRuntime.onProgress(input, currentCtx) });
		await recoveredProgressTool.execute("release-adjudication", { summary: "Typed parent adjudication", reviewVerdict: "clear", reviewRunId: "typed-release-review", reviewReason: "Structured release gate has zero blocking findings." }, undefined, undefined, ctx);
		const candidateId = recoveredState.read().reviewAdjudicatedCandidateId;
		assert.ok(candidateId);

		clearSubagentService(activeService);
		activeService = {
			list: () => ({ runs: [], groups: [] }),
			start: async () => { reviewerStarts++; return { spec: { id: `duplicate-review-${reviewerStarts}` }, runtime: { status: "running", output: "" } }; },
			executor: { get: () => undefined, onChange: () => () => undefined },
		};
		setSubagentService(activeService);
		const replayState = new MissionState();
		replayState.loadFromSession(ctx);
		const replayRuntime = new MissionRuntime(pi, replayState);
		replayState.append(pi, replayState.reviewEvent("due", { reason: "synthetic replay after adjudication" }));
		await replayRuntime.startReview(ctx, replayState.read());
		assert.equal(reviewerStarts, 1);
		assert.equal(replayState.read().reviewStatus, "clear");
		let completionEffects = 0;
		completeTool = undefined;
		registerMissionTools(pi, replayState, () => replayRuntime.restore(ctx), {
			validateCompletion: (input, currentCtx) => replayRuntime.validateCompletion(input, currentCtx),
			authorizeCompletion: (currentCtx) => replayRuntime.authorizeCompletion(currentCtx),
			completionCandidateId: (currentCtx) => replayRuntime.completionCandidateId(currentCtx),
			onCompleted: (currentCtx, mission) => { completionEffects++; replayRuntime.onCompleted(currentCtx, mission); },
		});
		assert.ok(completeTool);
		const completionInput = { authorizeCompletion: true, summary: "Combined Runtime collaborator and Mission release gate passed.", audit: [{ requirementIndex: 0, evidence: `Acknowledged reply ${replyEventId}; typed review clear.` }] };
		const first = await completeTool.execute("release-completion-1", completionInput, undefined, undefined, ctx);
		assert.equal(first.details.mission.status, "complete");
		assert.equal(first.details.mission.completionEffectsStatus, "done");
		const beforeReplay = branch.filter((entry) => entry.customType === MISSION_CUSTOM_TYPE && entry.data?.kind === "completed").length;
		const reviewsBeforeReplay = branch.filter((entry) => entry.customType === MISSION_CUSTOM_TYPE && entry.data?.kind === "review_changed").length;

		const completionReplayState = new MissionState();
		completionReplayState.loadFromSession(ctx);
		const completionReplayRuntime = new MissionRuntime(pi, completionReplayState);
		completeTool = undefined;
		registerMissionTools(pi, completionReplayState, () => completionReplayRuntime.restore(ctx), {
			validateCompletion: (input, currentCtx) => completionReplayRuntime.validateCompletion(input, currentCtx),
			authorizeCompletion: (currentCtx) => completionReplayRuntime.authorizeCompletion(currentCtx),
			completionCandidateId: (currentCtx) => completionReplayRuntime.completionCandidateId(currentCtx),
			onCompleted: (currentCtx, mission) => { completionEffects++; completionReplayRuntime.onCompleted(currentCtx, mission); },
		});
		const replay = await completeTool.execute("release-completion-2", completionInput, undefined, undefined, ctx);
		assert.equal(replay.details.alreadyComplete, true);
		assert.equal(branch.filter((entry) => entry.customType === MISSION_CUSTOM_TYPE && entry.data?.kind === "completed").length, beforeReplay);
		assert.equal(beforeReplay, 1);
		assert.equal(completionEffects, 1);
		assert.equal(branch.filter((entry) => entry.customType === MISSION_CUSTOM_TYPE && entry.data?.kind === "review_changed").length, reviewsBeforeReplay);
		assert.equal(completionReplayState.readAny()?.status, "complete");
		assert.equal(completionReplayState.readAny()?.completionEffectsStatus, "done");
		return { missionId: completionReplayState.readAny().missionId, productionParentMission: true, parentReloads: 3, reviewers: reviewerStarts, completions: beforeReplay, completionEffects };
	} finally {
		clearSubagentService(activeService);
	}
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
	await assertRuntimeRegistered(alphaPi);
	let betaPi = await launchCollaborator(alphaPi, "beta");
	assert.equal(betaPi.callerAcquired, true);
	betaSessionFile = betaPi.sessionFile;
	betaSessionId = betaPi.sessionId;
	await assertRuntimeRegistered(betaPi);
	const alphaKey = participant("review", "alpha").participantKey;
	const betaKey = participant("review", "beta").participantKey;
	assert.notEqual(alphaKey, betaKey);

	let alphaDirect = await directRegistration(alphaPi, alphaSessionId, "direct_alpha_1");
	const alphaToBeta = await send(alphaDirect, betaKey, "send_alpha_beta", "alpha-to-beta release marker; do not use tools or modify files");
	await waitMessage(betaSessionFile, "alpha-to-beta release marker", 1);
	await waitFor(() => readState().events[alphaToBeta.eventId].delivery.status === "acked", "alpha-to-beta mail was not acknowledged");
	await waitIdle(betaPi);
	await alphaDirect.client.call("pi.unregister", auth(alphaDirect.registration)).catch(() => {});
	await closePi(alphaPi);
	alphaPi = await startPi("collaborator-alpha-2", alphaSessionFile);
	await assertRuntimeRegistered(alphaPi);
	await waitFor(() => participant("review", "alpha")?.holderTargetKey === alphaDirect.registration.targetKey, "alpha identity did not restore to its stable target");
	const productionMissionId = await createProductionMission(alphaPi);

	let betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_1");
	const betaToAlpha = await send(betaDirect, alphaKey, "send_beta_alpha", "beta-to-alpha release marker; do not use tools or modify files");
	await waitMessage(alphaSessionFile, "beta-to-alpha release marker", 1);
	await waitFor(() => readState().events[betaToAlpha.eventId].delivery.status === "acked", "beta-to-alpha mail was not acknowledged");
	await waitIdle(alphaPi);
	await closePi(alphaPi);
	const missionCompletion = await proveMissionCompletionOnce(betaToAlpha.eventId);
	assert.equal(missionCompletion.missionId, productionMissionId);
	alphaPi = await startPi("collaborator-alpha-post-mission", alphaSessionFile);
	await assertRuntimeRegistered(alphaPi);
	await waitFor(() => participant("review", "alpha")?.holderTargetKey === alphaDirect.registration.targetKey, "alpha identity did not restore after Mission replay");
	await assert.rejects(() => directCall(betaDirect, "participant.acquire", { protocol: "review", participantId: "alpha", revive: false }), (error) => error?.code === "conflict");

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
	await directCall(alphaDirect, "participant.release", { participantKey: alphaKey });
	assert.equal(participant("review", "alpha").state, "ended");
	betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_3");
	await assert.rejects(() => send(betaDirect, alphaKey, "send_ended", "must reject"), (error) => error?.code === "not_found");
	const revived = await directCall(alphaDirect, "participant.acquire", { protocol: "review", participantId: "alpha", revive: true });
	assert.equal(revived.revived, true);
	assert.equal(revived.participant.state, "held");

	betaDirect = await directRegistration(betaPi, betaSessionId, "direct_beta_4");
	const takeoverMail = await send(betaDirect, alphaKey, "send_takeover", "takeover-claim release marker; do not use tools or modify files");
	const claimed = await directCall(alphaDirect, "inbox.claim", {});
	assert.ok(claimed.events.some((event) => event.eventId === takeoverMail.eventId));
	await closePi(alphaPi);
	await alphaDirect.client.call("pi.unregister", auth(alphaDirect.registration)).catch(() => {});
	await directCall(betaDirect, "participant.stand_down", { participantKey: betaKey });
	const generationBeforeTakeover = participant("review", "alpha").generation;
	await assert.rejects(() => directCall(betaDirect, "participant.takeover", { participantKey: alphaKey, expectedGeneration: generationBeforeTakeover, confirmed: true }), (error) => error?.code === "busy");
	runtimeNow += 2_000;
	const taken = await directCall(betaDirect, "participant.takeover", { participantKey: alphaKey, expectedGeneration: generationBeforeTakeover, confirmed: true });
	assert.equal(taken.holderTargetKey, betaDirect.registration.targetKey);
	assert.equal(readState().events[takeoverMail.eventId].delivery.status, "pending");

	await closePi(betaPi);
	await betaDirect.client.call("pi.unregister", auth(betaDirect.registration)).catch(() => {});
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
	try {
		await waitFor(() => Object.keys(readState().wakes).length === 0, "final wake did not settle after the full heartbeat window", 10_000);
	} catch (error) {
		const failedState = readState();
		throw new Error(`${error.message}: ${JSON.stringify({ wakes: failedState.wakes, participants: failedState.participants, unsettled: Object.values(failedState.events).filter((event) => event.delivery?.status !== "acked") })}`);
	}
	const finalState = readState();
	assert.equal(hostedMessages(betaSessionFile).length, beforeReconcileMessages, "mailbox event redelivered after final restart");

	console.log(JSON.stringify({
		status: "pass",
		productionLaunch: true,
		productionToolLaunch: true,
		trustedConfirmation: true,
		callerAcquired: true,
		materializedChildSession: true,
		participants: 2,
		alphaToBeta: alphaToBeta.eventId,
		betaToAlpha: betaToAlpha.eventId,
		missionCompletion,
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
