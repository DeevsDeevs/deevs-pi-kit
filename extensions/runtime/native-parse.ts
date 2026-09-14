import { Value } from "typebox/value";
import { HostedRuntimeClientError } from "./client.ts";
import type { HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "./hosted-types.ts";
import { HostedCollaboratorProfileSchema, HostedNativeCollaboratorDriverSchema } from "./schemas/state.ts";
import {
	booleanValue,
	parseRegistration,
	strictObject,
	text,
	type LiveClientRegistration,
	type RuntimeResponse,
	type SerializedObject,
} from "./responses.ts";
import type { ManagedAgentSession } from "./session-record.ts";

/** The lease Runtime reports for one bound managed Herdr agent. */
export interface BoundAgent {
	registration: LiveClientRegistration;
	participantKey: string;
	holderGeneration: string;
	driver: HostedNativeCollaboratorDriver;
	profile: HostedCollaboratorProfile;
	projectRoot: string;
	cwd: string;
}

/** The agent identity and pane Herdr reports for one started managed agent. */
export interface ManagedAgentStatus {
	name: string;
	paneId: string;
	terminalId: string;
	status: "idle" | "working" | "blocked" | "done" | "unknown";
	focused: boolean;
	agentSession: ManagedAgentSession;
}

export function parseBoundAgent(value: RuntimeResponse): BoundAgent {
	const result = strictObject(value, "Herdr agent bind result");
	if (!Value.Check(HostedNativeCollaboratorDriverSchema, result.driver)) {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent driver.");
	}
	if (!Value.Check(HostedCollaboratorProfileSchema, result.profile)) {
		throw new HostedRuntimeClientError("invalid_response", "Runtime returned an invalid bound agent profile.");
	}
	return {
		registration: parseRegistration(value),
		participantKey: text(result.participantKey),
		holderGeneration: text(result.holderGeneration),
		driver: result.driver,
		profile: result.profile,
		projectRoot: text(result.projectRoot),
		cwd: text(result.cwd),
	};
}

export function parseManagedAgent(value: string): ManagedAgentStatus {
	let response: SerializedObject;
	try {
		response = strictObject(JSON.parse(value), "Herdr response");
	} catch {
		throw new HostedRuntimeClientError("invalid_response", "Herdr returned malformed agent JSON.");
	}
	const agent = strictObject(strictObject(response.result, "Herdr result").agent, "Herdr agent");
	const agentKind = text(agent.agent);
	const session = agent.agent_session === undefined
		? { source: `herdr:${agentKind}`, agent: agentKind, kind: "id", value: text(agent.name) }
		: strictObject(agent.agent_session, "Herdr agent session");
	if (session.kind !== "id" && session.kind !== "path") {
		throw new HostedRuntimeClientError("invalid_response", "Herdr agent session kind is invalid.");
	}
	if (session.agent !== agentKind || session.source !== `herdr:${agentKind}`) {
		throw new HostedRuntimeClientError("identity_mismatch", "Herdr agent session does not match its reported driver.");
	}
	if (!isManagedAgentStatus(agent.agent_status)) throw new HostedRuntimeClientError("invalid_response", "Herdr agent status is invalid.");
	return {
		name: text(agent.name),
		paneId: text(agent.pane_id),
		terminalId: text(agent.terminal_id),
		status: agent.agent_status,
		focused: booleanValue(agent.focused),
		agentSession: { source: text(session.source), agent: text(session.agent), kind: session.kind, value: text(session.value) },
	};
}

const MANAGED_AGENT_STATUSES: readonly ManagedAgentStatus["status"][] = ["idle", "working", "blocked", "done", "unknown"];

function isManagedAgentStatus(value: RuntimeResponse): value is ManagedAgentStatus["status"] {
	return MANAGED_AGENT_STATUSES.some((status) => status === value);
}
