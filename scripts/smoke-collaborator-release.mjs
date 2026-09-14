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
const { projectScope } = await import(pathToFileURL(join(repo, "extensions/runtime/service/state.ts")));
const base = mkdtempSync(join(tmpdir(), "pi-kit-collaborator-release-"));
const cleanupBase = () => rmSync(base, { recursive: true, force: true });
process.once("exit", cleanupBase);
const sessionName = `pi-kit-collaborator-release-${process.pid}`;
const herdrSocket = join(homedir(), ".config", "herdr", "sessions", sessionName, "herdr.sock");
const agentDir = join(base, "agent");
const runtimeRoot = join(agentDir, "runtime");
const projectRoot = join(base, "project");
const alphaSessionFile = join(base, "alpha.jsonl");
const alphaSessionId = "019f0000-0000-7000-8000-000000000101";
const herdrIntegration = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
const runtimeExtension = join(repo, "extensions", "runtime", "index.ts");
const providerExtension = join(base, "release-gate-provider.ts");
const mailEntry = "deevs.hosted-runtime.messaging-mail.v1";
const model = "release-gate/noop";
const mailBody = "caller mail marker for the collaborator release gate; do not use tools or modify files";

/** Every collaborator lifecycle step this gate drives through the production tools, one trigger phrase each. */
const TOOL_CALLS = [
	{
		id: "runlaunch",
		name: "collaborator_manage",
		arguments: {
			action: "start",
			protocol: "review",
			callerParticipantId: "alpha",
			participants: [{ participantId: "beta", profile: "workspace-write", model }, { participantId: "gamma", model }],
		},
	},
	{
		id: "runstanddown",
		name: "collaborator_manage",
		arguments: { action: "stand_down", protocol: "review", participants: [{ participantId: "gamma" }] },
	},
	{
		id: "runstop",
		name: "collaborator_manage",
		arguments: { action: "stop", protocol: "review", participants: [{ participantId: "beta" }] },
	},
	{ id: "runcleanup", name: "collaborator_workspace", arguments: { action: "cleanup", participantId: "beta" } },
];

if (!existsSync(herdrIntegration)) throw new Error(`Herdr Pi integration is missing: ${herdrIntegration}`);
mkdirSync(projectRoot, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(projectRoot, "release.txt"), "runtime collaborator release gate\n");
execFileSync("git", ["init", "-q"], { cwd: projectRoot });
execFileSync("git", ["add", "release.txt"], { cwd: projectRoot });
execFileSync("git", ["-c", "user.name=Release Gate", "-c", "user.email=release@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "release baseline"], { cwd: projectRoot });
writeFileSync(alphaSessionFile, `${JSON.stringify({ type: "session", version: 3, id: alphaSessionId, timestamp: new Date().toISOString(), cwd: projectRoot })}\n`);
writeFileSync(providerExtension, `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const CALLS = ${JSON.stringify(TOOL_CALLS)};
const issued = new Set();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function stream(model, context) {
	const events = createAssistantMessageEventStream();
	const serialized = JSON.stringify(context);
	const pending = CALLS.find((call) => !issued.has(call.id) && serialized.includes(call.id));
	if (pending) issued.add(pending.id);
	const toolCall = pending ? { type: "toolCall", id: pending.id, name: pending.name, arguments: pending.arguments } : undefined;
	const message = { role: "assistant", content: toolCall ? [toolCall] : [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: toolCall ? "toolUse" : "stop", timestamp: Date.now() };
	queueMicrotask(() => {
		events.push({ type: "start", partial: message });
		if (toolCall) {
			events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
		}
		events.push({ type: "done", reason: message.stopReason, message });
		events.end();
	});
	return events;
}
export default function (pi) {
	pi.registerProvider("release-gate", { name: "Release Gate", baseUrl: "http://release.invalid", apiKey: "test", api: "release-gate", streamSimple: stream, models: [{ id: "noop", name: "No-op", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }] });
}
`);
writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
	defaultProjectTrust: "always",
	extensions: [providerExtension, herdrIntegration, runtimeExtension],
}, null, 2)}\n`);

const herdrEnv = { ...process.env, HERDR_SOCKET_PATH: herdrSocket, PI_CODING_AGENT_DIR: agentDir };
delete herdrEnv.PI_PACKAGE_DIR;
let herdrServer;
let runtime;
const panes = new Set();

function cli(...args) {
	const output = execFileSync("herdr", ["--session", sessionName, ...args], { encoding: "utf8", env: herdrEnv }).trim();
	return output ? JSON.parse(output) : {};
}

function readPane(paneId, lines = 200) {
	return execFileSync("herdr", ["--session", sessionName, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], { encoding: "utf8", env: herdrEnv });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(100);
	}
	throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function readState() {
	return JSON.parse(readFileSync(join(runtimeRoot, "state.v1.json"), "utf8"));
}

function participant(participantId) {
	return Object.values(readState().participants).find((candidate) => candidate.protocol === "review" && candidate.participantId === participantId);
}

function sessionEntries(path) {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function auth(registration) {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

async function startPi(name, sessionFile) {
	const workspace = cli("workspace", "create", "--cwd", projectRoot, "--label", `${name}-anchor`, "--no-focus").result.workspace;
	const created = cli("tab", "create", "--workspace", workspace.workspace_id, "--cwd", projectRoot, "--label", name, "--no-focus");
	const pane = created.result.root_pane;
	panes.add(pane.pane_id);
	cli("agent", "start", name, "--kind", "pi", "--pane", pane.pane_id, "--timeout", "10000", "--", "--approve", "--model", model, "--session", sessionFile);
	const live = await waitFor(() => {
		const agent = cli("agent", "get", pane.pane_id).result.agent;
		return agent.agent_session?.kind === "path" ? agent : undefined;
	}, `${name} did not report a Pi session`);
	assert.equal(live.agent_session.value, sessionFile);
	return { pane, sessionFile };
}

async function waitIdle(pi) {
	await waitFor(() => ["idle", "done"].includes(cli("agent", "get", pi.pane.pane_id).result.agent.agent_status), `${pi.pane.pane_id} did not settle`);
}

async function assertRuntimeRegistered(pi) {
	cli("agent", "prompt", pi.pane.pane_id, "/runtime register");
	await waitFor(() => {
		const output = readPane(pi.pane.pane_id);
		if (output.includes("Runtime error")) throw new Error(output.split("\n").filter((line) => line.includes("Runtime error")).at(-1));
		return output.includes("registered with Runtime");
	}, `Pi pane ${pi.pane.pane_id} did not report a live Runtime registration`);
}

/** One production tool call: the trigger prompt, its single trusted confirmation, then the settled turn. */
async function driveTool(pi, trigger, confirmation) {
	cli("agent", "prompt", pi.pane.pane_id, trigger);
	await waitFor(() => readPane(pi.pane.pane_id).includes(confirmation), `${trigger} did not request ${JSON.stringify(confirmation)}`);
	cli("pane", "send-keys", pi.pane.pane_id, "y", "enter");
	await waitIdle(pi);
}

/** The launched collaborator tab Runtime created, discovered exactly as an operator would see it. */
function collaboratorPane(workspaceId, participantId) {
	const tab = cli("tab", "list", "--workspace", workspaceId).result.tabs.find((candidate) => candidate.label === `collaborator:${participantId}`);
	if (!tab) return undefined;
	const pane = cli("pane", "list", "--workspace", workspaceId).result.panes.find((candidate) => candidate.tab_id === tab.tab_id);
	return pane?.agent_session?.value ? pane : undefined;
}

try {
	herdrServer = spawn("herdr", ["--session", sessionName, "server"], { stdio: ["ignore", "pipe", "pipe"], env: herdrEnv });
	await waitFor(() => existsSync(herdrSocket), "isolated Herdr socket did not start", 20_000);
	process.env.HERDR_SOCKET_PATH = herdrSocket;
	runtime = await startRuntimeServer({ root: runtimeRoot });

	const alphaPi = await startPi("collaborator-alpha", alphaSessionFile);
	await assertRuntimeRegistered(alphaPi);

	// One confirmed production start batch: a workspace-write writer and a read-only peer.
	await driveTool(alphaPi, "runlaunch", "Start Runtime collaborator");
	const beta = await waitFor(() => collaboratorPane(alphaPi.pane.workspace_id, "beta"), "beta collaborator tab was not created");
	const gamma = await waitFor(() => collaboratorPane(alphaPi.pane.workspace_id, "gamma"), "gamma collaborator tab was not created");
	panes.add(beta.pane_id);
	panes.add(gamma.pane_id);
	await waitFor(() => participant("alpha")?.state === "held", "collaborator_manage did not acquire the caller identity");
	await waitFor(() => participant("beta")?.state === "held", "beta did not become held");
	await waitFor(() => participant("gamma")?.state === "held", "gamma did not become held");
	assert.ok(readPane(alphaPi.pane.pane_id).includes("Started review/beta in"), "the tool did not report beta's production launch");

	// The writer runs in its own Runtime-owned worktree; the Herdr agent is live under the isolated socket.
	const worktree = join(runtimeRoot, "workspaces", `${projectScope(projectRoot)}__review__beta`);
	assert.ok(existsSync(join(worktree, "release.txt")), `beta has no worktree at ${worktree}`);
	assert.equal(participant("beta").worktreePath, worktree);
	const betaAgent = cli("agent", "get", beta.pane_id).result.agent;
	assert.ok(betaAgent.name.startsWith("collab-"), `beta agent name ${betaAgent.name} is not Runtime-owned`);
	assert.equal(betaAgent.cwd, worktree);
	assert.equal(betaAgent.agent_session.value, beta.agent_session.value);
	assert.equal(sessionEntries(beta.agent_session.value)[0].cwd, worktree);
	assert.equal(participant("gamma").worktreePath, undefined, "a read-only collaborator was given a worktree");

	// Mail from the caller reaches the collaborator as a heartbeat hint, never as a pushed body.
	const client = new HostedRuntimeClient(runtime.socketPath, 10_000);
	const alphaRegistration = await client.call("pi.register", { projectRoot, piSessionId: alphaSessionId, piSessionFile: alphaSessionFile });
	const alphaHeld = participant("alpha");
	const sent = await client.call("mailbox.send", {
		...auth(alphaRegistration),
		senderParticipantKey: alphaHeld.participantKey,
		expectedSenderGeneration: alphaHeld.generation,
		recipientParticipantKey: participant("beta").participantKey,
		sendId: "send_caller_beta",
		body: mailBody,
	});
	const hint = await waitFor(() => sessionEntries(beta.agent_session.value)
		.find((entry) => entry.type === "custom_message" && entry.customType === mailEntry), "beta's heartbeat did not carry the mail hint");
	assert.equal(hint.details.eventId, sent.eventId);
	assert.ok(!String(hint.content).includes(mailBody), "the hint pushed the message body into the collaborator");

	// Stand down one collaborator, stop the other, then clean up the stopped writer's worktree.
	await driveTool(alphaPi, "runstanddown", "Stand down Runtime collaborator");
	await waitFor(() => participant("gamma")?.state === "vacant", "gamma did not stand down");
	assert.ok(collaboratorPane(alphaPi.pane.workspace_id, "gamma"), "stand-down closed the collaborator tab");

	await driveTool(alphaPi, "runstop", "Stop Runtime collaborator");
	await waitFor(() => participant("beta")?.state === "vacant", "beta did not vacate after stop");
	await waitFor(() => collaboratorPane(alphaPi.pane.workspace_id, "beta") === undefined, "stop left beta's Herdr tab open");
	assert.ok(existsSync(worktree), "stop deleted a collaborator worktree");

	await driveTool(alphaPi, "runcleanup", "Remove collaborator worktree?");
	await waitFor(() => !existsSync(worktree), "collaborator_workspace cleanup did not remove the worktree");
	const branches = execFileSync("git", ["branch", "--list", "runtime/collab/review/beta"], { cwd: projectRoot, encoding: "utf8" });
	assert.equal(branches.trim(), "", "cleanup left the collaborator branch behind");

	console.log(JSON.stringify({
		status: "pass",
		productionToolLaunch: true,
		trustedConfirmations: 4,
		callerAcquired: true,
		collaborators: ["review/beta", "review/gamma"],
		agentName: betaAgent.name,
		worktree,
		mailHint: sent.eventId,
		stoodDown: "review/gamma",
		stopped: "review/beta",
		worktreeRemoved: true,
	}));
} catch (error) {
	for (const paneId of panes) {
		try { console.error(JSON.stringify({ paneId, output: readPane(paneId) })); } catch {}
	}
	throw error;
} finally {
	if (runtime) await runtime.close().catch(() => {});
	try { execFileSync("herdr", ["session", "stop", sessionName], { stdio: "ignore", env: herdrEnv }); } catch {}
	if (herdrServer && herdrServer.exitCode === null) {
		herdrServer.kill("SIGTERM");
		await once(herdrServer, "exit").catch(() => {});
	}
	try { execFileSync("herdr", ["session", "delete", sessionName], { stdio: "ignore", env: herdrEnv }); } catch {}
	cleanupBase();
	process.off("exit", cleanupBase);
}
