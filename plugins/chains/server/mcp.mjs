// Chains MCP server for Claude Code and Codex: the Pi extension's chain tool and storage, over stdio JSON-RPC.
import { createInterface } from "node:readline";
import { ChainService } from "../lib/chains/service.ts";
import { CHAIN_TOOL, runChain } from "../lib/chains/tool.ts";

const PROTOCOL_VERSION = "2025-06-18";

/** Claude Code starts plugin servers in the session's project and exports CLAUDE_PROJECT_DIR; Codex starts them in the session cwd. */
function projectDir() {
	return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

async function handle(request, service) {
	const reply = (result) => ({ jsonrpc: "2.0", id: request.id, result });
	const fail = (code, message) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
	if (request.id === undefined) return undefined;
	switch (request.method) {
		case "initialize":
			return reply({ protocolVersion: request.params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "chains", version: "1.0.0" } });
		case "ping":
			return reply({});
		case "tools/list":
			return reply({ tools: [CHAIN_TOOL] });
		case "tools/call": {
			if (request.params?.name !== CHAIN_TOOL.name) return fail(-32602, `Unknown tool ${request.params?.name}`);
			try {
				return reply({ content: [{ type: "text", text: (await runChain(service, request.params.arguments ?? {})).text }] });
			} catch (error) {
				return reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
			}
		}
		default:
			return fail(-32601, `Method not found: ${request.method}`);
	}
}

const service = new ChainService(projectDir());
for await (const line of createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	let request;
	try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
	const response = await handle(request, service);
	if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
