import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTED_RUNTIME_MESSAGE, HostedRuntimeIntegration } from "../extensions/runtime/hosted-integration.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hosted Pi wake admission", () => {
	it("restores receipts, honors user priority, admits once, acknowledges at message_start, and releases enqueue failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-admission-"));
		roots.push(root);
		const runtimeRoot = join(root, "runtime");
		const projectRoot = join(root, "project");
		const sessionFile = join(root, "session.jsonl");
		mkdirSync(runtimeRoot);
		mkdirSync(projectRoot);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot })}\n`);
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = createServer((socket) => {
			let buffered = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				buffered += chunk;
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(buffered.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
				requests.push({ method: request.method, params: request.params });
				let result: unknown = { settled: true };
				if (request.method === "pi.register") result = { targetKey: "pi_target", registrationId: "reg_1", registrationKey: "key_1", leaseUntil: 99_999, hostStateChangeSeq: 1, paneId: "w1:p1" };
				if (request.method === "wake.accept") {
					const wakeId = String(request.params.wakeId);
					result = {
						claimId: `claim_${wakeId}`,
						leaseUntil: 99_999,
						status: "active",
						events: wakeId === "wake_mail"
							? [{ version: 1, eventId: "evt_mail", type: "mailbox.message", summary: "message from fable", payload: { body: "Please inspect the race.", sendId: "send_mail", senderParticipantKey: "participant_fable", recipientParticipantKey: "participant_main" } }]
							: [{ version: 1, eventId: `evt_${wakeId}`, type: "filesystem.created", summary: `new file: ${wakeId}.md`, payload: { path: join(projectRoot, `${wakeId}.md`) } }],
					};
				}
				if (request.method === "inbox.claim") result = {
					claimId: "claim_focused",
					leaseUntil: 99_999,
					status: "active",
					events: [{ version: 1, eventId: "evt_focused", type: "mailbox.message", summary: "message from reviewer", payload: { body: "Focused-safe reply.", sendId: "send_focused", senderParticipantKey: "participant_reviewer", recipientParticipantKey: "participant_main" } }],
				};
				socket.end(`${JSON.stringify({ v: 1, id: request.id, ok: true, result })}\n`);
			});
		});
		servers.push(server);
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(runtimeRoot, "runtime.sock"), resolve); });

		const messages: Array<Record<string, unknown>> = [];
		let sendFails = false;
		const pi = {
			exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", terminal_id: "term_1" } } }), stderr: "", killed: false }),
			sendMessage(message: Record<string, unknown>) {
				if (sendFails) throw new Error("enqueue failed");
				messages.push(message);
			},
		};
		let pending = false;
		const historical = { type: "custom_message", customType: HOSTED_RUNTIME_MESSAGE, details: { version: 1, claimId: "claim_old", eventIds: ["evt_old"] } };
		let branch: unknown[] = [historical];
		const ctx = {
			cwd: projectRoot,
			isProjectTrusted: () => true,
			isIdle: () => true,
			hasPendingMessages: () => pending,
			sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "session_1", getBranch: () => branch },
		};
		const integration = new HostedRuntimeIntegration(pi as never, runtimeRoot);
		await integration.sessionStart(ctx as never);
		expect(requests.find((request) => request.method === "pi.register")?.params.admittedClaims).toEqual([{ claimId: "claim_old", eventIds: ["evt_old"] }]);
		branch = [];
		integration.sessionTree(ctx as never);
		expect((integration as unknown as { admittedClaims: Map<string, string[]> }).admittedClaims.size).toBe(0);

		pending = true;
		await integration.acceptWake("1 reg_1 wake_busy", ctx as never);
		expect(requests.some((request) => request.params.wakeId === "wake_busy")).toBe(false);
		pending = false;
		await integration.acceptWake("1 reg_1 wake_1/pi-kit-runtime-wake 1 reg_1 wake_1", ctx as never);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ customType: HOSTED_RUNTIME_MESSAGE, display: false, details: { version: 1, wakeId: "wake_1", claimId: "claim_wake_1", eventIds: ["evt_wake_1"] } });
		await integration.acceptWake("1 reg_1 wake_1", ctx as never);
		expect(messages).toHaveLength(1);
		integration.acknowledgeMessage({ role: "custom", ...messages[0] });
		await vi.waitFor(() => expect(requests.some((request) => request.method === "inbox.ack" && request.params.claimId === "claim_wake_1")).toBe(true));

		await integration.acceptWake("1 reg_1 wake_mail", ctx as never);
		expect(messages[1]).toMatchObject({
			customType: HOSTED_RUNTIME_MESSAGE,
			content: expect.stringContaining("Please inspect the race."),
			details: { mailbox: [{ eventId: "evt_mail", sendId: "send_mail", senderParticipantKey: "participant_fable", recipientParticipantKey: "participant_main" }] },
		});

		const injected = await integration.beforeAgentStart(ctx as never);
		expect(injected?.message).toMatchObject({ customType: HOSTED_RUNTIME_MESSAGE, content: expect.stringContaining("Focused-safe reply."), details: { claimId: "claim_focused", eventIds: ["evt_focused"] } });
		expect(injected?.message.details).not.toHaveProperty("wakeId");

		sendFails = true;
		await integration.acceptWake("1 reg_1 wake_2", ctx as never);
		expect(requests.some((request) => request.method === "inbox.release" && request.params.claimId === "claim_wake_2")).toBe(true);
		await integration.sessionShutdown();
	});
});
