import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BridgeRunner } from "../extensions/runtime/bridge-runner/runner.ts";
import { writeRunnerConfig } from "../extensions/runtime/bridge-runner/journal.ts";
import type { BridgeDriver, BridgeProfile, BridgeRunnerConfig } from "../extensions/runtime/bridge-runner/types.ts";
import { HostedRuntimeClient } from "../extensions/runtime/client.ts";
import { startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";
import type { HostedHostVerifier, HostedLiveAgent, HostedPaneIdentity } from "../extensions/runtime/service/registration.ts";

const roots: string[] = [];
const servers: RuntimeServerHandle[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	readonly panes = new Map<string, HostedPaneIdentity>();
	async getPane(paneId: string): Promise<HostedLiveAgent> { const value = this.agents.get(paneId); if (!value) throw new Error("missing agent"); return value; }
	async findTerminal(terminalId: string): Promise<HostedLiveAgent> { const value = [...this.agents.values()].find((agent) => agent.terminalId === terminalId); if (!value) throw new Error("missing terminal"); return value; }
	async getPaneIdentity(paneId: string): Promise<HostedPaneIdentity> { const value = this.panes.get(paneId); if (!value) throw new Error("missing pane"); return value; }
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Release Gate", GIT_AUTHOR_EMAIL: "release@example.invalid", GIT_COMMITTER_NAME: "Release Gate", GIT_COMMITTER_EMAIL: "release@example.invalid" } }).trim();
}

async function settle(runner: BridgeRunner): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		await runner.step();
		if (runner.state().turns.at(-1)?.state === "reply_sent") return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Native runner did not settle: ${JSON.stringify(runner.state())}`);
}

it("runs deterministic native drivers through Runtime and stages an isolated workspace integration", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-native-release-"));
	roots.push(root);
	const project = join(root, "project");
	const runtimeRoot = join(root, "runtime");
	const bin = join(root, "bin");
	mkdirSync(project);
	mkdirSync(bin);
	git(project, ["init", "-b", "main"]);
	writeFileSync(join(project, "base.txt"), "base\n");
	git(project, ["add", "-A"]);
	git(project, ["commit", "-m", "base"]);
	writeExecutable(join(bin, "claude"), claudeShim());
	writeExecutable(join(bin, "codex"), codexShim());
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	try {
		const host = new FakeHost();
		const sessionFile = join(root, "main.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_main", timestamp: new Date().toISOString(), cwd: project })}\n`);
		host.agents.set("w1:p1", { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", terminalId: "term_main", cwd: project, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, status: "idle", stateChangeSeq: 1 });
		const server = await startRuntimeServer({ root: runtimeRoot, socketPath: join(runtimeRoot, "runtime.sock"), host });
		servers.push(server);
		const client = new HostedRuntimeClient(server.socketPath);
		const registration = await client.call("pi.register", { projectRoot: project, piSessionId: "session_main", piSessionFile: sessionFile, clientGeneration: "client_main", admittedClaims: [], herdr: { paneId: "w1:p1", terminalId: "term_main" } }) as Record<string, string>;
		const caller = (await client.call("participant.acquire", { ...auth(registration), protocol: "review", participantId: "main" }) as { participant: { participantKey: string; generation: string } }).participant;

		await runNative({ client, host, root, project, registration, caller, driver: "claude-code", profile: "read-only", paneId: "w1:p2", terminalId: "term_claude", launchId: "launch_claude", expectedReply: "CLAUDE_READ_ONLY_OK" });
		expect(existsSync(join(project, "native-release.txt"))).toBe(false);

		const baseHead = git(project, ["rev-parse", "HEAD"]);
		const codex = await runNative({ client, host, root, project, registration, caller, driver: "codex", profile: "workspace-write", paneId: "w1:p3", terminalId: "term_codex", launchId: "launch_codex", expectedReply: "CODEX_WORKSPACE_WRITE_OK" });
		expect(readFileSync(join(codex.cwd, "native-release.txt"), "utf8")).toBe("codex workspace write\n");
		expect(existsSync(join(project, "native-release.txt"))).toBe(false);
		const authority = { ...auth(registration), callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation };
		await client.call("workspace.retain", { ...authority, workspaceId: codex.workspaceId });
		const checkpoint = await client.call("workspace.checkpoint", { ...authority, workspaceId: codex.workspaceId, taskStatus: "completed" }) as { workspace: { state: string } };
		expect(checkpoint.workspace.state).toBe("ready_handoff");
		expect([git(project, ["rev-parse", "HEAD"]), git(project, ["status", "--porcelain"])]).toEqual([baseHead, ""]);
		const prepared = await client.call("workspace.integration.prepare", { ...authority, workspaceId: codex.workspaceId }) as { integration: { integrationId: string; state: string; worktreePath: string; branchRef: string } };
		expect(prepared.integration.state).toBe("prepared");
		expect(readFileSync(join(prepared.integration.worktreePath, "native-release.txt"), "utf8")).toBe("codex workspace write\n");
		expect([git(project, ["rev-parse", "HEAD"]), git(project, ["status", "--porcelain"])]).toEqual([baseHead, ""]);
		await client.call("workspace.integration.finalize", { ...authority, integrationId: prepared.integration.integrationId });
		expect(readFileSync(join(project, "native-release.txt"), "utf8")).toBe("codex workspace write\n");
		expect(git(project, ["rev-parse", "HEAD"])).not.toBe(baseHead);
		expect(git(project, ["status", "--porcelain"])).toBe("");
		const integrationCleanup = await client.call("workspace.integration.cleanup", { ...authority, integrationId: prepared.integration.integrationId, discardConfirmed: false }) as { integration: { state: string } };
		const workspaceCleanup = await client.call("workspace.cleanup", { ...authority, workspaceId: codex.workspaceId, discardConfirmed: false }) as { workspace: { state: string } };
		expect([integrationCleanup.integration.state, workspaceCleanup.workspace.state]).toEqual(["cleaned", "cleaned"]);
		expect([refExists(project, prepared.integration.branchRef), refExists(project, codex.branchRef)]).toEqual([false, false]);
		expect(git(project, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
	} finally {
		process.env.PATH = originalPath;
	}
}, 20_000);

async function runNative(input: {
	client: HostedRuntimeClient;
	host: FakeHost;
	root: string;
	project: string;
	registration: Record<string, string>;
	caller: { participantKey: string; generation: string };
	driver: BridgeDriver;
	profile: BridgeProfile;
	paneId: string;
	terminalId: string;
	launchId: string;
	expectedReply: string;
}): Promise<{ cwd: string; workspaceId?: string; branchRef?: string }> {
	const authority = { ...auth(input.registration), callerParticipantKey: input.caller.participantKey, expectedCallerGeneration: input.caller.generation };
	let cwd = input.project;
	let workspaceId: string | undefined;
	let branchRef: string | undefined;
	if (input.profile === "workspace-write") {
		const created = await input.client.call("workspace.bridge.create", { ...authority, requestId: `workspace_${input.launchId}`, bridgeId: input.launchId, protocol: "review", participantId: input.driver }) as { workspace: { workspaceId: string; worktreePath: string; branchRef: string } };
		workspaceId = created.workspace.workspaceId;
		branchRef = created.workspace.branchRef;
		cwd = created.workspace.worktreePath;
	}
	input.host.panes.set(input.paneId, { paneId: input.paneId, tabId: `tab_${input.launchId}`, workspaceId: "w1", terminalId: input.terminalId, cwd, paneCount: 1, revision: 1 });
	if (workspaceId) await input.client.call("workspace.launch.bind", { ...authority, workspaceId, herdr: { paneId: input.paneId, terminalId: input.terminalId } });
	const configurationHash = input.driver === "claude-code" ? "a".repeat(64) : "b".repeat(64);
	const launch = await input.client.call("bridge.launch.create", { ...authority, requestId: `bridge_${input.launchId}`, launchId: input.launchId, ...(workspaceId ? { workspaceId } : {}), protocol: "review", participantId: input.driver, profile: input.profile, configurationHash, herdr: { paneId: input.paneId, terminalId: input.terminalId }, metadata: { adapter: `${input.driver}-release-shim` } }) as { launchId: string; targetKey: string; launchToken: string; reconnectToken: string };
	input.host.agents.set(input.paneId, { paneId: input.paneId, tabId: `tab_${input.launchId}`, workspaceId: "w1", terminalId: input.terminalId, cwd, agentSession: { source: "pi-kit-bridge", agent: "bridge", kind: "id", value: launch.launchId }, status: "idle", stateChangeSeq: 2 });
	const runnerRoot = join(input.root, `runner-${input.driver}`);
	mkdirSync(runnerRoot);
	const configPath = join(runnerRoot, "config.v1.json");
	const config: BridgeRunnerConfig = { version: 1, bridgeId: launch.launchId, driver: input.driver, root: runnerRoot, runtimeSocket: input.client.socketPath, projectRoot: input.project, cwd, clientGeneration: `client_${input.driver}`, protocol: "review", participantId: input.driver, profile: input.profile, configurationHash, launchToken: launch.launchToken, reconnectToken: launch.reconnectToken, targetKey: launch.targetKey, wallMs: 2_000 };
	writeRunnerConfig(configPath, config);
	const runner = new BridgeRunner(configPath, config, undefined, { herdrIdentity: async () => ({ paneId: input.paneId, terminalId: input.terminalId }) });
	await runner.start();
	await input.client.call("mailbox.send", { ...auth(input.registration), senderParticipantKey: input.caller.participantKey, expectedSenderGeneration: input.caller.generation, recipientParticipantKey: runner.state().participantKey, sendId: `send_${input.launchId}`, body: "release gate" });
	await settle(runner);
	const reply = await input.client.call("inbox.claim", auth(input.registration)) as { claimId: string; events: Array<{ eventId: string; payload: { body: string } }> };
	expect(reply.events.at(-1)?.payload.body).toBe(input.expectedReply);
	await input.client.call("inbox.ack", { ...auth(input.registration), claimId: reply.claimId, eventIds: reply.events.map((event) => event.eventId) });
	runner.stop();
	return { cwd, ...(workspaceId ? { workspaceId, branchRef } : {}) };
}

function auth(registration: Record<string, string>) { return { registrationId: registration.registrationId, registrationKey: registration.registrationKey }; }
function refExists(cwd: string, ref: string | undefined): boolean { if (!ref) return false; try { git(cwd, ["show-ref", "--verify", "--quiet", ref]); return true; } catch { return false; } }
function writeExecutable(path: string, body: string): void { writeFileSync(path, body); chmodSync(path, 0o700); }
function claudeShim(): string { return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[args.indexOf("--permission-mode") + 1] !== "dontAsk" || args[args.indexOf("--tools") + 1] !== "Read,Glob,Grep") process.exit(2);
const session = args[args.indexOf("--session-id") + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", session_id: session, result: "CLAUDE_READ_ONLY_OK" }));
`; }
function codexShim(): string { return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[args.indexOf("--ask-for-approval") + 1] !== "never" || args[args.indexOf("--sandbox") + 1] !== "workspace-write") process.exit(2);
writeFileSync("native-release.txt", "codex workspace write\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_release" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CODEX_WORKSPACE_WRITE_OK" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
`; }
