// Development-only interoperability probe: no Runtime credentials, mailbox, or provider process.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";

const VERSION = "2025-11-25";
const MAX_FRAME = 256 * 1024;
const MAX_BODY = 16 * 1024;
const schema = { type: "object", properties: { message: { type: "string", maxLength: MAX_BODY } }, required: ["message"], additionalProperties: false };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
let phase = "new";
let count = 0;
let log;

function audit(event) {
	if (log !== undefined) writeSync(log, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
}

function handle(request) {
	const id = request?.id;
	const validId = typeof id === "string" ? id.length <= 128 : Number.isSafeInteger(id);
	const error = (code, message) => ({ jsonrpc: "2.0", id: validId ? id : null, error: { code, message } });
	const result = value => ({ jsonrpc: "2.0", id, result: value });
	if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" || "result" in request || "error" in request || ("id" in request && !validId)) return error(-32600, "Invalid request");
	if (!("id" in request)) {
		if (request.params !== undefined && !object(request.params)) return;
		if (request.method === "notifications/initialized" && phase === "initializing") {
			phase = "ready";
			audit({ event: "initialized" });
		}
		return;
	}
	if (request.params !== undefined && !object(request.params)) return error(-32602, "Expected object params");
	const params = request.params ?? {};
	if (request.method === "ping") return result({});
	if (request.method === "initialize") {
		if (phase !== "new") return error(-32600, "Already initialized");
		if (typeof params.protocolVersion !== "string" || params.protocolVersion.length > 64 || !object(params.capabilities) || !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") return error(-32602, "Invalid initialization");
		phase = "initializing";
		audit({ event: "initialize", requestedVersion: params.protocolVersion, selectedVersion: VERSION });
		return result({ protocolVersion: VERSION, capabilities: { tools: {} }, serverInfo: { name: "pi-kit-stage0", version: "0.0.0" } });
	}
	if (phase !== "ready") return error(-32600, "Initialize first");
	if (request.method === "tools/list") {
		if (Object.keys(params).some(key => key !== "_meta")) return error(-32602, "No pagination in this probe");
		audit({ event: "tools/list" });
		return result({ tools: [{ name: "stage0_echo", description: "Echo a bounded non-secret message. Stage 0 probe only; no mailbox or filesystem access.", inputSchema: schema, outputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] });
	}
	if (request.method !== "tools/call") return error(-32601, "Method not found");
	if (params.name !== "stage0_echo") return error(-32602, "Unknown tool");
	const args = params.arguments;
	if (!object(args) || Object.keys(args).length !== 1 || typeof args.message !== "string" || Buffer.byteLength(args.message) > MAX_BODY) return result({ isError: true, content: [{ type: "text", text: "Expected only message, a string of at most 16384 UTF-8 bytes." }] });
	audit({ event: "echo", bytes: Buffer.byteLength(args.message), sha256: createHash("sha256").update(args.message).digest("hex") });
	return result({ content: [{ type: "text", text: JSON.stringify(args) }], structuredContent: args, isError: false });
}

// ponytail: this disposable probe caps the whole connection at 256 frames/15 minutes;
// production messaging needs its own service quotas and cancellation semantics.
const deadline = setTimeout(() => { console.error("Stage 0 probe deadline exceeded"); process.exit(1); }, 15 * 60_000);
try {
	if (process.env.PI_KIT_MCP_PROBE_LOG) {
		log = openSync(process.env.PI_KIT_MCP_PROBE_LOG, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
		const stat = fstatSync(log);
		if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) throw new Error("Probe log must be a bounded owner-private regular file");
	}
	let pending = Buffer.alloc(0);
	for await (const chunk of process.stdin) {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			if (pending.length + end - start > MAX_FRAME) throw new Error("Probe input frame exceeds limit");
			pending = Buffer.concat([pending, chunk.subarray(start, end)]);
			start = end + 1;
			if (newline < 0) break;
			if (++count > 256) throw new Error("Probe request limit exceeded");
			let response;
			let request;
			try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending)); }
			catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid UTF-8 JSON" } }; }
			pending = Buffer.alloc(0);
			if (!response) response = handle(request);
			if (response) {
				const line = `${JSON.stringify(response)}\n`;
				if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("Probe output frame exceeds limit");
				if (!process.stdout.write(line)) await once(process.stdout, "drain");
			}
		}
	}
	if (pending.length) throw new Error("Incomplete frame at EOF");
	audit({ event: "eof" });
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	clearTimeout(deadline);
	process.stdin.destroy();
	if (log !== undefined) closeSync(log);
}
