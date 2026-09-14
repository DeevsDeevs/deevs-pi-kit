import { HostedRuntimeClientError } from "./client.ts";
import { shellQuote } from "./herdr.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "./hosted-types.ts";
import type { NativeMessagingConfiguration } from "./mcp/native.ts";
import { toolDefinitions } from "./mcp/tools.ts";
import type { CollaboratorPersona, ManagedAgentSession } from "./session-record.ts";

const MESSAGING_TOOLS = toolDefinitions.map(tool => tool.name);
const COLLABORATOR_METADATA_TOOLS = ["collaborator_list", ...MESSAGING_TOOLS, "chain_save", "chain_load", "chain_context"] as const;
export const READ_ONLY_COLLABORATOR_TOOLS = ["read", "grep", "find", "ls", "safe_diff", ...COLLABORATOR_METADATA_TOOLS] as const;
const WORKSPACE_WRITE_COLLABORATOR_TOOLS = [...READ_ONLY_COLLABORATOR_TOOLS, "edit", "write"] as const;
const CLAUDE_READ_ONLY_TOOLS = "Read,Glob,Grep";
const MAX_LAUNCH_COMMAND_BYTES = 4000;
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

/** The one launch argv gate: every driver's startup arguments are bounded and shell-safe before `herdr agent start` runs. */
export function driverLaunchArgv(driver: HostedCollaboratorDriver, input: DriverCommandInput): string[] {
	const spec = DRIVERS[driver];
	const argv = spec.command(input);
	// Herdr rejects control characters before submitting an agent launch to its shell.
	if (argv.some(argument => /\p{Cc}/u.test(argument))) {
		throw new HostedRuntimeClientError("invalid_request", "Collaborator launch arguments cannot contain control characters.");
	}
	// A startup shell may still have a 4095-byte canonical input limit; always-quoted argv is a conservative bound.
	const command = [spec.kind, ...argv].map(shellQuote).join(" ");
	if (Buffer.byteLength(command) > MAX_LAUNCH_COMMAND_BYTES) {
		const detail = `Collaborator launch exceeds the ${MAX_LAUNCH_COMMAND_BYTES}-byte escaped command limit.`;
		throw new HostedRuntimeClientError("invalid_request", detail);
	}
	return argv;
}

export function collaboratorProfileTools(profile: HostedCollaboratorProfile | undefined): readonly string[] | undefined {
	if (profile === "read-only") return READ_ONLY_COLLABORATOR_TOOLS;
	if (profile === "workspace-write") return WORKSPACE_WRITE_COLLABORATOR_TOOLS;
	return undefined;
}

function piCommand(input: DriverCommandInput): string[] {
	const session = input.sessionFile ? ["--session", input.sessionFile] : [];
	const tools = collaboratorProfileTools(input.profile);
	const allowed = tools ? ["--tools", tools.join(",")] : [];
	return ["--approve", ...session, ...allowed, ...modelArguments(input.model)];
}

function claudeCommand(input: DriverCommandInput): string[] {
	const model = modelArguments(input.model);
	if (input.mcp) {
		const servers = JSON.stringify({ mcpServers: { [input.mcp.serverName]: input.mcp.server } });
		return ["--mcp-config", servers, ...model, "--append-system-prompt", input.mcp.context];
	}
	const persona = input.persona ? ["--append-system-prompt", input.persona.prompt] : [];
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
