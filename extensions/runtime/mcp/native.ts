import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { messagingDescriptorPath } from "../service/messaging.ts";
import { toolDefinitions } from "./tools.ts";

interface NativeMessagingInput {
	driver: "claude-code" | "codex";
	root: string;
	targetKey: string;
	clientGeneration: string;
	nodeExecutable: string;
	model?: string;
	personaPrompt?: string;
}

/** Native configuration only: no client process, credential creation or input injection. */
export function nativeMessagingLaunch(input: NativeMessagingInput) {
	if (!isAbsolute(input.root)) throw new Error("Native messaging requires an absolute Runtime root.");
	if (!isAbsolute(input.nodeExecutable)) throw new Error("Native messaging requires an absolute Node executable.");
	const nodeExecutable = realpathSync(input.nodeExecutable);
	const endpoint = fileURLToPath(new URL("./main.mjs", import.meta.url));
	const descriptorPath = messagingDescriptorPath(input.root, input.targetKey, input.clientGeneration);
	const serverName = `pi_kit_${createHash("sha256").update(JSON.stringify([input.targetKey, input.clientGeneration])).digest("hex").slice(0, 24)}`;
	const server = { command: nodeExecutable, args: [endpoint, descriptorPath] };
	const skillPath = fileURLToPath(new URL("../../../skills/collaborator-messaging/SKILL.md", import.meta.url));
	const skill = readFileSync(skillPath, "utf8");
	const context = [input.personaPrompt?.replace(/\s+/gu, " ").trim(), `Before using messaging tools, read the shared skill at ${JSON.stringify(skillPath)}.`, "Runtime may finish provisioning this connection after startup. Wait for explicit operator input before using its messaging tools. An unavailable descriptor is pending setup, not permission to invent another namespace or client."].filter(Boolean).join(" ");
	const modelArgs = input.model ? ["--model", input.model] : [];
	const args = input.driver === "claude-code"
		? ["--mcp-config", JSON.stringify({ mcpServers: { [serverName]: server } }), ...modelArgs, "--append-system-prompt", context]
		: ["--sandbox", "workspace-write", "--config", `mcp_servers.${serverName}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)}}`, ...modelArgs, "--", `Acknowledge this collaborator workflow and wait for operator input. No tools or other work are requested by this startup message. ${context}`];
	// Herdr rejects control characters before submitting an agent launch to its shell.
	if (args.some(arg => /\p{Cc}/u.test(arg))) throw new Error("Native messaging arguments cannot contain control characters.");
	// A startup shell may still have a 4095-byte canonical input limit; always-quoted argv is a conservative bound.
	const command = [input.driver === "claude-code" ? "claude" : "codex", ...args].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
	if (Buffer.byteLength(command) > 4000) throw new Error("Native messaging launch exceeds the 4000-byte escaped command limit.");
	const configurationHash = createHash("sha256").update(JSON.stringify({ version: 1, driver: input.driver, profile: "workspace-write", policy: "native-user-configuration", args, tools: toolDefinitions, skill })).digest("hex");
	return { args, descriptorPath, serverName, configurationHash };
}
