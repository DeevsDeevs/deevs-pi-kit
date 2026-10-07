import { HostedRuntimeClientError } from "./client.ts";
import { guardHookArgs, shellQuote } from "../shared/guard.ts";
import { collapsePrompt } from "./herdr.ts";
import { type HostedCollaboratorDriver, type HostedCollaboratorProfile, type HostedNativeCollaboratorDriver, isWriter } from "./schemas/state.ts";
import type { NativeMessagingConfiguration } from "./mcp/native.ts";
import { toolDefinitions } from "./mcp/tools.ts";
import type { CollaboratorPersona, ManagedAgentSession } from "./schemas/session.ts";

const MESSAGING_TOOLS = toolDefinitions.map(tool => tool.name);
const COLLABORATOR_METADATA_TOOLS = [...MESSAGING_TOOLS, "chain"] as const;
const READ_ONLY_COLLABORATOR_TOOLS = ["read", "grep", "find", "ls", "bash", ...COLLABORATOR_METADATA_TOOLS] as const;
const WORKSPACE_WRITE_COLLABORATOR_TOOLS = [...READ_ONLY_COLLABORATOR_TOOLS, "edit", "write"] as const;
/** One owner contract per collaborator profile: every profile has an allowlist, none falls through. */
interface ProfileToolTable {
	"read-only": readonly string[];
	"workspace-write": readonly string[];
}

const PROFILE_TOOLS: ProfileToolTable = {
	"read-only": READ_ONLY_COLLABORATOR_TOOLS,
	"workspace-write": WORKSPACE_WRITE_COLLABORATOR_TOOLS,
};
const CLAUDE_READ_ONLY_TOOLS = "Bash,Read,Glob,Grep";
const MAX_LAUNCH_COMMAND_BYTES = 4000;
const LAUNCH_TIMEOUT_MS = "30000";
export const NATIVE_STARTUP_MESSAGE = "Acknowledge in one line and wait for input.";

type HerdrAgentKind = "pi" | "claude" | "codex";

/** Everything one driver may need to compose its own startup argv. */
interface DriverCommandInput {
	profile: HostedCollaboratorProfile;
	cwd: string;
	sessionFile?: string;
	model?: string;
	persona?: CollaboratorPersona;
	mcp?: NativeMessagingConfiguration;
	/** A Claude or Codex session to resume instead of starting a new one. */
	resume?: string;
	/** The id a new Claude session is started under, so a stand-down knows what to resume. */
	sessionId?: string;
}

/** One authorized collaborator launch: which driver, under which agent name, in which pane. */
interface DriverLaunch {
	driver: HostedCollaboratorDriver;
	agentName: string;
	paneId: string;
	input: DriverCommandInput;
}

/** The Herdr agent identity `herdr agent start` reported for one launch. */
export interface StartedAgentIdentity {
	name: string;
	paneId: string;
	terminalId: string;
	agentSession: ManagedAgentSession;
}

export interface DriverSpec {
	kind: HerdrAgentKind;
	/** Absent when the driver registers itself from its prepared Pi session instead of a Runtime bind. */
	bind?: HostedNativeCollaboratorDriver;
	command(input: DriverCommandInput): string[];
}

/** One owner contract per supported driver: no open dictionary, no driver absent from the lifecycle. */
interface DriverTable {
	"pi": DriverSpec;
	"claude-code": DriverSpec;
	"codex": DriverSpec;
}

export const DRIVERS: DriverTable = {
	"pi": { kind: "pi", command: piCommand },
	"claude-code": { kind: "claude", bind: "claude-code", command: claudeCommand },
	"codex": { kind: "codex", bind: "codex", command: codexCommand },
};

/** The one launch gate: the exact `herdr agent start` argv is bounded and shell-safe before Herdr hands it to a shell. */
export function driverLaunchArgv(launch: DriverLaunch): string[] {
	const spec = DRIVERS[launch.driver];
	const startup = spec.command(launch.input);
	const start = ["agent", "start", launch.agentName, "--kind", spec.kind, "--pane", launch.paneId, "--timeout", LAUNCH_TIMEOUT_MS];
	const argv = startup.length ? [...start, "--", ...startup] : start;
	// Herdr rejects control characters before submitting an agent launch to its shell.
	if (argv.some(argument => /\p{Cc}/u.test(argument))) {
		throw new HostedRuntimeClientError("invalid_request", "Collaborator launch arguments cannot contain control characters.");
	}
	// A startup shell may still have a 4095-byte canonical input limit; the always-quoted full invocation is a conservative bound.
	const command = ["herdr", ...argv].map(shellQuote).join(" ");
	if (Buffer.byteLength(command) > MAX_LAUNCH_COMMAND_BYTES) {
		const detail = `Collaborator launch exceeds the ${MAX_LAUNCH_COMMAND_BYTES}-byte escaped command limit.`;
		throw new HostedRuntimeClientError("invalid_request", detail);
	}
	return argv;
}

export function collaboratorProfileTools(profile: HostedCollaboratorProfile): readonly string[] {
	return PROFILE_TOOLS[profile];
}

function piCommand(input: DriverCommandInput): string[] {
	const session = input.sessionFile ? ["--session", input.sessionFile] : [];
	return ["--approve", ...session, "--tools", collaboratorProfileTools(input.profile).join(","), ...modelArguments(input.model)];
}

function claudeCommand(input: DriverCommandInput): string[] {
	const model = modelArguments(input.model);
	const mcp = input.mcp;
	const context = mcp ? mcp.context : input.persona ? collapsePrompt(input.persona.prompt) : undefined;
	const prompt = context ? ["--append-system-prompt", context] : [];
	const servers = mcp ? ["--mcp-config", JSON.stringify({ mcpServers: { [mcp.serverName]: mcp.server } })] : [];
	// Decision 15: no permission prompts, the kit guard as a PreToolUse hook on Bash; a reader's tool list has no Edit or Write.
	const tools = isWriter(input.profile) ? [] : ["--tools", [CLAUDE_READ_ONLY_TOOLS, ...(mcp ? MESSAGING_TOOLS.map(tool => `mcp__${mcp.serverName}__${tool}`) : [])].join(",")];
	const resume = input.resume ? ["--resume", input.resume] : input.sessionId ? ["--session-id", input.sessionId] : [];
	return [...resume, ...servers, "--permission-mode", "bypassPermissions", ...guardHookArgs("claude"), ...tools, ...model, ...prompt];
}

function codexCommand(input: DriverCommandInput): string[] {
	const model = modelArguments(input.model);
	const mcp = input.mcp;
	const server = mcp ? ["--config", `mcp_servers.${mcp.serverName}=${codexServerValue(mcp)}`] : [];
	const persona = input.persona && !mcp ? ["--config", `developer_instructions=${JSON.stringify(input.persona.prompt)}`] : [];
	// `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`: the positionals follow `--`.
	const positional = [...(input.resume ? [input.resume] : []), ...(mcp ? [`${NATIVE_STARTUP_MESSAGE} ${mcp.context}`] : [])];
	const startup = [...persona, ...(positional.length ? ["--", ...positional] : [])];
	const trustedProject = ["--config", `projects={ ${JSON.stringify(input.cwd)} = { trust_level = "trusted" } }`];
	// Decision 8: the kit guard as a PreToolUse hook; the kit vets its own hook, so its trust is bypassed for this launch.
	const sandbox = isWriter(input.profile) ? "workspace-write" : "read-only";
	const command = input.resume ? ["resume"] : [];
	return [...command, "--sandbox", sandbox, "--ask-for-approval", "never", ...guardHookArgs("codex"), ...trustedProject, ...server, ...model, ...startup];
}

function codexServerValue(mcp: NativeMessagingConfiguration): string {
	return `{command=${JSON.stringify(mcp.server.command)},args=${JSON.stringify(mcp.server.args)}}`;
}

function modelArguments(model: string | undefined): string[] {
	return model ? ["--model", model] : [];
}
