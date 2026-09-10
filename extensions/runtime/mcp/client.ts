/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- This private JSON-RPC codec treats external envelopes and arbitrary structured MCP content as untrusted until each public operation validates them. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { toolDefinitions } from "./tools.ts";

type RequestParams = { protocolVersion: string; capabilities: Record<string, never>; clientInfo: { name: string; version: string } } | { name: string; arguments: Record<string, string> } | Record<string, never>;
const MAX_FRAME = 256 * 1024;
const failure = () => new Error("MCP transport stopped. Publication may be uncertain; resolve it using the original namespace and operation ID.");
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export interface McpToolResult {
	isError: boolean;
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
}

/** Only the package-owned messaging endpoint, never an arbitrary MCP command. */
export class MessagingMcpClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly settled: Promise<void>;
	private stopped = false;
	private nextId = 0;
	private buffer = Buffer.alloc(0);
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

	constructor(descriptorPath: string) {
		this.child = spawn("node", [fileURLToPath(new URL("./main.mjs", import.meta.url)), descriptorPath], { stdio: "pipe" });
		this.settled = new Promise(resolve => this.child.once("close", () => { this.stop(); resolve(); }));
		this.child.on("error", () => this.stop());
		this.child.stdin.on("error", () => this.stop());
		this.child.stdout.on("error", () => this.stop());
		this.child.stdout.on("end", () => this.stop());
		this.child.stdout.on("data", (chunk: Buffer) => {
			try { this.receive(chunk); } catch { this.stop(); }
		});
		let stderrBytes = 0;
		this.child.stderr.on("error", () => this.stop());
		this.child.stderr.on("data", (chunk: Buffer) => {
			// Diagnostics are never reflected into model context or accumulated without bound.
			stderrBytes += chunk.length;
			if (stderrBytes > MAX_FRAME) this.stop();
		});
	}

	get closed(): boolean { return this.stopped; }

	async initialize(signal?: AbortSignal): Promise<void> {
		const result = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pi-kit-pi", version: "0.1.0" } }, signal);
		if (!record(result) || result.protocolVersion !== "2025-11-25" || !record(result.capabilities) || !record(result.capabilities.tools) || !record(result.serverInfo) || result.serverInfo.name !== "pi-kit-messaging") {
			await this.close();
			throw failure();
		}
		this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
		const catalog = await this.request("tools/list", {}, signal);
		if (!isDeepStrictEqual(catalog, { tools: toolDefinitions })) {
			await this.close();
			throw failure();
		}
	}

	async callTool(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpToolResult> {
		const result = await this.request("tools/call", { name, arguments: args }, signal);
		if (!record(result) || typeof result.isError !== "boolean" || !Array.isArray(result.content) || result.content.length !== 1 || !record(result.content[0]) || result.content[0].type !== "text" || typeof result.content[0].text !== "string" || (!result.isError && !record(result.structuredContent))) {
			await this.close();
			throw failure();
		}
		return { isError: result.isError, content: [{ type: "text", text: result.content[0].text }], structuredContent: record(result.structuredContent) ? result.structuredContent : undefined };
	}

	private async request(method: string, params: RequestParams, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted || this.stopped) throw failure();
		if (this.pending.size >= 12) throw new Error("MCP capacity exhausted; retry the same operation ID.");
		const id = ++this.nextId;
		const abort = () => this.stop();
		const timer = setTimeout(abort, 10_000);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			return await new Promise((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				try { this.write({ jsonrpc: "2.0", id, method, params }); } catch { this.stop(); }
			});
		} catch {
			await this.close();
			throw failure();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	private write(message: { jsonrpc: "2.0"; id?: number; method: string; params?: RequestParams }): void {
		const line = `${JSON.stringify(message)}\n`;
		if (this.stopped || Buffer.byteLength(line) > MAX_FRAME || this.child.stdin.writableLength + Buffer.byteLength(line) > 12 * MAX_FRAME) throw failure();
		// The bounded pending map and writableLength cap bound backpressure without a second queue.
		this.child.stdin.write(line);
	}

	private receive(chunk: Buffer): void {
		let start = 0;
		while (!this.stopped && start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			if (this.buffer.length + end - start > MAX_FRAME) throw failure();
			this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, end)]);
			start = end + 1;
			if (newline < 0) break;
			const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.buffer));
			this.buffer = Buffer.alloc(0);
			if (!record(response) || response.jsonrpc !== "2.0" || typeof response.id !== "number" || !Number.isSafeInteger(response.id) || Object.keys(response).some(key => !["jsonrpc", "id", "result", "error"].includes(key)) || (Object.hasOwn(response, "result") === Object.hasOwn(response, "error"))) throw failure();
			const request = this.pending.get(response.id);
			if (!request) throw failure();
			this.pending.delete(response.id);
			if (Object.hasOwn(response, "error")) request.reject(failure());
			else request.resolve(response.result);
		}
	}

	private stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.buffer = Buffer.alloc(0);
		for (const request of this.pending.values()) request.reject(failure());
		this.pending.clear();
		this.child.stdin.end();
		const terminate = setTimeout(() => this.child.kill("SIGTERM"), 100);
		const kill = setTimeout(() => this.child.kill("SIGKILL"), 1_000);
		void this.settled.then(() => { clearTimeout(terminate); clearTimeout(kill); });
	}

	async close(): Promise<void> { this.stop(); await this.settled; }
}
