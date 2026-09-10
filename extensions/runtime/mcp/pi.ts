/* oxlint-disable anti-slop/no-runtime-typeof -- CLI flags and MCP peer bindings are external input boundaries. */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MessagingMcpClient, record, type McpToolResult } from "./client.ts";
import { toolDefinitions } from "./tools.ts";

const skillPath = fileURLToPath(new URL("../../../skills/collaborator-messaging/SKILL.md", import.meta.url));
const toolNames = new Set(toolDefinitions.map(tool => tool.name));

export function registerMessagingMcp(pi: ExtensionAPI, sourcePath: string, descriptorPath: (ctx: ExtensionContext) => Promise<string>): void {
	let connection: { path: string; client: MessagingMcpClient; ready: Promise<void> } | undefined;
	let epoch = 0;
	let running = false;

	function checkOwnership(): void {
		if (pi.getAllTools().some(tool => toolNames.has(tool.name) && realpathSync(tool.sourceInfo.path) !== realpathSync(sourcePath))) throw new Error("Conflicting messaging tools: load only the shared Runtime MCP registrar.");
	}

	async function transport(path: string, signal?: AbortSignal): Promise<MessagingMcpClient> {
		const previous = connection;
		if (previous?.client.closed) {
			await previous.client.close();
			if (connection === previous) connection = undefined;
		}
		if (!running || signal?.aborted) throw new Error("MCP session stopped before dispatch.");
		if (connection && connection.path !== path) throw new Error("MCP descriptor changed; preserve uncertain operations in their original namespace before replacing the connection.");
		if (!connection) {
			const client = new MessagingMcpClient(path);
			connection = { path, client, ready: client.initialize(signal).catch(async error => { await client.close(); throw error; }) };
		}
		await connection.ready;
		return connection.client;
	}

	function assertCurrent(ctx: ExtensionContext, sessionId: string, started: number, signal?: AbortSignal): void {
		if (!running || epoch !== started || signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId) throw new Error("MCP session changed; preserve any uncertain operation's original IDs.");
	}

	function requireSuccess(result: McpToolResult): McpToolResult {
		// Pi marks thrown tool errors as isError; a returned isError field is not sufficient.
		if (result.isError) throw new Error(result.content.map(block => block.text).join("\n"));
		return result;
	}

	for (const tool of toolDefinitions) pi.registerTool({
		name: tool.name, label: tool.name, description: tool.description,
		parameters: Type.Unsafe<Record<string, string>>(tool.inputSchema),
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			checkOwnership();
			const started = epoch;
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("MCP messaging requires a persisted Pi session.");
			assertCurrent(ctx, sessionId, started, signal);
			const path = await descriptorPath(ctx);
			assertCurrent(ctx, sessionId, started, signal);
			if (!isAbsolute(path)) throw new Error("Runtime returned a non-absolute MCP descriptor path.");
			const client = await transport(path, signal);
			assertCurrent(ctx, sessionId, started, signal);
			const peers = requireSuccess(await client.callTool("collaborator_peers", tool.name === "collaborator_peers" ? args : {}, signal));
			assertCurrent(ctx, sessionId, started, signal);
			const binding = peers.structuredContent?.binding;
			if (!record(binding) || binding.kind !== "pi" || binding.sessionId !== sessionId || binding.sessionFile !== realpathSync(sessionFile) || binding.cwd !== realpathSync(ctx.cwd)) throw new Error("MCP descriptor does not belong to this exact Pi session and cwd. Request a correctly bound descriptor; do not migrate uncertain operations.");
			const result = tool.name === "collaborator_peers" ? peers : requireSuccess(await client.callTool(tool.name, args, signal));
			assertCurrent(ctx, sessionId, started, signal);
			return { content: result.content, details: result.structuredContent };
		},
	});

	pi.on("tool_call", event => {
		if (!toolNames.has(event.toolName)) return;
		try { checkOwnership(); } catch (error) { return { block: true, reason: error instanceof Error ? error.message : "MCP configuration unavailable" }; }
	});
	pi.on("before_agent_start", event => {
		if (!pi.getActiveTools().some(name => toolNames.has(name))) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${readFileSync(skillPath, "utf8")}` };
	});
	pi.on("session_start", () => { epoch++; running = true; });
	pi.on("session_tree", () => { epoch++; });
	pi.on("session_compact", () => { epoch++; });
	pi.on("session_shutdown", async () => { epoch++; running = false; await connection?.client.close(); });
}
