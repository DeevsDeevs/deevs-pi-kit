import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedRuntimeClientError } from "../extensions/runtime/client.ts";
import { HOSTED_PARTICIPANT_ENTRY, HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";
import { deriveTargetKey } from "../extensions/runtime/service/registration.ts";

const roots: string[] = [];
const servers: Server[] = [];
const originalBootstrap = process.env.PI_RUNTIME_COLLABORATE;
const originalHerdrEnv = process.env.HERDR_ENV;
const originalHerdrWorkspace = process.env.HERDR_WORKSPACE_ID;
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalBootstrap === undefined) delete process.env.PI_RUNTIME_COLLABORATE;
	else process.env.PI_RUNTIME_COLLABORATE = originalBootstrap;
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
			confirm: async () => true,
		},
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session_1", getBranch: () => branch },
	};
	const integration = new HostedRuntimeIntegration(pi as never, runtimeRoot);
	return { root, runtimeRoot, projectRoot, requests, entries, notifications, execCalls, pi, ctx, integration, setExec(handler: typeof execHandler) { execHandler = handler; } };
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
	const match = /^exec pi --approve --session '([^']+)'$/.exec(args[3] ?? "");
	if (!match) throw new Error("unexpected pane-run command");
	return match[1]!;
}

describe("hosted collaborator Pi integration", () => {
	it("starts Runtime in a dedicated no-focus services workspace", async () => {
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
		await test.integration.command("start", test.ctx as never);
		expect(test.execCalls.find((call) => call.args[0] === "workspace" && call.args[1] === "create")?.args).toEqual(["workspace", "create", "--cwd", test.runtimeRoot, "--label", "pi-kit-services", "--no-focus"]);
		expect(test.execCalls).toContainEqual({ command: "herdr", args: ["tab", "rename", "w9:t1", "pi-kit-runtime"] });
		const launched = test.execCalls.find((call) => call.args[0] === "pane" && call.args[1] === "run")!;
		expect(launched.args.slice(0, 3)).toEqual(["pane", "run", "w9:p1"]);
		expect(launched.args[3]).toContain(`--root '${test.runtimeRoot}'`);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && (call.args[1] === "create" || call.args[1] === "focus"))).toBe(false);
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

	it("restores held identity, sends exact tool mail, and never auto-takes over rotation", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		let rotated = false;
		const test = await setup((request) => {
			if (request.method === "participant.get") return rotated ? { ...mainParticipant, holderTargetKey: "target_other" } : mainParticipant;
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false, transitioned: true };
			if (request.method === "participant.list") return { participants: [mainParticipant, fableParticipant] };
			if (request.method === "mailbox.send") return { eventId: "event_mail", sequence: 4 };
			return baseResponse(request);
		}, [identity]);
		await test.integration.sessionStart(test.ctx as never);
		expect(await test.integration.sendMail("fable", "Review this.", "tool_call_1", test.ctx as never)).toEqual({ eventId: "event_mail", sequence: 4, recipient: "review/fable" });
		const send = test.requests.find((request) => request.method === "mailbox.send")!;
		expect(send.params).toMatchObject({ recipientParticipantKey: "participant_fable", body: "Review this." });
		expect(String(send.params.sendId)).toMatch(/^send_[a-f0-9]{32}$/);
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
				childTargetKey = deriveTargetKey(test.projectRoot, JSON.parse(readFileSync(sessionFile, "utf8")).id);
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
		expect(JSON.parse(readFileSync(sessionFile, "utf8"))).toMatchObject({ type: "session", version: 3, cwd: test.projectRoot });
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
		expect(readdirSync(join(failed.runtimeRoot, "collaborator-sessions"))).toEqual([]);
		await failed.integration.sessionShutdown();
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
				childTargetKey = deriveTargetKey(test.projectRoot, JSON.parse(readFileSync(sessionFile, "utf8")).id);
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		test.ctx.isProjectTrusted = () => false;
		await expect(test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).rejects.toThrow("trusted project");
		test.ctx.isProjectTrusted = () => true;
		test.ctx.ui.confirm = async () => false;
		expect(await test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).toEqual({ started: false, participant: "review/fable" });
		expect(test.requests.some((request) => request.method === "participant.acquire")).toBe(false);
		expect(test.execCalls.some((call) => call.args[0] === "tab")).toBe(false);

		test.ctx.ui.confirm = async () => true;
		expect(await test.integration.startCollaborator({ protocol: "review", callerParticipantId: "main", participantId: "fable" }, test.ctx as never)).toMatchObject({ started: true, participant: "review/fable", paneId: "w1:p9" });
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

	it("stands down an exact live collaborator only after trusted confirmation", async () => {
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [fableParticipant] };
			if (request.method === "participant.stand_down_confirmed") return { ...fableParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
			return baseResponse(request);
		});
		await test.integration.sessionStart(test.ctx as never);
		test.ctx.ui.confirm = async () => false;
		expect(await test.integration.standDownCollaborator({ protocol: "review", participantId: "fable" }, test.ctx as never)).toEqual({ participant: "review/fable", outcome: "declined" });
		expect(test.requests.some((request) => request.method === "participant.stand_down_confirmed")).toBe(false);
		test.ctx.ui.confirm = async () => true;
		expect(await test.integration.standDownCollaborator({ protocol: "review", participantId: "fable" }, test.ctx as never)).toEqual({ participant: "review/fable", outcome: "stood_down" });
		expect(test.requests.find((request) => request.method === "participant.stand_down_confirmed")?.params).toMatchObject({ participantKey: "participant_fable", expectedGeneration: "lease_fable", confirmed: true });
		await test.integration.sessionShutdown();
	});

	it("stops an exact collaborator only after trusted confirmation", async () => {
		const vacant = { ...fableParticipant, state: "vacant", generation: "lease_vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down", previousGeneration: "lease_fable" } };
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: [fableParticipant] };
			if (request.method === "participant.stop_confirmed") return { participant: vacant, outcome: "stopped" };
			return baseResponse(request);
		});
		await test.integration.sessionStart(test.ctx as never);
		test.ctx.ui.confirm = async () => false;
		expect(await test.integration.stopCollaborator({ protocol: "review", participantId: "fable" }, test.ctx as never)).toEqual({ participant: "review/fable", outcome: "declined" });
		expect(test.requests.some((request) => request.method === "participant.stop_confirmed")).toBe(false);
		test.ctx.ui.confirm = async () => true;
		expect(await test.integration.stopCollaborator({ protocol: "review", participantId: "fable" }, test.ctx as never)).toEqual({ participant: "review/fable", outcome: "stopped" });
		expect(test.requests.find((request) => request.method === "participant.stop_confirmed")?.params).toMatchObject({ participantKey: "participant_fable", expectedGeneration: "lease_fable", confirmed: true });
		await test.integration.sessionShutdown();
	});

	it("reports an already-vacant collaborator without asking for confirmation", async () => {
		const vacant = { ...fableParticipant, state: "vacant", holderTargetKey: undefined, holderLive: false, lastTransition: { cause: "stand_down" } };
		const test = await setup((request) => request.method === "participant.list" ? { participants: [vacant] } : baseResponse(request));
		test.ctx.ui.confirm = async () => { throw new Error("confirmation must not run"); };
		await test.integration.sessionStart(test.ctx as never);
		expect(await test.integration.standDownCollaborator({ protocol: "review", participantId: "fable" }, test.ctx as never)).toEqual({ participant: "review/fable", outcome: "already_vacant" });
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
