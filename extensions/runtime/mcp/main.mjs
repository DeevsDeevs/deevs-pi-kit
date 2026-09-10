/* oxlint-disable anti-slop/no-runtime-typeof -- This executable is the descriptor/JSON-RPC input boundary; type checks reject malformed external data. */
import { once } from "node:events";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HostedRuntimeClient } from "../client.ts";
import { tools, toolDefinitions } from "./tools.ts";

const MAX_FRAME = 256 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
let phase = "new";
let windowStart = Date.now();
let requests = 0;

function descriptor(path) {
	if (!path || realpathSync(path) !== resolve(path)) throw new Error("Expected an exact regular descriptor path");
	const directory = lstatSync(dirname(path));
	if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw new Error("Descriptor directory must be owner-private");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error("Descriptor must be a bounded owner-private file");
		const value = JSON.parse(readFileSync(fd, "utf8"));
		if (!object(value) || Object.keys(value).sort().join(",") !== "namespaceId,secret,socketPath,version" || value.version !== 1 || typeof value.namespaceId !== "string" || !/^msg_[0-9a-f-]{36}$/.test(value.namespaceId) || typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret) || typeof value.socketPath !== "string" || value.socketPath !== resolve(value.socketPath) || Buffer.byteLength(value.socketPath) > 8192) throw new Error("Invalid messaging descriptor");
		return value;
	} finally { closeSync(fd); }
}

async function serve(path) {
	let authority;
	let client;
	async function handle(request) {
		const id = request?.id;
		const validId = typeof id === "string" ? Buffer.byteLength(id) <= 128 : Number.isSafeInteger(id);
		const error = (code, message) => ({ jsonrpc: "2.0", id: validId ? id : null, error: { code, message } });
		const result = value => ({ jsonrpc: "2.0", id, result: value });
		if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" || Object.keys(request).some(key => !["jsonrpc", "id", "method", "params"].includes(key)) || ("id" in request && !validId)) return error(-32600, "Invalid request");
		if (!("id" in request)) {
			if (request.method === "notifications/initialized" && phase === "initializing" && (request.params === undefined || object(request.params))) phase = "ready";
			return;
		}
		if (request.params !== undefined && !object(request.params)) return error(-32602, "Expected object params");
		const params = request.params ?? {};
		if (request.method === "ping") return result({});
		if (request.method === "initialize") {
			if (phase !== "new") return error(-32600, "Already initialized");
			if (typeof params.protocolVersion !== "string" || params.protocolVersion.length > 64 || !object(params.capabilities) || !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") return error(-32602, "Invalid initialization");
			phase = "initializing";
			return result({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "pi-kit-messaging", version: "0.1.0" } });
		}
		if (phase !== "ready") return error(-32600, "Initialize first");
		if (request.method === "tools/list") {
			if (Object.keys(params).some(key => key !== "_meta")) return error(-32602, "Unexpected list params");
			return result({ tools: toolDefinitions });
		}
		if (request.method !== "tools/call") return error(-32601, "Method not found");
		const tool = tools.find(tool => tool.name === params.name);
		if (!tool) return error(-32602, "Unknown tool");
		try {
			const args = params.arguments ?? {};
			if (Object.keys(params).some(key => !["name", "arguments", "_meta"].includes(key)) || !object(args) || Object.keys(args).some(key => !Object.hasOwn(tool.properties, key)) || tool.required.some(key => !Object.hasOwn(args, key))) throw new Error("Unexpected or missing tool arguments");
			for (const [key, value] of Object.entries(args)) if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > tool.properties[key].maxLength || Buffer.from(value).toString("utf8") !== value) throw new Error("Invalid tool argument type, UTF-8, or byte limit");
			if (!authority) {
				// Metadata negotiation may precede host binding; no credential or mail is usable until issuance.
				try { authority = descriptor(path); } catch { throw new Error("Messaging descriptor unavailable; the controller must bind this target first"); }
				client = new HostedRuntimeClient(authority.socketPath, 5000, 128 * 1024);
			}
			if (tool.name !== "collaborator_peers" && args.namespaceId !== authority.namespaceId) throw new Error("Namespace changed; never move an uncertain operation to a new namespace");
			const method = `messaging.${tool.name.slice("collaborator_".length)}`;
			const { body, ...otherArgs } = args;
			const input = method === "messaging.send" || method === "messaging.reply" ? { ...otherArgs, bodyBase64: Buffer.from(body).toString("base64") } : args;
			const value = await client.call(method, { ...input, namespaceId: authority.namespaceId, secret: authority.secret });
			return result({ isError: false, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
		} catch (cause) {
			return result({ isError: true, content: [{ type: "text", text: JSON.stringify({ code: cause.code ?? "invalid_arguments", message: cause.message }) }] });
		}
	}

	let pending = Buffer.alloc(0);
	for await (const chunk of process.stdin) {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline < 0 ? chunk.length : newline;
			if (pending.length + end - start > MAX_FRAME) throw new Error("MCP input exceeds limit");
			pending = Buffer.concat([pending, chunk.subarray(start, end)]);
			start = end + 1;
			if (newline < 0) break;
			if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); requests = 0; }
			if (++requests > 64) throw new Error("MCP request rate exceeds limit");
			let request;
			let response;
			try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending)); }
			catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid UTF-8 JSON" } }; }
			pending = Buffer.alloc(0);
			response ??= await handle(request);
			if (response) {
				const line = `${JSON.stringify(response)}\n`;
				if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("MCP output exceeds limit; resolve mutations by their original operation ID");
				if (!process.stdout.write(line)) await once(process.stdout, "drain");
			}
		}
	}
	if (pending.length) throw new Error("Incomplete MCP frame at EOF");
}

process.stdout.on("error", () => process.exit(1));
try {
	if (process.argv.length !== 3) throw new Error("Expected only the descriptor path");
	await serve(process.argv[2]);
} catch {
	console.error("Messaging transport stopped; verify its private descriptor and resolve uncertain operations using their original IDs.");
	process.exitCode = 1;
} finally { process.stdin.destroy(); }
