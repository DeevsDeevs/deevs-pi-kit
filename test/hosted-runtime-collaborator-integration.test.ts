import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBuiltinAgents } from "../extensions/subagents/agents.ts";
import { HostedRuntimeClientError } from "../extensions/runtime/client.ts";
import { CollaboratorAutoStore } from "../extensions/runtime/auto-mode.ts";
import { HOSTED_AUTO_LIFECYCLE_ENTRY, HOSTED_BRIDGE_REQUEST_ENTRY, HOSTED_COLLABORATOR_PROFILE_ENTRY, HOSTED_COLLABORATOR_WORKSPACE_ENTRY, HOSTED_MANAGED_COLLABORATOR_ENTRY, HOSTED_PARTICIPANT_ENTRY, HOSTED_WORKSPACE_REQUEST_ENTRY, HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";
import { deriveTargetKey } from "../extensions/runtime/service/registration.ts";

const roots: string[] = [];
const servers: Server[] = [];
const originalBootstrap = process.env.PI_RUNTIME_COLLABORATE;
const originalWorkspaceLaunch = process.env.PI_RUNTIME_WORKSPACE_LAUNCH;
const originalHerdrEnv = process.env.HERDR_ENV;
const originalHerdrWorkspace = process.env.HERDR_WORKSPACE_ID;
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalBootstrap === undefined) delete process.env.PI_RUNTIME_COLLABORATE;
	else process.env.PI_RUNTIME_COLLABORATE = originalBootstrap;
	if (originalWorkspaceLaunch === undefined) delete process.env.PI_RUNTIME_WORKSPACE_LAUNCH;
	else process.env.PI_RUNTIME_WORKSPACE_LAUNCH = originalWorkspaceLaunch;
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
	if (originalHerdrWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
	else process.env.HERDR_WORKSPACE_ID = originalHerdrWorkspace;
});

interface Request { method: string; params: Record<string, unknown> }

async function setup(respond: (request: Request) => unknown, branch: unknown[] = []) {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	const root = mkdtempSync(join(tmpdir(), "hosted-collaborator-integration-"));
	roots.push(root);
	const runtimeRoot = join(root, "runtime");
	const projectRoot = join(root, "project");
	const sessionFile = join(root, "session.jsonl");
	mkdirSync(runtimeRoot);
	mkdirSync(projectRoot);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
	const requests: Request[] = [];
	const server = createServer((socket) => {
		let buffered = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffered.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
			requests.push({ method: request.method, params: request.params });
			try {
				const result = respond(request);
				socket.end(`${JSON.stringify({ v: 1, id: request.id, ok: true, result })}\n`);
			} catch (error) {
				socket.end(`${JSON.stringify({ v: 1, id: request.id, ok: false, error: { code: error instanceof HostedRuntimeClientError ? error.code : "conflict", message: error instanceof Error ? error.message : String(error) } })}\n`);
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(runtimeRoot, "runtime.sock"), resolve); });
	const entries: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];
	let execHandler = async (command: string, args: string[]) => ({ code: 0, stdout: command === "herdr" && args[0] === "pane" ? JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }) : "{}", stderr: "", killed: false });
	const pi = {
		appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
		exec: async (command: string, args: string[]) => { execCalls.push({ command, args }); return execHandler(command, args); },
	};
	const ctx = {
		cwd: projectRoot,
		hasUI: true,
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus(key: string, value: string | undefined) { statuses.push({ key, value }); },
			confirm: async () => true,
		},
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session_1", getBranch: () => branch },
	};
	const integration = new HostedRuntimeIntegration(pi as never, runtimeRoot);
	return { root, runtimeRoot, projectRoot, requests, entries, notifications, statuses, execCalls, pi, ctx, integration, setExec(handler: typeof execHandler) { execHandler = handler; } };
}

const registration = { targetKey: "target_main", registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 99_999, hostStateChangeSeq: 1, paneId: "w1:p1" };
const mainParticipant = { participantKey: "participant_main", projectRoot: "/project", protocol: "review", participantId: "main", state: "held", generation: "lease_main", holderTargetKey: "target_main", holderLive: true, queued: { pending: 0, claimed: 0 }, lastTransition: { cause: "acquire" } };
const fableParticipant = { participantKey: "participant_fable", projectRoot: "/project", protocol: "review", participantId: "fable", state: "held", generation: "lease_fable", holderTargetKey: "target_fable", holderLive: true, queued: { pending: 0, claimed: 0 }, lastTransition: { cause: "acquire" } };

function baseResponse(request: Request): unknown {
	if (request.method === "pi.register" || request.method === "pi.heartbeat") return registration;
	if (request.method === "pi.unregister") return { unregistered: true };
	throw new Error(`unexpected ${request.method}`);
}

function paneRunSessionFile(args: string[]): string {
	const match = /^exec pi --approve --session '([^']+)'(?: --tools '[^']+')?(?: --model '[^']+')?$/.exec(args[3] ?? "");
	if (!match) throw new Error("unexpected pane-run command");
	return match[1]!;
}

function paneRunModel(args: string[]): string | undefined {
	return / --model '([^']+)'$/.exec(args[3] ?? "")?.[1];
}

function sessionHeader(sessionFile: string): { id: string } {
	return JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]!);
}

describe("hosted collaborator Pi integration", () => {
	it("starts Runtime once in a dedicated no-focus services workspace across concurrent callers", async () => {
		const test = await setup((request) => request.method === "participant.list" ? { participants: [] } : baseResponse(request));
		await test.integration.sessionStart(test.ctx as never);
		const integration = test.integration as unknown as { client: { socketPath: string; hello(): Promise<unknown>; call(method: string, params: unknown): Promise<unknown> } };
		const client = integration.client;
		let helloCount = 0;
		Object.defineProperty(integration, "client", { value: {
			socketPath: client.socketPath,
			call: client.call.bind(client),
			hello: async () => {
				if (helloCount++ === 0) throw new HostedRuntimeClientError("unavailable", "missing");
				return { runtimeId: "runtime_1", epoch: "epoch_1" };
			},
		} });
		test.setExec(async (_command, args) => {
			if (args[0] === "workspace" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" }, tab: { tab_id: "w9:t1" } } }), stderr: "", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await Promise.all([test.integration.command("start", test.ctx as never), test.integration.command("start", test.ctx as never)]);
		const workspaceCreates = test.execCalls.filter((call) => call.args[0] === "workspace" && call.args[1] === "create");
		expect(workspaceCreates).toHaveLength(1);
		expect(workspaceCreates[0]?.args).toEqual(["workspace", "create", "--cwd", test.runtimeRoot, "--label", "pi-kit-services", "--no-focus"]);
		expect(test.execCalls).toContainEqual({ command: "herdr", args: ["tab", "rename", "w9:t1", "pi-kit-runtime"] });
		const launched = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
		expect(launched.args.slice(0, 3)).toEqual(["pane", "run", "w9:p1"]);
		expect(launched.args[3]).toContain(`--root '${test.runtimeRoot}'`);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && (call.args[1] === "create" || call.args[1] === "focus"))).toBe(false);
		await test.integration.sessionShutdown();
	});

	it("discovers Runtime after starting without a socket", async () => {
		const test = await setup(baseResponse);
		const integration = test.integration as unknown as { client: { socketPath: string }; heartbeatTimer?: NodeJS.Timeout; heartbeat(): Promise<void> };
		const socketPath = integration.client.socketPath;
		rmSync(socketPath, { force: true });
		const calls: string[] = [];
		Object.defineProperty(integration, "client", { value: {
			socketPath,
			hello: async () => ({ runtimeId: "runtime_1", epoch: "epoch_1" }),
			call: async (method: string) => {
				calls.push(method);
				if (method === "pi.register" || method === "pi.heartbeat") return registration;
				if (method === "pi.unregister") return { unregistered: true };
				throw new Error(`unexpected ${method}`);
			},
		} });
		await test.integration.sessionStart(test.ctx as never);
		expect(integration.heartbeatTimer).toBeDefined();
		writeFileSync(socketPath, "available");
		await integration.heartbeat();
		expect(calls).toContain("pi.register");
		await test.integration.sessionShutdown();
	});

	it("lists durable collaborator state from Runtime instead of session memory", async () => {
		const test = await setup((request) => request.method === "participant.list"
			? { participants: [mainParticipant, { ...fableParticipant, state: "vacant", holderTargetKey: undefined, holderLive: false }] }
			: baseResponse(request));
		await test.integration.sessionStart(test.ctx as never);
		expect(await test.integration.listCollaborators(test.ctx as never)).toMatchObject([
			{ protocol: "review", participantId: "main", state: "held", holderLive: true },
			{ protocol: "review", participantId: "fable", state: "vacant", holderLive: false },
		]);
		await test.integration.sessionShutdown();
	});

	it("repairs a missing local participant key before holder stand-down", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", disposition: "held" } };
		const test = await setup((request) => {
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: false };
			if (request.method === "participant.list") return { participants: [mainParticipant] };
			if (request.method === "participant.stand_down") return { ...mainParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		test.integration.sessionTree(test.ctx as never);
		await test.integration.command("stand-down", test.ctx as never);
		expect(test.requests.find((request) => request.method === "participant.stand_down")?.params).toMatchObject({ participantKey: "participant_main" });
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { disposition: "vacant", generation: "lease_vacant" } });
		await test.integration.sessionShutdown();
	});

	it("bootstraps identity from Herdr env and persists exact acquisition", async () => {
		process.env.PI_RUNTIME_COLLABORATE = "review:main";
		const test = await setup((request) => {
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			return baseResponse(request);
		});
		await test.integration.sessionStart(test.ctx as never);
		expect(test.requests.some((request) => request.method === "participant.acquire" && request.params.protocol === "review" && request.params.participantId === "main")).toBe(true);
		expect(test.entries).toContainEqual({ customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } });
		await test.integration.sessionShutdown();
	});

	it("consumes and strips a workspace launch token before persisting exact workspace participant binding", async () => {
		process.env.PI_RUNTIME_COLLABORATE = "review:writer";
		process.env.PI_RUNTIME_WORKSPACE_LAUNCH = `workspace_launch_workspace_test.${"z".repeat(43)}`;
		const workspaceEntry = { type: "custom", customType: HOSTED_COLLABORATOR_WORKSPACE_ENTRY, data: {} as Record<string, unknown> };
		const managed = { type: "custom", customType: HOSTED_MANAGED_COLLABORATOR_ENTRY, data: { version: 1, managed: true } };
		const profile = { type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: { version: 2, driver: "pi", profile: "workspace-write" } };
		const writer = { ...mainParticipant, participantId: "writer", participantKey: "participant_writer", generation: "lease_writer", holderTargetKey: "target_workspace" };
		let consumedBeforeReply = false;
		const test = await setup((request) => {
			if (request.method === "workspace.pi.register") { consumedBeforeReply = true; throw new HostedRuntimeClientError("unavailable", "registration reply lost after consume"); }
			if (request.method === "workspace.pi.reconnect" && consumedBeforeReply) return { ...registration, targetKey: "target_workspace", workspaceId: "workspace_test", projectRoot: test.projectRoot, workspaceRoot: test.projectRoot, participantKey: "participant_writer", holderGeneration: "lease_writer", participantGeneration: "lease_writer", participantState: "held", protocol: "review", participantId: "writer" };
			if (request.method === "participant.get") return writer;
			return baseResponse(request);
		}, [managed, workspaceEntry, profile]);
		workspaceEntry.data = { version: 1, workspaceId: "workspace_test", projectRoot: test.projectRoot, workspaceRoot: test.projectRoot };
		await test.integration.sessionStart(test.ctx as never);
		expect(test.requests.find((request) => request.method === "workspace.pi.register")?.params).toMatchObject({ launchToken: `workspace_launch_workspace_test.${"z".repeat(43)}`, piSessionId: "session_1" });
		expect(test.requests.some((request) => request.method === "workspace.pi.reconnect")).toBe(true);
		expect(process.env.PI_RUNTIME_WORKSPACE_LAUNCH).toBeUndefined();
		expect(test.entries).toContainEqual({ customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "writer", participantKey: "participant_writer", generation: "lease_writer", disposition: "held" } });
		expect(test.integration.guardCollaboratorTool("write", { path: "file.ts" }, test.projectRoot)).toBeUndefined();
		expect(test.integration.guardCollaboratorTool("write", { path: "../outside.ts" }, test.projectRoot)).toMatchObject({ block: true });
		symlinkSync(join(test.root, "outside-workspace"), join(test.projectRoot, "dangling-workspace"));
		expect(test.integration.guardCollaboratorTool("write", { path: "dangling-workspace" }, test.projectRoot)).toMatchObject({ block: true });
		await test.integration.sessionShutdown();
	});

	it("restores held identity, sends ordered collaborator messages, and never auto-takes over rotation", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let rotated = false;
		let sequence = 3;
		const test = await setup((request) => {
			if (request.method === "participant.get") return rotated ? { ...mainParticipant, holderTargetKey: "target_other" } : mainParticipant;
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			if (request.method === "participant.list") return { participants: [mainParticipant, fableParticipant] };
			if (request.method === "mailbox.send") {
				if (request.params.body === "Fail.") throw new HostedRuntimeClientError("unavailable", "send failed");
				return { eventId: `event_${++sequence}`, sequence };
			}
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.sendCollaboratorMessages([{ participantId: "other/fable", body: "Wrong protocol." }], "tool_call_0", test.ctx as never)).rejects.toThrow("does not match current protocol");
		expect(await test.integration.sendCollaboratorMessages([
			{ participantId: "review/fable", body: "First." },
			{ participantId: "fable", body: "Second." },
			{ participantId: "fable", body: "Fail." },
		], "tool_call_1", test.ctx as never)).toEqual([
			{ eventId: "event_4", sequence: 4, recipient: "review/fable", status: "sent" },
			{ eventId: "event_5", sequence: 5, recipient: "review/fable", status: "sent" },
			{ recipient: "review/fable", status: "failed", error: "send failed" },
		]);
		const sends = test.requests.filter((request) => request.method === "mailbox.send");
		expect(sends.map((send) => send.params.body)).toEqual(["First.", "Second.", "Fail."]);
		expect(sends.map((send) => send.params)).toEqual(sends.map((send) => expect.objectContaining({ senderParticipantKey: "participant_main", expectedSenderGeneration: "lease_main", recipientParticipantKey: "participant_fable", body: send.params.body })));
		expect(new Set(sends.map((send) => String(send.params.sendId))).size).toBe(3);
		expect(sends.map((send) => String(send.params.sendId))).toEqual(sends.map(() => expect.stringMatching(/^send_[a-f0-9]{32}$/)));
		await test.integration.sessionShutdown();

		rotated = true;
		const second = await setup((request) => {
			if (request.method === "participant.get") return { ...mainParticipant, holderTargetKey: "target_other" };
			if (request.method === "participant.list") return { participants: [{ ...mainParticipant, holderTargetKey: "target_other" }] };
			return baseResponse(request);
		}, [identity]);
		await second.integration.sessionStart(second.ctx as never);
		expect(second.requests.some((request) => request.method === "participant.acquire" || request.method === "participant.takeover")).toBe(false);
		expect(second.notifications.some((notice) => notice.message.includes("explicit acquire or takeover"))).toBe(true);
		expect(second.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { disposition: "vacant" } });
		await expect(second.integration.startCollaborator({ participantId: "other" }, second.ctx as never)).rejects.toThrow("held by another Pi target");
		await second.integration.sessionShutdown();
	});

	it("reconciles a remotely stood-down local identity on heartbeat", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let vacant = false;
		const test = await setup((request) => {
			if (request.method === "participant.get") return vacant ? { ...mainParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } } : mainParticipant;
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		vacant = true;
		await (test.integration as unknown as { heartbeat: () => Promise<void> }).heartbeat();
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { disposition: "vacant", generation: "lease_vacant" } });
		await test.integration.sessionShutdown();
	});

	it("persists a vacant correction when a held transcript identity is absent from Runtime", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const test = await setup((request) => {
			if (request.method === "participant.get") throw new HostedRuntimeClientError("not_found", "missing");
			if (request.method === "participant.list") return { participants: [] };
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		expect(test.entries.at(-1)).toEqual({ customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", disposition: "vacant" } });
		let confirmation = "";
		test.ctx.ui.confirm = async (...args: unknown[]) => { confirmation = String(args[1]); return false; };
		expect(await test.integration.startCollaborator({ participantId: "fable" }, test.ctx as never)).toEqual({ started: false, participant: "review/fable" });
		expect(confirmation).toContain("Reacquire review/main and start review/fable");
		await test.integration.sessionShutdown();
	});

	it("fails closed when a restored participant key names a different identity", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const restored = await setup((request) => request.method === "participant.get" ? { ...mainParticipant, protocol: "other" } : baseResponse(request), [identity]);
		await restored.integration.sessionStart(restored.ctx as never);
		expect(restored.entries.at(-1)).toEqual({ customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", disposition: "vacant" } });
		expect(restored.notifications.some((notice) => notice.message.includes("identity key does not match"))).toBe(true);
		await restored.integration.sessionShutdown();

		let starting = false;
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: [{ ...mainParticipant, protocol: "other" }] };
			return baseResponse(request);
		}, [identity]);
		test.ctx.ui.confirm = async () => { starting = true; return true; };
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "fable" }, test.ctx as never)).rejects.toThrow("identity key does not match");
		expect(starting).toBe(false);
		expect(test.entries.at(-1)).toEqual({ customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", disposition: "vacant" } });
		await test.integration.sessionShutdown();
	});

	it("rejects concurrent model-driven collaborator starts", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: [mainParticipant] };
			return baseResponse(request);
		}, [identity]);
		let resolveConfirmation!: (value: boolean) => void;
		let confirmationStarted!: () => void;
		const started = new Promise<void>((resolve) => { confirmationStarted = resolve; });
		test.ctx.ui.confirm = () => {
			confirmationStarted();
			return new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
		};
		await test.integration.sessionStart(test.ctx as never);
		const first = test.integration.startCollaborator({ participantId: "fable" }, test.ctx as never);
		await started;
		await expect(test.integration.startCollaborator({ participantId: "other" }, test.ctx as never)).rejects.toThrow("already in progress");
		resolveConfirmation(false);
		expect(await first).toEqual({ started: false, participant: "review/fable" });
		await test.integration.sessionShutdown();
	});

	it("lets typed global Auto mode start and stop without confirmations and records an audit", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let childTargetKey = "";
		let stopped = false;
		let workspaceRoot = "";
		let projectRoot = "";
		const child = { ...fableParticipant, holderTargetKey: "", holderLive: true };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: childTargetKey && !stopped ? [mainParticipant, { ...child, holderTargetKey: childTargetKey }] : stopped ? [mainParticipant, { ...child, state: "vacant", generation: "lease_stopped", holderLive: false, holderTargetKey: undefined }] : [mainParticipant] };
			if (request.method === "participant.stop_confirmed") {
				stopped = true;
				return { participant: { ...child, state: "vacant", generation: "lease_stopped", holderLive: false, holderTargetKey: undefined }, outcome: "stopped" };
			}
			if (request.method === "workspace.launch.create") {
				childTargetKey = deriveTargetKey(projectRoot, String(request.params.piSessionId));
				return { workspace: { workspaceId: "workspace_fable", projectRoot, worktreePath: workspaceRoot, targetKey: childTargetKey }, launchToken: `workspace_launch_workspace_fable.${"x".repeat(43)}` };
			}
			if (request.method === "workspace.launch.bind") return { state: "bound" };
			if (request.method === "workspace.cleanup") return { workspace: { state: "cleaned" } };
			return baseResponse(request);
		}, [identity]);
		projectRoot = test.projectRoot;
		workspaceRoot = join(test.root, "workspace-fable");
		mkdirSync(workspaceRoot);
		new CollaboratorAutoStore(test.runtimeRoot).set(true);
		let confirmations = 0;
		test.ctx.hasUI = false;
		test.ctx.ui.confirm = async () => { confirmations++; return false; };
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9", terminal_id: "term_9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "get") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9", terminal_id: "term_9", cwd: workspaceRoot } } }), stderr: "", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		expect(test.statuses.at(-1)).toEqual({ key: "runtime-auto", value: "AUTO" });
		expect(await test.integration.manageCollaborators({ action: "start", protocol: "review", participants: [{ participantId: "fable", persona: "architect", profile: "workspace-write" }] }, test.ctx as never)).toEqual([expect.objectContaining({ participant: "review/fable", status: "started" })]);
		const tabCreate = test.execCalls.find((call) => call.args[0] === "tab" && call.args[1] === "create")!;
		expect(tabCreate.args[tabCreate.args.indexOf("--cwd") + 1]).toBe(workspaceRoot);
		expect(tabCreate.args).toContain(`PI_RUNTIME_WORKSPACE_LAUNCH=workspace_launch_workspace_fable.${"x".repeat(43)}`);
		const launched = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
		const workspaceEntry = readFileSync(paneRunSessionFile(launched.args), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.customType === HOSTED_COLLABORATOR_WORKSPACE_ENTRY);
		expect(workspaceEntry?.data).toEqual({ version: 1, workspaceId: "workspace_fable", projectRoot, workspaceRoot });
		expect(await test.integration.manageCollaborators({ action: "stop", protocol: "review", participants: [{ participantId: "fable" }] }, test.ctx as never)).toEqual([{ participant: "review/fable", status: "stopped" }]);
		expect(confirmations).toBe(0);
		expect(test.entries.filter((entry) => entry.customType === HOSTED_AUTO_LIFECYCLE_ENTRY).map((entry) => (entry.data as { phase: string }).phase)).toEqual(["authorized", "settled", "authorized", "settled"]);
		await test.integration.sessionShutdown();
		expect(test.statuses.at(-1)).toEqual({ key: "runtime-auto", value: undefined });
	});

	it("defaults an omitted Auto launch profile to enforced read-only", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let childTargetKey = "";
		const child = { ...fableParticipant, participantId: "bounded", participantKey: "participant_bounded" };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: childTargetKey ? [mainParticipant, { ...child, holderTargetKey: childTargetKey }] : [mainParticipant] };
			return baseResponse(request);
		}, [identity]);
		new CollaboratorAutoStore(test.runtimeRoot).set(true);
		test.ctx.hasUI = false;
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") childTargetKey = deriveTargetKey(test.projectRoot, sessionHeader(paneRunSessionFile(args)).id);
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "bounded" }, test.ctx as never)).resolves.toMatchObject({ started: true });
		const launch = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
		expect(launch.args[3]).toContain("--tools 'read,grep,find,ls,safe_diff,collaborator_list,collaborator_send,chain_save,chain_load,chain_context'");
		expect(launch.args[3]).not.toContain(",edit,write");
		const profile = readFileSync(paneRunSessionFile(launch.args), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.customType === HOSTED_COLLABORATOR_PROFILE_ENTRY)?.data;
		expect(profile).toEqual({ version: 2, driver: "pi", profile: "read-only" });
		await test.integration.sessionShutdown();
	});

	it("launches native drivers through owner-private bridge configs after one confirmation", async () => {
		const holders = new Map<string, string>();
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [mainParticipant, ...[...holders].map(([participantId, targetKey]) => ({ ...fableParticipant, participantId, participantKey: `participant_${participantId}`, holderTargetKey: targetKey }))] };
			if (request.method === "bridge.launch.create") {
				const launchId = String(request.params.launchId);
				return { launchId, targetKey: `target_${launchId}`, holderGeneration: `lease_${launchId}`, expiresAt: Date.now() + 30_000, launchToken: `bridge_launch_${launchId}.${"x".repeat(43)}`, reconnectToken: "y".repeat(43), herdr: { paneId: "w1:p9", terminalId: "term_native", tabId: "w1:t9", workspaceId: "w1" } };
			}
			return baseResponse(request);
		});
		let confirmations = 0;
		test.ctx.ui.confirm = async () => { confirmations++; return true; };
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9", terminal_id: "term_native" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") {
				const request = test.requests.filter((item) => item.method === "bridge.launch.create").at(-1)!;
				holders.set(String(request.params.participantId), `target_${request.params.launchId}`);
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		for (const driver of ["claude-code", "codex"] as const) await expect(test.integration.startCollaborator({ participantId: driver, protocol: "review", callerParticipantId: "main", driver }, test.ctx as never)).resolves.toMatchObject({ started: true, paneId: "w1:p9" });
		expect(confirmations).toBe(2);
		const tabs = test.execCalls.filter((call) => call.args[0] === "tab" && call.args[1] === "create");
		expect(tabs).toHaveLength(2);
		expect(tabs.every((call) => call.args.includes("--no-focus"))).toBe(true);
		const runs = test.execCalls.filter((call) => call.args[0] === "pane" && call.args[1] === "run");
		expect(runs.every((call) => call.args[3]?.includes("bridge-runner/main.ts") && !call.args[3]?.includes("exec pi"))).toBe(true);
		const configs = readdirSync(join(test.runtimeRoot, "bridges")).map((bridgeId) => JSON.parse(readFileSync(join(test.runtimeRoot, "bridges", bridgeId, "config.v1.json"), "utf8")));
		expect(configs.map((config) => config.driver).sort()).toEqual(["claude-code", "codex"]);
		expect(configs.every((config) => config.profile === "read-only" && typeof config.configurationHash === "string" && config.launchToken)).toBe(true);
		await test.integration.sessionShutdown();
	});

	it("replaces an exact stood-down native process before restarting its participant", async () => {
		const vacant = { ...fableParticipant, participantId: "native", participantKey: "participant_native", state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
		let launched = false;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [mainParticipant, ...(launched ? [{ ...vacant, state: "held", generation: "lease_native", holderTargetKey: "target_native", holderLive: true, lastTransition: { cause: "acquire" } }] : [vacant])] };
			if (request.method === "participant.stop_confirmed") return { participant: vacant, outcome: "stopped" };
			if (request.method === "bridge.launch.create") return { launchId: request.params.launchId, targetKey: "target_native", holderGeneration: "lease_native", expiresAt: Date.now() + 30_000, launchToken: `bridge_launch_${request.params.launchId}.${"x".repeat(43)}`, reconnectToken: "y".repeat(43), herdr: { paneId: "w1:p9", terminalId: "term_native", tabId: "w1:t9", workspaceId: "w1" } };
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9", terminal_id: "term_native" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") launched = true;
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "native", protocol: "review", callerParticipantId: "main", driver: "codex" }, test.ctx as never)).resolves.toMatchObject({ started: true });
		const methods = test.requests.map((request) => request.method);
		expect(methods.indexOf("participant.stop_confirmed")).toBeLessThan(methods.indexOf("bridge.launch.create"));
		expect(test.requests.find((request) => request.method === "participant.stop_confirmed")?.params).toMatchObject({ participantKey: "participant_native", expectedGeneration: "lease_vacant", confirmed: true });
		await test.integration.sessionShutdown();
	});

	it("recovers an ambiguous native workspace response before creating host resources", async () => {
		let createAttempts = 0;
		let recoveryAttempts = 0;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [mainParticipant] };
			if (request.method === "workspace.bridge.create") { if (++createAttempts === 1) throw new HostedRuntimeClientError("unavailable", "native create response lost"); return { workspace: { workspaceId: "workspace_native" }, recoveryRequired: true }; }
			if (request.method === "workspace.launch.recover") { recoveryAttempts++; return { workspace: { state: "cleaned" } }; }
			return baseResponse(request);
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "native", protocol: "review", callerParticipantId: "main", driver: "codex", profile: "workspace-write" }, test.ctx as never)).rejects.toThrow("native create response lost");
		expect(createAttempts).toBe(2);
		expect(recoveryAttempts).toBe(1);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "create")).toBe(false);
		expect(test.entries.filter((entry) => entry.customType === HOSTED_WORKSPACE_REQUEST_ENTRY).map((entry) => (entry.data as { status: string }).status)).toEqual(["pending", "recovered"]);
		await test.integration.sessionShutdown();
	});

	it("recovers ambiguous native bridge authority and closes its exact empty tab", async () => {
		let createAttempts = 0;
		let recoveryAttempts = 0;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [mainParticipant] };
			if (request.method === "bridge.launch.create") { createAttempts++; throw new HostedRuntimeClientError(createAttempts === 1 ? "unavailable" : "conflict", createAttempts === 1 ? "bridge response lost" : "explicit recovery required"); }
			if (request.method === "bridge.launch.recover") { recoveryAttempts++; return { launch: { status: "cancelled" } }; }
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9", terminal_id: "term_native" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "native", protocol: "review", callerParticipantId: "main", driver: "claude-code" }, test.ctx as never)).rejects.toThrow("bridge response lost");
		expect(createAttempts).toBe(2);
		expect(recoveryAttempts).toBe(2);
		expect(test.execCalls).toContainEqual({ command: "herdr", args: ["tab", "close", "w1:t9"] });
		expect(test.entries.filter((entry) => entry.customType === HOSTED_BRIDGE_REQUEST_ENTRY).map((entry) => (entry.data as { status: string }).status)).toEqual(["pending", "recovered"]);
		await test.integration.sessionShutdown();
	});

	it("durably records and retries exact recovery after an ambiguous workspace create response", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let recoveryAttempts = 0;
		let createAttempts = 0;
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: [mainParticipant] };
			if (request.method === "workspace.launch.create") { if (++createAttempts === 1) throw new HostedRuntimeClientError("unavailable", "create response lost"); return { workspace: { workspaceId: "workspace_pending" }, recoveryRequired: true }; }
			if (request.method === "workspace.launch.recover") { if (++recoveryAttempts < 3) throw new HostedRuntimeClientError("conflict", "create still settling"); return { workspace: { state: "cleaned" } }; }
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "writer", profile: "workspace-write" }, test.ctx as never)).rejects.toThrow("create response lost");
		expect(createAttempts).toBe(2);
		expect(recoveryAttempts).toBe(3);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "create")).toBe(false);
		expect(test.entries.filter((entry) => entry.customType === HOSTED_WORKSPACE_REQUEST_ENTRY).map((entry) => (entry.data as { status: string }).status)).toEqual(["pending", "recovered"]);
		await test.integration.sessionShutdown();
	});

	it("does not delegate global Auto authority to a Runtime-managed child", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "child", participantKey: "participant_child", generation: "lease_child", disposition: "held" } };
		const managed = { type: "custom", customType: HOSTED_MANAGED_COLLABORATOR_ENTRY, data: { version: 1, managed: true } };
		const childParticipant = { ...mainParticipant, participantId: "child", participantKey: "participant_child", generation: "lease_child" };
		const test = await setup((request) => request.method === "participant.get" ? childParticipant : request.method === "participant.list" ? { participants: [childParticipant] } : baseResponse(request), [managed, identity]);
		new CollaboratorAutoStore(test.runtimeRoot).set(true);
		test.ctx.hasUI = false;
		await test.integration.sessionStart(test.ctx as never);
		expect(test.statuses.at(-1)).toEqual({ key: "runtime-auto", value: undefined });
		await expect(test.integration.startCollaborator({ participantId: "other" }, test.ctx as never)).rejects.toThrow("interactive Pi session or enabled Runtime Auto mode");
		await test.integration.sessionShutdown();
	});

	it("fails closed on corrupt Auto state and enforces the twelve-live cap", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const corrupt = await setup((request) => request.method === "participant.get" ? mainParticipant : request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request), [identity]);
		writeFileSync(join(corrupt.runtimeRoot, "auto-mode.v1.json"), "{broken");
		corrupt.ctx.hasUI = false;
		await corrupt.integration.sessionStart(corrupt.ctx as never);
		expect(corrupt.integration.toggleAutoMode(corrupt.ctx as never).enabled).toBe(false);
		await expect(corrupt.integration.startCollaborator({ participantId: "fable" }, corrupt.ctx as never)).rejects.toThrow("interactive Pi session or enabled Runtime Auto mode");
		expect(corrupt.notifications.some((notice) => notice.message.includes("enforced MANUAL"))).toBe(true);
		expect(corrupt.notifications.some((notice) => notice.message.includes("recover explicitly"))).toBe(true);
		expect(corrupt.statuses.at(-1)).toEqual({ key: "runtime-auto", value: "MANUAL" });
		await corrupt.integration.sessionShutdown();

		const live = Array.from({ length: 12 }, (_, index) => ({ ...fableParticipant, participantKey: `participant_${index}`, participantId: `live-${index}`, holderTargetKey: `target_${index}` }));
		const capped = await setup((request) => request.method === "participant.get" ? mainParticipant : request.method === "participant.list" ? { participants: [mainParticipant, ...live] } : baseResponse(request), [identity]);
		new CollaboratorAutoStore(capped.runtimeRoot).set(true);
		capped.ctx.hasUI = false;
		await capped.integration.sessionStart(capped.ctx as never);
		await expect(capped.integration.startCollaborator({ participantId: "extra" }, capped.ctx as never)).rejects.toThrow("at most 12 live collaborators");
		expect(capped.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "create")).toBe(false);
		await capped.integration.sessionShutdown();
	});

	it("configures the trusted Shift+Tab Auto shortcut and requests reload", async () => {
		const test = await setup(baseResponse);
		let reloaded = false;
		(test.ctx as typeof test.ctx & { reload(): Promise<void> }).reload = async () => { reloaded = true; };
		await test.integration.command("auto setup", test.ctx as never);
		expect(reloaded).toBe(true);
		expect(new CollaboratorAutoStore(test.runtimeRoot).shortcutConfigured()).toBe(true);
		expect(JSON.parse(readFileSync(join(test.root, "keybindings.json"), "utf8"))["app.thinking.cycle"]).toEqual(["ctrl+shift+t"]);
	});

	it("starts an exact batch after one confirmation with concurrency capped at four", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const children = new Map<string, string>();
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: [mainParticipant, ...[...children].map(([participantId, holderTargetKey]) => ({ ...fableParticipant, participantKey: `participant_${participantId}`, participantId, holderTargetKey }))] };
			return baseResponse(request);
		}, [identity]);
		let paneNumber = 8;
		let activeRuns = 0;
		let maxActiveRuns = 0;
		const paneParticipants = new Map<string, string>();
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") {
				const paneId = `w1:p${++paneNumber}`;
				paneParticipants.set(paneId, String(args[args.indexOf("--env") + 1]).split(":")[1]!);
				return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: paneId }, tab: { tab_id: `w1:t${paneNumber}` } } }), stderr: "", killed: false };
			}
			if (args[0] === "pane" && args[1] === "run") {
				activeRuns++;
				maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
				await new Promise((resolve) => setTimeout(resolve, 10));
				const sessionFile = paneRunSessionFile(args);
				children.set(paneParticipants.get(args[2]!)!, deriveTargetKey(test.projectRoot, sessionHeader(sessionFile).id));
				activeRuns--;
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		let confirmations = 0;
		let confirmationText = "";
		test.ctx.ui.confirm = async (...args: unknown[]) => { confirmations++; confirmationText = String(args[1]); return true; };
		await test.integration.sessionStart(test.ctx as never);
		const candidates = [
			{ participantId: "one", model: "openai-codex/gpt-5.6-terra:high" },
			{ participantId: "two", persona: "architect", profile: "read-only" as const },
			{ participantId: "three" },
			{ participantId: "four" },
			{ participantId: "five" },
		];
		const results = await test.integration.manageCollaborators({ action: "start", participants: candidates }, test.ctx as never);
		expect(confirmations).toBe(1);
		expect(confirmationText).toContain("start 5 collaborators with concurrency up to 4");
		expect(confirmationText).toContain("driver pi, model pi default, persona architect, profile read-only");
		expect(confirmationText).toContain("review/three — driver pi, model pi default, persona none, profile none");
		expect(confirmationText).toContain(`project ${test.projectRoot}, isolated worktree no`);
		expect(results.map((result) => result.status)).toEqual(["started", "started", "started", "started", "started"]);
		expect(maxActiveRuns).toBe(4);
		const tabCreates = test.execCalls.filter((call) => call.args[0] === "tab" && call.args[1] === "create");
		expect(tabCreates).toHaveLength(5);
		const launches = test.execCalls.filter((call) => call.args[0] === "pane" && call.args[1] === "run");
		const materializedProfiles = launches.flatMap((call) => readFileSync(paneRunSessionFile(call.args), "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line).data));
		expect(materializedProfiles).toContainEqual(expect.objectContaining({ version: 2, driver: "pi", profile: "read-only", persona: expect.objectContaining({ name: "architect" }) }));
		expect(launches.every((call) => !call.args[3]?.includes(",edit,write'"))).toBe(true);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "focus")).toBe(false);
		expect(test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")?.args[3]).toContain("--model 'openai-codex/gpt-5.6-terra:high'");
		await test.integration.sessionShutdown();
	});

	it("keeps the start guard until every cancelled batch worker settles", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: [mainParticipant] };
			return baseResponse(request);
		}, [identity]);
		let releaseWorkers!: () => void;
		const barrier = new Promise<void>((resolve) => { releaseWorkers = resolve; });
		let startedWorkers = 0;
		let fourStarted!: () => void;
		const started = new Promise<void>((resolve) => { fourStarted = resolve; });
		const internal = test.integration as unknown as { launchCollaborator(...args: unknown[]): Promise<string> };
		internal.launchCollaborator = async (...args: unknown[]) => {
			startedWorkers++;
			if (startedWorkers === 4) fourStarted();
			await barrier;
			if ((args[4] as AbortSignal).aborted) throw new Error("cancelled worker");
			return `pane_${startedWorkers}`;
		};
		await test.integration.sessionStart(test.ctx as never);
		const controller = new AbortController();
		const batch = test.integration.startCollaborators(["one", "two", "three", "four", "five"].map((participantId) => ({ participantId })), test.ctx as never, controller.signal);
		await started;
		controller.abort();
		await expect(test.integration.startCollaborator({ participantId: "other" }, test.ctx as never)).rejects.toThrow("already in progress");
		releaseWorkers();
		expect((await batch).map((result) => result.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled", "cancelled"]);
		expect(startedWorkers).toBe(4);
		await test.integration.sessionShutdown();
	});

	it("starts a trusted persona read-only by default and rejects unknown personas before confirmation", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let childTargetKey = "";
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: childTargetKey ? [mainParticipant, { ...fableParticipant, holderTargetKey: childTargetKey }] : [mainParticipant] };
			return baseResponse(request);
		}, [identity]);
		let confirmation = "";
		test.ctx.ui.confirm = async (...args: unknown[]) => { confirmation = String(args[1]); return true; };
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") childTargetKey = deriveTargetKey(test.projectRoot, sessionHeader(paneRunSessionFile(args)).id);
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.startCollaborator({ participantId: "fable", persona: "architect" }, test.ctx as never);
		expect(confirmation).toContain("driver pi");
		expect(confirmation).toContain("persona architect");
		expect(confirmation).toContain("profile read-only");
		expect(confirmation).toContain(`project ${test.projectRoot}, isolated worktree no`);
		const created = test.execCalls.find((call) => call.args[0] === "tab" && call.args[1] === "create")!;
		expect(created.args.some((argument) => argument.startsWith("PI_RUNTIME_COLLABORATOR_PERSONA="))).toBe(false);
		const launched = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
		expect(launched.args[3]).toContain("--tools 'read,grep,find,ls,safe_diff,collaborator_list,collaborator_send,chain_save,chain_load,chain_context'");
		const sessionEntries = readFileSync(paneRunSessionFile(launched.args), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(sessionEntries[1]).toMatchObject({ type: "custom", customType: HOSTED_MANAGED_COLLABORATOR_ENTRY, data: { version: 1, managed: true }, parentId: null });
		expect(sessionEntries[2]).toMatchObject({ type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: { version: 2, driver: "pi", profile: "read-only", persona: { name: "architect" } }, parentId: sessionEntries[1].id });
		expect(sessionEntries[2].data.persona.promptHash).toBe(createHash("sha256").update(sessionEntries[2].data.persona.prompt).digest("hex"));

		let invalidConfirmed = false;
		test.ctx.ui.confirm = async () => { invalidConfirmed = true; return true; };
		await expect(test.integration.startCollaborator({ participantId: "other", persona: "missing" }, test.ctx as never)).rejects.toThrow("Unknown or disabled collaborator persona missing");
		expect(invalidConfirmed).toBe(false);
		await test.integration.sessionShutdown();
	});

	it("starts every enabled built-in persona as a read-only collaborator", async () => {
		for (const persona of loadBuiltinAgents().filter((candidate) => !candidate.disabled)) {
			let childTargetKey = "";
			const child = { ...fableParticipant, participantId: persona.name, participantKey: `participant_${persona.name}` };
			const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
			const test = await setup((request) => {
				if (request.method === "participant.get") return mainParticipant;
				if (request.method === "participant.list") return { participants: childTargetKey ? [mainParticipant, { ...child, holderTargetKey: childTargetKey }] : [mainParticipant] };
				return baseResponse(request);
			}, [identity]);
			test.setExec(async (_command, args) => {
				if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
				if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
				if (args[0] === "pane" && args[1] === "run") childTargetKey = deriveTargetKey(test.projectRoot, sessionHeader(paneRunSessionFile(args)).id);
				return { code: 0, stdout: "{}", stderr: "", killed: false };
			});
			await test.integration.sessionStart(test.ctx as never);
			await expect(test.integration.startCollaborator({ participantId: persona.name, persona: persona.name }, test.ctx as never)).resolves.toBeDefined();
			const launch = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
			const profile = readFileSync(paneRunSessionFile(launch.args), "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line)).find((entry) => entry.customType === HOSTED_COLLABORATOR_PROFILE_ENTRY)?.data;
			expect(profile).toMatchObject({ profile: "read-only", persona: { name: persona.name } });
			if (persona.name === "reviewer") {
				expect(profile.persona.prompt).toContain("When `review_report` is available");
				expect(launch.args[3]).not.toContain("review_report");
			}
			await test.integration.sessionShutdown();
		}
	});

	it("restores a persisted persona prompt and enforces its read-only profile", async () => {
		const prompt = "You are the persisted architect.";
		const profile = { version: 1, profile: "read-only", persona: { name: "architect", prompt, promptHash: createHash("sha256").update(prompt).digest("hex") } };
		const restored = await setup(baseResponse, [{ type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: profile }]);
		await restored.integration.sessionStart(restored.ctx as never);
		const resumed = await restored.integration.beforeAgentStart("RESUMED SYSTEM", restored.ctx as never);
		expect(resumed?.systemPrompt).toContain("RESUMED SYSTEM\n\n# Collaborator persona: architect\n\nYou are the persisted architect.");
		expect(restored.integration.guardCollaboratorTool("read", { path: "." }, restored.projectRoot)).toBeUndefined();
		expect(restored.integration.guardCollaboratorTool("collaborator_send", undefined, restored.projectRoot)).toBeUndefined();
		expect(restored.integration.guardCollaboratorTool("bash", { command: "pwd" }, restored.projectRoot)).toMatchObject({ block: true });
		await restored.integration.sessionShutdown();

		const malformed = await setup(baseResponse, [{ type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: { ...profile, persona: { ...profile.persona, promptHash: "bad" } } }]);
		await malformed.integration.sessionStart(malformed.ctx as never);
		expect(malformed.notifications.some((notice) => notice.message.includes("enforced read-only recovery mode"))).toBe(true);
		expect(malformed.integration.guardCollaboratorTool("edit", { path: "file.ts" }, malformed.projectRoot)).toMatchObject({ block: true });
		await malformed.integration.sessionShutdown();

		const mismatchedDriver = await setup(baseResponse, [{ type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: { version: 2, driver: "codex", profile: "workspace-write" } }]);
		await mismatchedDriver.integration.sessionStart(mismatchedDriver.ctx as never);
		expect(mismatchedDriver.notifications.some((notice) => notice.message.includes("enforced read-only recovery mode"))).toBe(true);
		expect(mismatchedDriver.integration.guardCollaboratorTool("edit", { path: "file.ts" }, mismatchedDriver.projectRoot)).toMatchObject({ block: true });
		await mismatchedDriver.integration.sessionShutdown();

		const writable = await setup(baseResponse, [{ type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: { version: 1, profile: "workspace-write" } }]);
		await writable.integration.sessionStart(writable.ctx as never);
		expect(writable.integration.guardCollaboratorTool("write", { path: "file.ts" }, writable.projectRoot)).toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
		expect(writable.integration.guardCollaboratorTool("bash", { command: "pwd" }, writable.projectRoot)).toMatchObject({ block: true });
		await writable.integration.sessionShutdown();

		const managed = { type: "custom", customType: HOSTED_MANAGED_COLLABORATOR_ENTRY, data: { version: 1, managed: true } };
		const launch = { type: "custom", customType: HOSTED_COLLABORATOR_PROFILE_ENTRY, data: { version: 2, driver: "pi", profile: "workspace-write" } };
		const legacyManagedWriter = await setup(baseResponse, [managed, launch]);
		await legacyManagedWriter.integration.sessionStart(legacyManagedWriter.ctx as never);
		expect(legacyManagedWriter.integration.guardCollaboratorTool("write", { path: "file.ts" }, legacyManagedWriter.projectRoot)).toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
		await legacyManagedWriter.integration.sessionShutdown();

		const workspaceEntry = { type: "custom", customType: HOSTED_COLLABORATOR_WORKSPACE_ENTRY, data: {} as Record<string, unknown> };
		const isolatedWriter = await setup(baseResponse, [managed, workspaceEntry, launch]);
		workspaceEntry.data = { version: 1, workspaceId: "workspace_test", projectRoot: isolatedWriter.projectRoot, workspaceRoot: isolatedWriter.projectRoot };
		await isolatedWriter.integration.sessionStart(isolatedWriter.ctx as never);
		expect(isolatedWriter.integration.guardCollaboratorTool("write", { path: "file.ts" }, isolatedWriter.projectRoot)).toMatchObject({ block: true, reason: expect.stringContaining("read-only") });
		await isolatedWriter.integration.sessionShutdown();
	});

	it("starts a no-focus Pi collaborator with a materialized session and cleans up failed launches", async () => {
		let listCount = 0;
		let childTargetKey = "";
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: listCount++ === 0 ? [mainParticipant] : [mainParticipant, { ...fableParticipant, holderTargetKey: childTargetKey }] };
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") {
				const sessionFile = paneRunSessionFile(args);
				childTargetKey = deriveTargetKey(test.projectRoot, sessionHeader(sessionFile).id);
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.command("collaborator-start review fable", test.ctx as never);
		expect(test.execCalls.find((call) => call.args[0] === "tab" && call.args[1] === "create")?.args).toContain("PI_RUNTIME_COLLABORATE=review:fable");
		const started = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
		const sessionFile = paneRunSessionFile(started.args);
		expect(started.args).toEqual(["pane", "run", "w1:p9", `exec pi --approve --session '${sessionFile}'`]);
		expect(test.execCalls.some((call) => call.args[0] === "agent" && call.args[1] === "start")).toBe(false);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "focus")).toBe(false);
		expect(sessionHeader(sessionFile).id).toEqual(expect.any(String));
		expect(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!)).toMatchObject({ type: "session", version: 3, cwd: test.projectRoot });
		expect(readFileSync(sessionFile, "utf8")).toContain(HOSTED_MANAGED_COLLABORATOR_ENTRY);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close")).toBe(false);
		await test.integration.sessionShutdown();

		const failed = await setup((request) => request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request));
		failed.setExec(async (_command, args) => {
			if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: {}, tab: { tab_id: "w1:t8" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "close") return { code: 1, stdout: "", stderr: "close failed", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await failed.integration.sessionStart(failed.ctx as never);
		await failed.integration.command("collaborator-start review fable", failed.ctx as never);
		expect(failed.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close" && call.args.includes("w1:t8"))).toBe(true);
		expect(failed.notifications.some((notice) => notice.message.includes("could not clean up failed collaborator tab"))).toBe(true);
		expect(readdirSync(join(failed.runtimeRoot, "collaborator-sessions"))).toHaveLength(1);
		await failed.integration.sessionShutdown();
	});

	it("closes the exact root pane when Herdr omits the created tab ID", async () => {
		const test = await setup((request) => request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request));
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" } } }), stderr: "", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.command("collaborator-start review fable", test.ctx as never);
		expect(test.execCalls).toContainEqual({ command: "herdr", args: ["pane", "close", "w1:p9"] });
		expect(readdirSync(join(test.runtimeRoot, "collaborator-sessions"))).toEqual([]);
		await test.integration.sessionShutdown();
	});

	it("preserves recovery evidence when Herdr returns no authoritative resource ID", async () => {
		const test = await setup((request) => request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request));
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: {} }), stderr: "", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.command("collaborator-start review fable", test.ctx as never);
		expect(test.execCalls.some((call) => (call.args[0] === "tab" || call.args[0] === "pane") && call.args[1] === "close")).toBe(false);
		expect(readdirSync(join(test.runtimeRoot, "collaborator-sessions"))).toHaveLength(1);
		expect(test.notifications.some((notice) => notice.message.includes("without returning an authoritative tab or pane ID") && notice.message.includes("preserved for recovery"))).toBe(true);
		await test.integration.sessionShutdown();
	});

	it("serializes the trusted collaborator-start command through the cross-session lock", async () => {
		const test = await setup(baseResponse);
		let releaseLaunch!: () => void;
		const held = new Promise<void>((resolve) => { releaseLaunch = resolve; });
		let launchEntered!: () => void;
		const entered = new Promise<void>((resolve) => { launchEntered = resolve; });
		const internal = test.integration as unknown as { launchCollaborator(...args: unknown[]): Promise<string> };
		internal.launchCollaborator = async () => { launchEntered(); await held; return "w1:p9"; };
		await test.integration.sessionStart(test.ctx as never);
		const command = test.integration.command("collaborator-start review fable", test.ctx as never);
		await entered;
		expect(existsSync(join(test.runtimeRoot, "auto-start.lock"))).toBe(true);
		await expect(new CollaboratorAutoStore(test.runtimeRoot).acquireStartLock()).rejects.toThrow("already in progress");
		releaseLaunch();
		await command;
		expect(existsSync(join(test.runtimeRoot, "auto-start.lock"))).toBe(false);
		await test.integration.sessionShutdown();
	});

	it("retains the command start lock and evidence when dispatch is ambiguous", async () => {
		const test = await setup((request) => request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request));
		let childSessionFile = "";
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") {
				childSessionFile = paneRunSessionFile(args);
				return { code: 1, stdout: "", stderr: "reply lost", killed: false };
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.command("collaborator-start review fable", test.ctx as never);
		expect(existsSync(childSessionFile)).toBe(true);
		expect(existsSync(join(test.runtimeRoot, "auto-start.lock"))).toBe(true);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close")).toBe(false);
		expect(test.notifications.some((notice) => notice.message.includes("tab and session were preserved"))).toBe(true);
		await test.integration.sessionShutdown();
	});

	it("preserves child resources and caller when pane-run dispatch is ambiguous", async () => {
		let listCount = 0;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: listCount++ === 0 ? [] : [mainParticipant] };
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			return baseResponse(request);
		});
		let childSessionFile = "";
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") {
				childSessionFile = paneRunSessionFile(args);
				return { code: 1, stdout: "", stderr: "reply lost", killed: false };
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).rejects.toThrow("tab and session were preserved");
		expect(test.requests.some((request) => request.method === "participant.stand_down")).toBe(false);
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { participantId: "main", disposition: "held" } });
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close")).toBe(false);
		expect(existsSync(childSessionFile)).toBe(true);
		await test.integration.sessionShutdown();
	});

	it("terminates an ambiguous Auto start before releasing capacity", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const test = await setup((request) => request.method === "participant.get" ? mainParticipant : request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request), [identity]);
		new CollaboratorAutoStore(test.runtimeRoot).set(true);
		test.ctx.hasUI = false;
		let childSessionFile = "";
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") {
				childSessionFile = paneRunSessionFile(args);
				return { code: 1, stdout: "", stderr: "reply lost", killed: false };
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "fable" }, test.ctx as never)).rejects.toThrow("dispatch Pi collaborator startup");
		expect(test.execCalls).toContainEqual({ command: "herdr", args: ["tab", "close", "w1:t9"] });
		expect(existsSync(childSessionFile)).toBe(false);
		expect(existsSync(join(test.runtimeRoot, "auto-start.lock"))).toBe(false);
		await test.integration.sessionShutdown();
	});

	it("preserves a started child and caller when identity observation becomes ambiguous", async () => {
		let listCount = 0;
		const test = await setup((request) => {
			if (request.method === "participant.list") {
				listCount++;
				if (listCount === 1) return { participants: [] };
				if (listCount === 2) return { participants: [mainParticipant] };
				throw new HostedRuntimeClientError("unavailable", "transient list failure");
			}
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			return baseResponse(request);
		});
		let childSessionFile = "";
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") childSessionFile = paneRunSessionFile(args);
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).rejects.toThrow("tab and session were preserved");
		expect(test.requests.some((request) => request.method === "participant.stand_down")).toBe(false);
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { participantId: "main", disposition: "held" } });
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close")).toBe(false);
		expect(existsSync(childSessionFile)).toBe(true);
		await test.integration.sessionShutdown();
	});

	it("cancels model-driven starts before confirmation or dispatch", async () => {
		const beforeConfirmation = await setup((request) => baseResponse(request));
		let confirmed = false;
		beforeConfirmation.ctx.ui.confirm = async () => { confirmed = true; return true; };
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await beforeConfirmation.integration.sessionStart(beforeConfirmation.ctx as never);
		await expect(beforeConfirmation.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, beforeConfirmation.ctx as never, alreadyAborted.signal)).rejects.toThrow("cancelled");
		expect(confirmed).toBe(false);
		expect(beforeConfirmation.requests.some((request) => request.method === "participant.list" || request.method === "participant.acquire")).toBe(false);
		await beforeConfirmation.integration.sessionShutdown();

		const beforeDispatch = await setup((request) => {
			if (request.method === "participant.list") return { participants: [] };
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			if (request.method === "participant.stand_down") return { ...mainParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
			return baseResponse(request);
		});
		const abortBeforeDispatch = new AbortController();
		const appendEntry = beforeDispatch.pi.appendEntry;
		beforeDispatch.pi.appendEntry = (customType: string, data: unknown) => {
			appendEntry(customType, data);
			if ((data as { disposition?: string }).disposition === "held") abortBeforeDispatch.abort();
		};
		await beforeDispatch.integration.sessionStart(beforeDispatch.ctx as never);
		await expect(beforeDispatch.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, beforeDispatch.ctx as never, abortBeforeDispatch.signal)).rejects.toThrow("cancelled");
		expect(beforeDispatch.requests.some((request) => request.method === "participant.stand_down")).toBe(true);
		expect(beforeDispatch.execCalls.some((call) => call.args[0] === "tab")).toBe(false);
		await beforeDispatch.integration.sessionShutdown();
	});

	it("revalidates an existing caller generation after confirmation before launch dispatch", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let rotated = false;
		const vacantFable = { ...fableParticipant, state: "vacant", holderTargetKey: undefined, holderLive: false };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.list") return { participants: [rotated ? { ...mainParticipant, generation: "lease_rotated", holderTargetKey: "target_other" } : mainParticipant, vacantFable] };
			return baseResponse(request);
		}, [identity]);
		test.ctx.ui.confirm = async () => { rotated = true; return true; };
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "fable" }, test.ctx as never)).rejects.toThrow("changed while launch confirmation was pending");
		expect(test.execCalls.some((call) => call.args[0] === "tab")).toBe(false);
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { participantId: "main", generation: "lease_rotated", disposition: "vacant" } });
		await test.integration.sessionShutdown();
	});

	it("requires trust and confirmation before the model acquires and starts collaborators", async () => {
		let listCount = 0;
		let childTargetKey = "";
		let launchedModel: string | undefined;
		const test = await setup((request) => {
			if (request.method === "participant.list") {
				listCount++;
				if (listCount <= 2) return { participants: [] };
				if (listCount === 3) return { participants: [mainParticipant] };
				return { participants: [mainParticipant, { ...fableParticipant, holderTargetKey: childTargetKey }] };
			}
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane" && args[1] === "current") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			if (args[0] === "pane" && args[1] === "run") {
				const sessionFile = paneRunSessionFile(args);
				launchedModel = paneRunModel(args);
				childTargetKey = deriveTargetKey(test.projectRoot, sessionHeader(sessionFile).id);
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable", model: "terra; touch /tmp/nope" }, test.ctx as never)).rejects.toThrow("model must match");
		test.ctx.isProjectTrusted = () => false;
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).rejects.toThrow("trusted project");
		test.ctx.isProjectTrusted = () => true;
		test.ctx.ui.confirm = async () => false;
		expect(await test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).toEqual({ started: false, participant: "review/fable" });
		expect(test.requests.some((request) => request.method === "participant.acquire")).toBe(false);
		expect(test.execCalls.some((call) => call.args[0] === "tab")).toBe(false);

		test.ctx.ui.confirm = async () => true;
		expect(await test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable", model: "openai-codex/gpt-5.6-terra" }, test.ctx as never)).toMatchObject({ started: true, participant: "review/fable", paneId: "w1:p9" });
		expect(launchedModel).toBe("openai-codex/gpt-5.6-terra");
		expect(test.requests.some((request) => request.method === "participant.acquire" && request.params.participantId === "main")).toBe(true);
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { participantId: "main", disposition: "held" } });
		await test.integration.sessionShutdown();
	});

	it("reacquires a remembered vacant caller and rolls it back when launch fails", async () => {
		const vacantIdentity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_vacant", disposition: "vacant" } };
		const vacantMain = { ...mainParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
		let acquired = false;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [acquired ? mainParticipant : vacantMain] };
			if (request.method === "participant.acquire") { acquired = true; return { participant: mainParticipant, revived: false, transitioned: true }; }
			if (request.method === "participant.stand_down") return { ...vacantMain, generation: "lease_rollback" };
			return baseResponse(request);
		}, [vacantIdentity]);
		test.setExec(async (_command, args) => args[0] === "tab" && args[1] === "create"
			? { code: 1, stdout: "", stderr: "create failed", killed: false }
			: args[0] === "pane"
				? { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false }
				: { code: 0, stdout: "{}", stderr: "", killed: false });
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ participantId: "fable" }, test.ctx as never)).rejects.toThrow("could not create");
		expect(test.requests.some((request) => request.method === "participant.acquire" && request.params.participantId === "main")).toBe(true);
		expect(test.requests.some((request) => request.method === "participant.stand_down" && request.params.expectedGeneration === "lease_main")).toBe(true);
		expect(test.entries.at(-1)).toMatchObject({ data: { participantId: "main", disposition: "vacant", generation: "lease_rollback" } });
		await test.integration.sessionShutdown();
	});

	it("stands down a newly acquired caller when model-driven child launch fails", async () => {
		let acquired = false;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: acquired ? [mainParticipant] : [] };
			if (request.method === "participant.acquire") { acquired = true; return { participant: mainParticipant, revived: false, transitioned: true }; }
			if (request.method === "participant.stand_down") return { ...mainParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 1, stdout: "", stderr: "create failed", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).rejects.toThrow("could not create");
		expect(test.requests.some((request) => request.method === "participant.stand_down" && request.params.participantKey === "participant_main" && request.params.expectedGeneration === "lease_main")).toBe(true);
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { participantId: "main", disposition: "vacant", generation: "lease_vacant" } });
		expect(readdirSync(join(test.runtimeRoot, "collaborator-sessions"))).toEqual([]);
		await test.integration.sessionShutdown();
	});

	it("does not roll back a caller acquired concurrently by the same target", async () => {
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: request.params.registrationId ? [mainParticipant] : [] };
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: false };
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 1, stdout: "", stderr: "create failed", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).rejects.toThrow("could not create");
		expect(test.requests.some((request) => request.method === "participant.stand_down")).toBe(false);
		await test.integration.sessionShutdown();
	});

	it("stands down a batch after one trusted confirmation and preserves input order", async () => {
		const vacant = { ...fableParticipant, participantKey: "participant_vacant", participantId: "vacant", state: "vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [fableParticipant, vacant] };
			if (request.method === "participant.stand_down_confirmed") return { ...fableParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
			return baseResponse(request);
		});
		await test.integration.sessionStart(test.ctx as never);
		let confirmations = 0;
		let confirmed = false;
		test.ctx.ui.confirm = async () => { confirmations++; return confirmed; };
		expect(await test.integration.manageCollaborators({ action: "stand_down", protocol: "review", participants: [{ participantId: "fable" }] }, test.ctx as never)).toEqual([{ participant: "review/fable", status: "declined" }]);
		expect(test.requests.some((request) => request.method === "participant.stand_down_confirmed")).toBe(false);
		confirmed = true;
		expect(await test.integration.manageCollaborators({ action: "stand_down", protocol: "review", participants: [{ participantId: "vacant" }, { participantId: "fable" }] }, test.ctx as never)).toEqual([
			{ participant: "review/vacant", status: "already_vacant" },
			{ participant: "review/fable", status: "stood_down" },
		]);
		expect(confirmations).toBe(2);
		expect(test.requests.filter((request) => request.method === "participant.stand_down_confirmed")).toHaveLength(1);
		expect(test.requests.find((request) => request.method === "participant.stand_down_confirmed")?.params).toMatchObject({ participantKey: "participant_fable", expectedGeneration: "lease_fable", confirmed: true });
		await test.integration.sessionShutdown();
	});

	it("stops a batch after one trusted confirmation", async () => {
		const other = { ...fableParticipant, participantKey: "participant_other", participantId: "other", generation: "lease_other" };
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [fableParticipant, other] };
			if (request.method === "participant.stop_confirmed") {
				const participant = request.params.participantKey === "participant_fable" ? fableParticipant : other;
				return { participant: { ...participant, state: "vacant", holderTargetKey: undefined, holderLive: false }, outcome: "stopped" };
			}
			return baseResponse(request);
		});
		await test.integration.sessionStart(test.ctx as never);
		let confirmations = 0;
		test.ctx.ui.confirm = async () => { confirmations++; return true; };
		expect(await test.integration.manageCollaborators({ action: "stop", protocol: "review", participants: [{ participantId: "fable" }, { participantId: "other" }] }, test.ctx as never)).toEqual([
			{ participant: "review/fable", status: "stopped" },
			{ participant: "review/other", status: "stopped" },
		]);
		expect(confirmations).toBe(1);
		expect(test.requests.filter((request) => request.method === "participant.stop_confirmed")).toHaveLength(2);
		await test.integration.sessionShutdown();
	});

	it("reports an all-vacant stand-down batch without asking for confirmation", async () => {
		const vacant = { ...fableParticipant, state: "vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
		const test = await setup((request) => request.method === "participant.list" ? { participants: [vacant] } : baseResponse(request));
		test.ctx.ui.confirm = async () => { throw new Error("confirmation must not run"); };
		await test.integration.sessionStart(test.ctx as never);
		expect(await test.integration.manageCollaborators({ action: "stand_down", protocol: "review", participants: [{ participantId: "fable" }] }, test.ctx as never)).toEqual([{ participant: "review/fable", status: "already_vacant" }]);
		await test.integration.sessionShutdown();
	});

	it("requires UI confirmation before takeover and persists stand-down disposition", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			if (request.method === "participant.list") return { participants: [mainParticipant, fableParticipant] };
			if (request.method === "participant.takeover") return { ...fableParticipant, holderTargetKey: "target_main", generation: "lease_takeover", lastTransition: { cause: "takeover" } };
			if (request.method === "participant.stand_down") return { ...mainParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		test.ctx.ui.confirm = async () => false;
		await test.integration.command("leave", test.ctx as never);
		await test.integration.command("takeover review fable", test.ctx as never);
		expect(test.requests.some((request) => request.method === "participant.release" || request.method === "participant.takeover")).toBe(false);
		test.ctx.ui.confirm = async () => true;
		await test.integration.command("stand-down", test.ctx as never);
		expect(test.entries.at(-1)).toMatchObject({ customType: HOSTED_PARTICIPANT_ENTRY, data: { disposition: "vacant", generation: "lease_vacant" } });
		await test.integration.command("takeover review fable", test.ctx as never);
		expect(test.requests.find((request) => request.method === "participant.takeover")?.params).toMatchObject({ expectedGeneration: "lease_fable", confirmed: true });
		expect(test.entries.at(-1)).toMatchObject({ data: { participantId: "fable", disposition: "held", generation: "lease_takeover" } });
		await test.integration.sessionShutdown();
	});

	it("does not revive an ended identity when confirmation is declined", async () => {
		const ended = { ...fableParticipant, state: "ended", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "release" } };
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [ended] };
			return baseResponse(request);
		});
		test.ctx.ui.confirm = async () => false;
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.command("collaborate review fable", test.ctx as never);
		expect(test.requests.some((request) => request.method === "participant.acquire")).toBe(false);
		expect(test.entries).toHaveLength(0);
		await test.integration.sessionShutdown();
	});
});
