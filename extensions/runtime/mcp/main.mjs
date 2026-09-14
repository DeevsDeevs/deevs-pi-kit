/* oxlint-disable anti-slop/no-runtime-typeof -- This executable is the descriptor and JSON-RPC input boundary. */
import { once } from "node:events";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HostedRuntimeClient } from "../client.ts";
import { isJsonObject } from "../schemas/json.ts";
import { tools, toolDefinitions } from "./tools.ts";

const MAX_FRAME = 256 * 1024;
const PROTOCOL_VERSION = "2025-11-25";
const DESCRIPTOR_KEYS = "namespaceId,secret,socketPath,version";
const REQUEST_KEYS = ["jsonrpc", "id", "method", "params"];
const CALL_KEYS = ["name", "arguments", "_meta"];
let phase = "new";
let windowStart = Date.now();
let requests = 0;

function descriptorIsValid(value) {
	if (!isJsonObject(value)) return false;
	if (Object.keys(value).sort().join(",") !== DESCRIPTOR_KEYS || value.version !== 1) return false;
	if (typeof value.namespaceId !== "string" || !/^msg_[0-9a-f-]{36}$/.test(value.namespaceId)) return false;
	if (typeof value.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)) return false;
	if (typeof value.socketPath !== "string" || value.socketPath !== resolve(value.socketPath)) return false;
	return Buffer.byteLength(value.socketPath) <= 8192;
}

function descriptor(path) {
	if (!path || realpathSync(path) !== resolve(path)) throw new Error("Expected an exact regular descriptor path");
	const directory = lstatSync(dirname(path));
	const ownerPrivateDirectory = directory.isDirectory() && directory.uid === process.getuid?.() && (directory.mode & 0o777) === 0o700;
	if (!ownerPrivateDirectory) throw new Error("Descriptor directory must be owner-private");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		const bounded = stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= 16384;
		if (!bounded) throw new Error("Descriptor must be a bounded owner-private file");
		const value = JSON.parse(readFileSync(fd, "utf8"));
		if (!descriptorIsValid(value)) throw new Error("Invalid messaging descriptor");
		return value;
	} finally { closeSync(fd); }
}

function validRequestId(id) {
	return typeof id === "string" ? Buffer.byteLength(id) <= 128 : Number.isSafeInteger(id);
}

function requestIsWellFormed(request) {
	if (!isJsonObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") return false;
	if (Object.keys(request).some(key => !REQUEST_KEYS.includes(key))) return false;
	return !("id" in request) || validRequestId(request.id);
}

function initializeIsWellFormed(params) {
	if (typeof params.protocolVersion !== "string" || params.protocolVersion.length > 64) return false;
	if (!isJsonObject(params.capabilities) || !isJsonObject(params.clientInfo)) return false;
	return typeof params.clientInfo.name === "string" && typeof params.clientInfo.version === "string";
}

function argumentsAreWellFormed(tool, params, args) {
	if (Object.keys(params).some(key => !CALL_KEYS.includes(key)) || !isJsonObject(args)) return false;
	if (Object.keys(args).some(key => !Object.hasOwn(tool.properties, key))) return false;
	return !tool.required.some(key => !Object.hasOwn(args, key));
}

function argumentIsWellFormed(tool, key, value) {
	if (typeof value !== "string" || !value.length) return false;
	return Buffer.byteLength(value) <= tool.properties[key].maxLength && Buffer.from(value).toString("utf8") === value;
}

/** One connection's authority: the descriptor is read once, on the first tool call that needs it. */
function connect(path, authority) {
	if (authority) return authority;
	// Metadata negotiation may precede host binding; no credential or mail is usable until issuance.
	let credentials;
	try {
		credentials = descriptor(path);
	} catch {
		throw new Error("Messaging descriptor unavailable; the controller must bind this target first");
	}
	return { credentials, client: new HostedRuntimeClient(credentials.socketPath, 5000, 128 * 1024) };
}

async function callTool(authority, tool, args) {
	if (tool.name !== "collaborator_peers" && args.namespaceId !== authority.credentials.namespaceId) {
		throw new Error("Namespace changed; never move an uncertain operation to a new namespace");
	}
	const method = `messaging.${tool.name.slice("collaborator_".length)}`;
	const { body, ...otherArgs } = args;
	const encoded = method === "messaging.send" || method === "messaging.reply"
		? { ...otherArgs, bodyBase64: Buffer.from(body).toString("base64") }
		: args;
	const { namespaceId, secret } = authority.credentials;
	return await authority.client.call(method, { ...encoded, namespaceId, secret });
}

function dispatch(path, state) {
	return async function handle(request) {
		const id = request?.id;
		const error = (code, message) => ({ jsonrpc: "2.0", id: validRequestId(id) ? id : null, error: { code, message } });
		const result = value => ({ jsonrpc: "2.0", id, result: value });
		if (!requestIsWellFormed(request)) return error(-32600, "Invalid request");
		if (!("id" in request)) {
			const initialized = request.params === undefined || isJsonObject(request.params);
			if (request.method === "notifications/initialized" && phase === "initializing" && initialized) phase = "ready";
			return;
		}
		if (request.params !== undefined && !isJsonObject(request.params)) return error(-32602, "Expected object params");
		const params = request.params ?? {};
		if (request.method === "ping") return result({});
		if (request.method === "initialize") {
			if (phase !== "new") return error(-32600, "Already initialized");
			if (!initializeIsWellFormed(params)) return error(-32602, "Invalid initialization");
			phase = "initializing";
			const serverInfo = { name: "pi-kit-messaging", version: "0.1.0" };
			return result({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo });
		}
		if (phase !== "ready") return error(-32600, "Initialize first");
		if (request.method === "tools/list") {
			if (Object.keys(params).some(key => key !== "_meta")) return error(-32602, "Unexpected list params");
			return result({ tools: toolDefinitions });
		}
		if (request.method !== "tools/call") return error(-32601, "Method not found");
		const tool = tools.find(candidate => candidate.name === params.name);
		if (!tool) return error(-32602, "Unknown tool");
		try {
			const args = params.arguments ?? {};
			if (!argumentsAreWellFormed(tool, params, args)) throw new Error("Unexpected or missing tool arguments");
			for (const [key, value] of Object.entries(args)) {
				if (!argumentIsWellFormed(tool, key, value)) throw new Error("Invalid tool argument type, UTF-8, or byte limit");
			}
			state.authority = connect(path, state.authority);
			const value = await callTool(state.authority, tool, args);
			return result({ isError: false, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
		} catch (cause) {
			const failure = { code: cause.code ?? "invalid_arguments", message: cause.message };
			return result({ isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] });
		}
	};
}

function frame(response) {
	const line = `${JSON.stringify(response)}\n`;
	if (Buffer.byteLength(line) > MAX_FRAME) {
		throw new Error("MCP output exceeds limit; resolve mutations by their original operation ID");
	}
	return line;
}

async function serve(path) {
	const handle = dispatch(path, { authority: undefined });
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
			if (response && !process.stdout.write(frame(response))) await once(process.stdout, "drain");
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
