import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHostedLine, HOSTED_MAX_REQUEST_BYTES, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { RuntimeAlreadyRunningError, startRuntimeServer, type RuntimeServerHandle } from "../extensions/runtime/service/server.ts";
import { HostedStateStorageError, runtimeStatePaths } from "../extensions/runtime/service/state.ts";

const roots: string[] = [];
const servers: RuntimeServerHandle[] = [];

const context: HostedProtocolContext = {
	runtimeId: "rt_test",
	epoch: "epoch_test",
	agentWake: "none",
	degradedReason: "host_unavailable",
};

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-service-"));
	roots.push(root);
	return root;
}

describe("hosted runtime protocol", () => {
	it("negotiates exact v1 with only truthful current capabilities", async () => {
		const response = await dispatchHostedLine(JSON.stringify({
			v: 1,
			id: "req_1",
			method: "hello",
			params: { minVersion: 1, maxVersion: 1 },
		}), context);
		expect(response).toEqual({
			v: 1,
			id: "req_1",
			ok: true,
			result: {
				version: 1,
				runtimeId: "rt_test",
				epoch: "epoch_test",
				capabilities: {
					agentWake: "none",
					degradedReason: "host_unavailable",
					maxDeliveryBatch: 12,
					monitor: { maxEntries: 10_000 },
				},
			},
		});
	});

	it("rejects malformed framing, unsupported ranges, unknown fields, and unknown methods", async () => {
		expect(await dispatchHostedLine("{bad", context)).toMatchObject({ id: null, ok: false, error: { code: "invalid_request" } });
		expect(await dispatchHostedLine(JSON.stringify({ v: 1, id: "range", method: "hello", params: { minVersion: 2, maxVersion: 3 } }), context))
			.toMatchObject({ id: "range", ok: false, error: { code: "unsupported_version" } });
		expect(await dispatchHostedLine(JSON.stringify({ v: 2, id: "future", method: "hello", params: {}, futureField: true }), context))
			.toMatchObject({ id: "future", ok: false, error: { code: "unsupported_version" } });
		expect(await dispatchHostedLine(JSON.stringify({ v: 1, id: "extra", method: "hello", params: { minVersion: 1, maxVersion: 1, extra: true } }), context))
			.toMatchObject({ id: "extra", ok: false, error: { code: "invalid_request" } });
		expect(await dispatchHostedLine(JSON.stringify({ v: 1, id: "missing", method: "other", params: {} }), context))
			.toMatchObject({ id: "missing", ok: false, error: { code: "not_found" } });
	});
});

describe("hosted runtime Unix socket service", () => {
	it("serves multiple strict request/response exchanges and removes its own socket", async () => {
		const root = temporaryRoot();
		const server = await startRuntimeServer({ root, epoch: "epoch_fixed" });
		servers.push(server);
		expect(statSync(root).mode & 0o777).toBe(0o700);
		expect(statSync(server.socketPath).mode & 0o777).toBe(0o600);

		const responses = await exchange(server.socketPath, [
			JSON.stringify({ v: 1, id: "one", method: "hello", params: { minVersion: 1, maxVersion: 1 } }),
			JSON.stringify({ v: 1, id: "two", method: "hello", params: { minVersion: 0, maxVersion: 1 } }),
		]);
		expect(responses.map((response) => response.id)).toEqual(["one", "two"]);
		expect(responses.every((response) => response.ok === true)).toBe(true);

		await server.close();
		expect(existsSync(server.socketPath)).toBe(false);
	});

	it("reassembles fragmented UTF-8 frames and accepts CRLF", async () => {
		const server = await startRuntimeServer({ root: temporaryRoot(), epoch: "epoch_fragmented" });
		servers.push(server);
		const request = JSON.stringify({ v: 1, id: "fragmented", method: "hello", params: { minVersion: 1, maxVersion: 1 } });
		const response = await fragmentedExchange(server.socketPath, request.slice(0, 17), `${request.slice(17)}\r\n`);
		expect(response).toMatchObject({ id: "fragmented", ok: true });
	});

	it("returns one uncorrelated error and closes malformed or oversized connections", async () => {
		const server = await startRuntimeServer({ root: temporaryRoot() });
		servers.push(server);
		const malformed = await rawExchange(server.socketPath, Buffer.from("{bad\n"));
		expect(malformed.closed).toBe(true);
		expect(malformed.responses).toMatchObject([{ id: null, ok: false, error: { code: "invalid_request" } }]);

		const oversized = await rawExchange(server.socketPath, Buffer.alloc(HOSTED_MAX_REQUEST_BYTES + 1, 0x20));
		expect(oversized.closed).toBe(true);
		expect(oversized.responses).toMatchObject([{ id: null, ok: false, error: { code: "invalid_request" } }]);
	});

	it("rejects a second live service and safely recovers a stale socket path", async () => {
		const root = temporaryRoot();
		const first = await startRuntimeServer({ root });
		servers.push(first);
		await expect(startRuntimeServer({ root })).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);
		await first.close();

		writeFileSync(first.socketPath, "stale", { mode: 0o600 });
		const recovered = await startRuntimeServer({ root });
		servers.push(recovered);
		expect(statSync(recovered.socketPath).isSocket()).toBe(true);
	});

	it("fails closed before listening when durable state is corrupt", async () => {
		const root = temporaryRoot();
		mkdirSync(root, { recursive: true, mode: 0o700 });
		writeFileSync(runtimeStatePaths(root).state, "{broken", { mode: 0o600 });
		await expect(startRuntimeServer({ root })).rejects.toBeInstanceOf(HostedStateStorageError);
		expect(existsSync(join(root, "runtime.sock"))).toBe(false);
	});
});

function exchange(socketPath: string, lines: string[]): Promise<Array<Record<string, unknown>>> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffered = "";
		const responses: Array<Record<string, unknown>> = [];
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			while (buffered.includes("\n")) {
				const newline = buffered.indexOf("\n");
				responses.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
				buffered = buffered.slice(newline + 1);
				if (responses.length === lines.length) {
					socket.end();
					resolve(responses);
				}
			}
		});
		socket.once("connect", () => socket.write(`${lines.join("\n")}\n`));
	});
}

function fragmentedExchange(socketPath: string, first: string, second: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let output = "";
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.on("data", (chunk: string) => {
			output += chunk;
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			socket.end();
			resolve(JSON.parse(output.slice(0, newline)) as Record<string, unknown>);
		});
		socket.once("connect", () => {
			socket.write(first);
			setTimeout(() => socket.write(second), 10);
		});
	});
}

function rawExchange(socketPath: string, payload: Buffer): Promise<{ responses: Array<Record<string, unknown>>; closed: boolean }> {
	return new Promise((resolve, reject) => {
		const socket: Socket = createConnection(socketPath);
		let output = "";
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.on("data", (chunk: string) => { output += chunk; });
		socket.once("close", () => {
			const responses = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
			resolve({ responses, closed: true });
		});
		socket.once("connect", () => socket.write(payload));
	});
}
