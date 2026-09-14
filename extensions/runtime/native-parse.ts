import { Value } from "typebox/value";
import { HostedRuntimeClientError } from "./client.ts";
import type { HostedCollaboratorProfile, HostedNativeCollaboratorDriver } from "./schemas/state.ts";
import { HostedCollaboratorProfileSchema, HostedNativeCollaboratorDriverSchema } from "./schemas/state.ts";
import { parseRegistration, strictObject, text, type LiveClientRegistration, type RuntimeResponse } from "./responses.ts";
import { decodeHerdr, herdrResult, HerdrStartedAgentSchema, type HerdrStartedAgent } from "./schemas/herdr.ts";
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
	let agent: HerdrStartedAgent;
	try {
		agent = decodeHerdr(HerdrStartedAgentSchema, herdrResult(value), "Herdr agent").agent;
	} catch {
		throw new HostedRuntimeClientError("invalid_response", "Herdr returned malformed agent JSON.");
	}
	const session: ManagedAgentSession = agent.agent_session ?? { source: `herdr:${agent.agent}`, agent: agent.agent, kind: "id", value: agent.name };
	if (session.agent !== agent.agent || session.source !== `herdr:${agent.agent}`) {
		throw new HostedRuntimeClientError("identity_mismatch", "Herdr agent session does not match its reported driver.");
	}
	return {
		name: agent.name,
		paneId: agent.pane_id,
		terminalId: agent.terminal_id,
		status: agent.agent_status,
		focused: agent.focused,
		agentSession: session,
	};
}

