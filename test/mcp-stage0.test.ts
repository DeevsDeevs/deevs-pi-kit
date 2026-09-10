import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probe = fileURLToPath(new URL("../scripts/mcp-stage0.mjs", import.meta.url));
const request = (id: number, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const initialize = request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const handshake = frame(initialize) + frame(initialized);
function run(input: string | Buffer, log?: string) {
	return spawnSync(process.execPath, [probe], { input, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, ...(log ? { PI_KIT_MCP_PROBE_LOG: log } : {}) } });
}
const responses = (stdout: string) => stdout.trim().split("\n").map(line => JSON.parse(line));

describe("development-only Stage 0 MCP probe", () => {
	it("negotiates, advertises only echo, and returns identical structured/text results with metadata-only audit", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-mcp-probe-"));
		try {
			const log = join(root, "events.jsonl");
			const message = "private test input: quote \" and newline\n🦊";
			const result = run(handshake + frame(request(2, "tools/list")) + frame(request(3, "tools/call", { name: "stage0_echo", arguments: { message } })), log);
			expect(result.status, result.stderr).toBe(0);
			const output = responses(result.stdout);
			expect(output).toHaveLength(3);
			expect(output[0].result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
			expect(output[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(["stage0_echo"]);
			expect(output[2].result.structuredContent).toEqual({ message });
			expect(JSON.parse(output[2].result.content[0].text)).toEqual({ message });
			expect(output[2].result.isError).toBe(false);
			const audit = readFileSync(log, "utf8");
			expect(audit).not.toContain("private test input");
			expect(responses(audit).map(event => event.event)).toEqual(["initialize", "initialized", "tools/list", "echo", "eof"]);
			expect(responses(audit)[3]).toMatchObject({ sha256: createHash("sha256").update(message).digest("hex"), bytes: Buffer.byteLength(message) });
			expect(statSync(log).mode & 0o777).toBe(0o600);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it.skipIf(process.platform === "win32")("rejects a FIFO audit path without blocking before its deadline", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-mcp-fifo-"));
		try {
			const log = join(root, "fifo");
			expect(spawnSync("mkfifo", [log]).status).toBe(0);
			const result = run(handshake, log);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("offers its pinned revision when the client requests an unsupported one", () => {
		const result = run(frame({ ...initialize, params: { ...initialize.params, protocolVersion: "2099-01-01" } }));
		expect(result.status).toBe(0);
		expect(responses(result.stdout)[0].result.protocolVersion).toBe("2025-11-25");
	});

	it("requires initialization, distinguishes protocol/tool errors, and does not answer valid notifications", () => {
		const result = run(frame(request(0, "tools/list")) + handshake
			+ frame({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } })
			+ frame(request(2, "resources/list"))
			+ frame(request(3, "tools/call", { name: "not_a_tool", arguments: {} }))
			+ frame(request(4, "tools/call", { name: "stage0_echo", arguments: { message: "hi", extra: true } })));
		expect(result.status).toBe(0);
		const output = responses(result.stdout);
		expect(output).toHaveLength(5);
		expect(output[0].error.code).toBe(-32600);
		expect(output[2].error.code).toBe(-32601);
		expect(output[3].error.code).toBe(-32602);
		expect(output[4].result.isError).toBe(true);
	});

	it("does not advance initialization for a malformed notification", () => {
		const result = run(frame(initialize) + frame({ ...initialized, params: [] })
			+ frame(request(2, "tools/list")) + frame(initialized) + frame(request(3, "tools/list")));
		expect(result.status).toBe(0);
		const output = responses(result.stdout);
		expect(output).toHaveLength(3);
		expect(output[1].error.code).toBe(-32600);
		expect(output[2].result.tools[0].name).toBe("stage0_echo");
	});

	it.each(["{broken}\n", Buffer.from([0xff, 10])])("rejects malformed JSON/UTF-8", input => {
		const result = run(input);
		expect(responses(result.stdout)[0]).toMatchObject({ id: null, error: { code: -32700 } });
	});

	it.each([null, [], { jsonrpc: "2.0", id: {}, method: "ping" }])("rejects invalid request envelopes", input => {
		expect(responses(run(frame(input)).stdout)[0].error.code).toBe(-32600);
	});

	it("handles split UTF-8 and LF frames across chunks and exits on EOF", async () => {
		const child = spawn(process.execPath, [probe], { stdio: "pipe", env: { PATH: process.env.PATH } });
		const output: Buffer[] = [];
		child.stdout.on("data", chunk => output.push(chunk));
		const closed = once(child, "close");
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		try {
			const input = Buffer.from(handshake + frame(request(2, "tools/call", { name: "stage0_echo", arguments: { message: "🦊" } })));
			const split = input.indexOf(Buffer.from("🦊")) + 1;
			child.stdin.write(input.subarray(0, split));
			await new Promise(resolve => setImmediate(resolve));
			child.stdin.end(input.subarray(split));
			expect((await closed)[0]).toBe(0);
			expect(responses(Buffer.concat(output).toString())[1].result.structuredContent).toEqual({ message: "🦊" });
		} finally { clearTimeout(timer); child.kill(); }
	});

	it("fits a maximally escaped 16 KiB echo under the proposed RPC/MCP byte ceilings", () => {
		const message = "\u0000".repeat(16 * 1024);
		const result = run(handshake + frame(request(2, "tools/call", { name: "stage0_echo", arguments: { message } })));
		expect(result.status, result.stderr).toBe(0);
		const echo = responses(result.stdout)[1];
		expect(echo.result.structuredContent.message).toBe(message);
		// Reserve 16 KiB of serialized metadata; Stage 1 must repeat this with its actual event schema.
		const event = { ...echo.result.structuredContent, metadata: "x".repeat(16 * 1024) };
		expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(128 * 1024);
		const envelope = { jsonrpc: "2.0", id: "i".repeat(128), result: { structuredContent: event, content: [{ type: "text", text: JSON.stringify(event) }] } };
		expect(Buffer.byteLength(frame(envelope))).toBeLessThan(256 * 1024);
		const tooBig = run(handshake + frame(request(2, "tools/call", { name: "stage0_echo", arguments: { message: "🦊".repeat(4097) } })));
		expect(responses(tooBig.stdout)[1].result.isError).toBe(true);
	});

	it.each(["x".repeat(256 * 1024 + 1), "{", frame(request(1, "ping")).repeat(257)])("bounds unfinished frames and total work", input => {
		const result = run(input);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
	});
});
