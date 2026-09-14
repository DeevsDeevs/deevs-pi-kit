import { HostedRuntimeClientError } from "./client.ts";
import { collapsePrompt, shellQuote } from "./herdr.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "./hosted-types.ts";
import type { NativeMessagingConfiguration } from "./mcp/native.ts";
import { toolDefinitions } from "./mcp/tools.ts";
import type { CollaboratorPersona, ManagedAgentSession } from "./session-record.ts";

const MESSAGING_TOOLS = toolDefinitions.map(tool => tool.name);
const COLLABORATOR_METADATA_TOOLS = ["collaborator_list", ...MESSAGING_TOOLS, "chain_save", "chain_load", "chain_context"] as const;
const READ_ONLY_COLLABORATOR_TOOLS = ["read", "grep", "find", "ls", "safe_diff", ...COLLABORATOR_METADATA_TOOLS] as const;
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
const CLAUDE_READ_ONLY_TOOLS = "Read,Glob,Grep";
const MAX_LAUNCH_COMMAND_BYTES = 4000;
const LAUNCH_TIMEOUT_MS = "30000";
const NATIVE_STARTUP_MESSAGE = "Acknowledge this collaborator workflow and wait for operator input."
	+ " No tools or other work are requested by this startup message.";

type HerdrAgentKind = "pi" | "claude" | "codex";

/** Everything one driver may need to compose its own startup argv. */
interface DriverCommandInput {
	profile?: HostedCollaboratorProfile;
	cwd: string;
	sessionFile?: string;
	model?: string;
	persona?: CollaboratorPersona;
	mcp?: NativeMessagingConfiguration;
}

/** One authorized collaborator launch: which driver, under which agent name, in which pane. */
export interface DriverLaunch {
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
	defaultProfile?: HostedCollaboratorProfile;
	/** Pi resolves models through providers, so an explicit model must name one. */
	qualifiedModel: boolean;
	personaModel: boolean;
	command(input: DriverCommandInput): string[];
	verify(agent: StartedAgentIdentity): boolean;
}

/** One owner contract per supported driver: no open dictionary, no driver absent from the lifecycle. */
interface DriverTable {
	"pi": DriverSpec;
	"claude-code": DriverSpec;
	"codex": DriverSpec;
}

export const DRIVERS: DriverTable = {
	"pi": {
		kind: "pi",
		qualifiedModel: true,
		personaModel: true,
		command: piCommand,
		verify: startedAs("pi"),
	},
	"claude-code": {
		kind: "claude",
		bind: "claude-code",
		defaultProfile: "read-only",
		qualifiedModel: false,
		personaModel: false,
		command: claudeCommand,
		verify: startedAs("claude"),
	},
	"codex": {
		kind: "codex",
		bind: "codex",
		defaultProfile: "read-only",
		qualifiedModel: false,
		personaModel: false,
		command: codexCommand,
		verify: startedAs("codex"),
	},
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
	const allowed = input.profile ? ["--tools", collaboratorProfileTools(input.profile).join(",")] : [];
	return ["--approve", ...session, ...allowed, ...modelArguments(input.model)];
}

function claudeCommand(input: DriverCommandInput): string[] {
	const model = modelArguments(input.model);
	if (input.mcp) {
		const servers = JSON.stringify({ mcpServers: { [input.mcp.serverName]: input.mcp.server } });
		return ["--mcp-config", servers, ...model, "--append-system-prompt", input.mcp.context];
	}
	const persona = input.persona ? ["--append-system-prompt", collapsePrompt(input.persona.prompt)] : [];
	return ["--safe-mode", "--permission-mode", "dontAsk", "--tools", CLAUDE_READ_ONLY_TOOLS, ...model, ...persona];
}

function codexCommand(input: DriverCommandInput): string[] {
	const model = modelArguments(input.model);
	if (input.mcp) {
		const server = `mcp_servers.${input.mcp.serverName}=${codexServerValue(input.mcp)}`;
		return ["--sandbox", "workspace-write", "--config", server, ...model, "--", `${NATIVE_STARTUP_MESSAGE} ${input.mcp.context}`];
	}
	const trustedProject = `projects={ ${JSON.stringify(input.cwd)} = { trust_level = "trusted" } }`;
	const persona = input.persona ? ["--config", `developer_instructions=${JSON.stringify(input.persona.prompt)}`] : [];
	return ["--ask-for-approval", "never", "--sandbox", "read-only", "--disable", "hooks", "--config", trustedProject, ...model, ...persona];
}

function codexServerValue(mcp: NativeMessagingConfiguration): string {
	return `{command=${JSON.stringify(mcp.server.command)},args=${JSON.stringify(mcp.server.args)}}`;
}

function modelArguments(model: string | undefined): string[] {
	return model ? ["--model", model] : [];
}

function startedAs(kind: HerdrAgentKind): DriverSpec["verify"] {
	return (agent) => {
		if (agent.agentSession.agent !== kind) return false;
		return agent.agentSession.source === `herdr:${kind}`;
	};
}
