/* oxlint-disable anti-slop/no-runtime-typeof -- CLI flags and MCP peer bindings are external input boundaries. */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isJsonObject } from "../schemas/json.ts";
import { MessagingMcpClient, type McpToolResult } from "./client.ts";
import { toolDefinitions } from "./tools.ts";

const skillPath = fileURLToPath(new URL("../../../skills/collaborator-messaging/SKILL.md", import.meta.url));
const toolNames = new Set(toolDefinitions.map(tool => tool.name));

type DescriptorResolver = (ctx: ExtensionContext) => Promise<string>;

interface McpConnection {
	path: string;
	client: MessagingMcpClient;
	ready: Promise<void>;
}

interface MessagingToolOutcome {
	content: McpToolResult["content"];
	details: McpToolResult["structuredContent"];
}

class MessagingSession {
	private readonly pi: ExtensionAPI;
	private readonly sourcePath: string;
	private connection: McpConnection | undefined;
	private epoch = 0;
	private running = false;

	constructor(pi: ExtensionAPI, sourcePath: string) {
		this.pi = pi;
		this.sourcePath = sourcePath;
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	invalidate(): void {
		this.epoch++;
	}

	start(): void {
		this.epoch++;
		this.running = true;
	}

	async shutdown(): Promise<void> {
		this.epoch++;
		this.running = false;
		await this.connection?.client.close();
	}

	checkOwnership(): void {
		const owned = realpathSync(this.sourcePath);
		const foreign = this.pi
			.getAllTools()
			.some(tool => toolNames.has(tool.name) && realpathSync(tool.sourceInfo.path) !== owned);
		if (foreign) throw new Error("Conflicting messaging tools: load only the shared Runtime MCP registrar.");
	}

	async transport(path: string, signal?: AbortSignal): Promise<MessagingMcpClient> {
		const previous = this.connection;
		if (previous?.client.closed) {
			await previous.client.close();
			if (this.connection === previous) this.connection = undefined;
		}
		const stopped = !this.running
			|| signal?.aborted === true;
		if (stopped) throw new Error("MCP session stopped before dispatch.");
		const replacesDescriptor = this.connection !== undefined
			&& this.connection.path !== path;
		if (replacesDescriptor) {
			throw new Error("MCP descriptor changed; preserve uncertain operations in their original namespace before replacing the connection.");
		}
		if (!this.connection) {
			const client = new MessagingMcpClient(path);
			const ready = client.initialize(signal).catch(async error => {
				await client.close();
				throw error;
			});
			this.connection = { path, client, ready };
		}
		await this.connection.ready;
		return this.connection.client;
	}

	assertCurrent(ctx: ExtensionContext, sessionId: string, started: number, signal?: AbortSignal): void {
		const current = this.running
			&& this.epoch === started
			&& !signal?.aborted
			&& ctx.sessionManager.getSessionId() === sessionId;
		if (!current) throw new Error("MCP session changed; preserve any uncertain operation's original IDs.");
	}
}

function requireSuccess(result: McpToolResult): McpToolResult {
	// Pi marks thrown tool errors as isError; a returned isError field is not sufficient.
	if (result.isError) throw new Error(result.content.map(block => block.text).join("\n"));
	return result;
}

function assertBoundDescriptor(peers: McpToolResult, ctx: ExtensionContext, sessionId: string, sessionFile: string): void {
	const binding = peers.structuredContent?.binding;
	// binding is unvalidated MCP structuredContent, not a HostedTarget, so the typed isPiTarget() predicate cannot be used here.
	const bound = isJsonObject(binding)
		&& binding.kind === "pi"
		&& binding.sessionId === sessionId
		&& binding.sessionFile === realpathSync(sessionFile)
		&& binding.cwd === realpathSync(ctx.cwd);
	if (!bound) {
		throw new Error("MCP descriptor does not belong to this exact Pi session and cwd."
			+ " Request a correctly bound descriptor; do not migrate uncertain operations.");
	}
}

async function executeMessagingTool(
	session: MessagingSession,
	descriptorPath: DescriptorResolver,
	toolName: string,
	args: Record<string, string>,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<MessagingToolOutcome> {
	session.checkOwnership();
	const started = session.currentEpoch;
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("MCP messaging requires a persisted Pi session.");
	session.assertCurrent(ctx, sessionId, started, signal);
	const path = await descriptorPath(ctx);
	session.assertCurrent(ctx, sessionId, started, signal);
	if (!isAbsolute(path)) throw new Error("Runtime returned a non-absolute MCP descriptor path.");
	const client = await session.transport(path, signal);
	session.assertCurrent(ctx, sessionId, started, signal);
	const isPeers = toolName === "collaborator_peers";
	const peers = requireSuccess(await client.callTool("collaborator_peers", isPeers ? args : {}, signal));
	session.assertCurrent(ctx, sessionId, started, signal);
	assertBoundDescriptor(peers, ctx, sessionId, sessionFile);
	const result = isPeers ? peers : requireSuccess(await client.callTool(toolName, args, signal));
	session.assertCurrent(ctx, sessionId, started, signal);
	return { content: result.content, details: result.structuredContent };
}

function registerMessagingEvents(pi: ExtensionAPI, session: MessagingSession): void {
	pi.on("tool_call", event => {
		if (!toolNames.has(event.toolName)) return;
		try {
			session.checkOwnership();
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : "MCP configuration unavailable" };
		}
	});
	pi.on("before_agent_start", event => {
		if (!pi.getActiveTools().some(name => toolNames.has(name))) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${readFileSync(skillPath, "utf8")}` };
	});
	pi.on("session_start", () => session.start());
	pi.on("session_tree", () => session.invalidate());
	pi.on("session_compact", () => session.invalidate());
	pi.on("session_shutdown", () => session.shutdown());
}

export function registerMessagingMcp(pi: ExtensionAPI, sourcePath: string, descriptorPath: DescriptorResolver): void {
	const session = new MessagingSession(pi, sourcePath);
	for (const tool of toolDefinitions) {
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: Type.Unsafe<Record<string, string>>(tool.inputSchema),
			execute: (_toolCallId, args, signal, _onUpdate, ctx) =>
				executeMessagingTool(session, descriptorPath, tool.name, args, signal, ctx),
		});
	}
	registerMessagingEvents(pi, session);
}
