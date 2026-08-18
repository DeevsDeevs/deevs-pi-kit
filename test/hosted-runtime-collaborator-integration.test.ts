import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_PARTICIPANT_ENTRY, HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";

const roots: string[] = [];
const servers: Server[] = [];
const originalBootstrap = process.env.PI_RUNTIME_COLLABORATE;
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalBootstrap === undefined) delete process.env.PI_RUNTIME_COLLABORATE;
	else process.env.PI_RUNTIME_COLLABORATE = originalBootstrap;
});

interface Request { method: string; params: Record<string, unknown> }

async function setup(respond: (request: Request) => unknown, branch: unknown[] = []) {
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
				socket.end(`${JSON.stringify({ v: 1, id: request.id, ok: false, error: { code: "conflict", message: error instanceof Error ? error.message : String(error) } })}\n`);
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

describe("hosted collaborator Pi integration", () => {
	it("bootstraps identity from Herdr env and persists exact acquisition", async () => {
		process.env.PI_RUNTIME_COLLABORATE = "review:main";
		const test = await setup((request) => {
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false };
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
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false };
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
			return baseResponse(request);
		}, [identity]);
		await second.integration.sessionStart(second.ctx as never);
		expect(second.requests.some((request) => request.method === "participant.acquire" || request.method === "participant.takeover")).toBe(false);
		expect(second.notifications.some((notice) => notice.message.includes("explicit acquire or takeover"))).toBe(true);
		await second.integration.sessionShutdown();
	});

	it("starts a no-focus Pi collaborator with env bootstrap and cleans up failed tabs", async () => {
		let listCount = 0;
		const test = await setup((request) => {
			if (request.method === "participant.list") return { participants: listCount++ === 0 ? [mainParticipant] : [mainParticipant, fableParticipant] };
			return baseResponse(request);
		});
		test.setExec(async (_command, args) => {
			if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9" } } }), stderr: "", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await test.integration.sessionStart(test.ctx as never);
		await test.integration.command("collaborator-start review fable", test.ctx as never);
		expect(test.execCalls.find((call) => call.args[0] === "tab" && call.args[1] === "create")?.args).toContain("PI_RUNTIME_COLLABORATE=review:fable");
		expect(test.execCalls.some((call) => call.args[0] === "agent" && call.args[1] === "start" && call.args.includes("pi"))).toBe(true);
		expect(test.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close")).toBe(false);
		await test.integration.sessionShutdown();

		const failed = await setup((request) => request.method === "participant.list" ? { participants: [mainParticipant] } : baseResponse(request));
		failed.setExec(async (_command, args) => {
			if (args[0] === "pane") return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false };
			if (args[0] === "tab" && args[1] === "create") return { code: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p8" }, tab: { tab_id: "w1:t8" } } }), stderr: "", killed: false };
			if (args[0] === "agent") return { code: 1, stdout: "", stderr: "failed", killed: false };
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		});
		await failed.integration.sessionStart(failed.ctx as never);
		await failed.integration.command("collaborator-start review fable", failed.ctx as never);
		expect(failed.execCalls.some((call) => call.args[0] === "tab" && call.args[1] === "close" && call.args.includes("w1:t8"))).toBe(true);
		await failed.integration.sessionShutdown();
	});

	it("requires UI confirmation before takeover and persists stand-down disposition", async () => {
		const identity = { type: "custom", customType: HOSTED_PARTICIPANT_ENTRY, data: { version: 1, protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" } };
		const test = await setup((request) => {
			if (request.method === "participant.get") return mainParticipant;
			if (request.method === "participant.acquire") return { participant: mainParticipant, revived: false };
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
