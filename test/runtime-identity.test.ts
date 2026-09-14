import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { HostedRuntimeClientError } from "../extensions/runtime/client.ts";
import type { MessagingClient } from "../extensions/runtime/messaging-client.ts";
import { NativeAgentService } from "../extensions/runtime/native-agents.ts";
import type { RuntimeSession } from "../extensions/runtime/runtime-session.ts";
import type { ManagedAgentControl } from "../extensions/runtime/session-record.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore } from "../extensions/runtime/service/state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class AbsentAgentHost implements HostedHostVerifier {
	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		throw new HostedRuntimeClientError("identity_mismatch", `Herdr reports no such agent ${agentName}.`);
	}
}

function managedControl(): ManagedAgentControl {
	return {
		owner: { sessionId: "session_owner", sessionFile: "/tmp/owner.jsonl", cwd: "/tmp/project" },
		projectRoot: "/tmp/project",
		cwd: "/tmp/project",
		agentName: "collab-absent",
		targetKey: "agent_absent",
		driver: "codex",
		profile: "read-only",
		protocol: "review",
		participantId: "fable",
		holderGeneration: "lease_managed",
		paneId: "w1:p9",
		terminalId: "terminal_managed",
		agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session_managed" },
		state: "active",
	};
}

describe("decision A identity", () => {
	it("rejects a registration key Runtime never minted", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-identity-"));
		roots.push(root);
		const projectRoot = join(root, "project");
		const sessionFile = join(root, "session.jsonl");
		mkdirSync(projectRoot);
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_1", cwd: projectRoot })}\n`);
		const store = new HostedStateStore(join(root, "runtime"));
		const registrations = new RuntimeRegistrationManager(store, new AbsentAgentHost());
		const registration = await registrations.register({ projectRoot, piSessionId: "session_1", piSessionFile: sessionFile });
		expect(() => registrations.authorize(registration.registrationId, "forged-key")).toThrow(/does not match its key/);
		await expect(registrations.heartbeat(registration.registrationId, "forged-key")).rejects.toMatchObject({ code: "registration_stale" });
		await expect(registrations.heartbeat("reg_forged", registration.registrationKey)).rejects.toMatchObject({ code: "registration_stale" });
	});

	it("settles a managed agent to needs_attention when its heartbeat says Herdr lost the agent", async () => {
		const control = managedControl();
		const persisted: ManagedAgentControl[] = [];
		const store = {
			agents: new Map([[control.targetKey, control]]),
			agent: (targetKey: string) => (targetKey === control.targetKey ? control : undefined),
			identity: { protocol: "review", participantId: "main", participantKey: "participant_main", generation: "lease_main", disposition: "held" },
			persistAgent: (value: ManagedAgentControl) => { persisted.push(value); },
		};
		const session = {
			context: {},
			isActive: true,
			scope: () => () => true,
			store,
			liveRegistration: { targetKey: "pi_session_1", registrationId: "reg_pi", registrationKey: "key_pi", leaseUntil: 31_000 },
			client: {
				call: async () => { throw new HostedRuntimeClientError("identity_mismatch", "Herdr reports no such agent."); },
			},
		} as unknown as RuntimeSession;
		const messaging = { isManagedIssued: () => true } as unknown as MessagingClient;
		await new NativeAgentService(session, messaging).heartbeatManagedAgents();
		expect(persisted).toEqual([{ ...control, state: "needs_attention" }]);
	});

	it("records no managed authority when native messaging provisioning fails after the bind", async () => {
		const control = managedControl();
		const agents = new Map<string, ManagedAgentControl>();
		const store = {
			agents,
			agent: (targetKey: string) => agents.get(targetKey),
			persistAgent: (value: ManagedAgentControl) => { agents.set(value.targetKey, value); },
			forgetAgent: (targetKey: string) => { agents.delete(targetKey); },
		};
		const registration = { targetKey: control.targetKey, registrationId: "reg_agent", registrationKey: "key_agent", leaseUntil: 31_000 };
		const session = {
			store,
			client: {
				call: async () => ({
					...registration,
					participantKey: "participant_child",
					holderGeneration: control.holderGeneration,
					driver: control.driver,
					profile: control.profile,
					projectRoot: control.projectRoot,
					cwd: control.cwd,
				}),
			},
		} as unknown as RuntimeSession;
		const messaging = {
			provisionManaged: async () => { throw new HostedRuntimeClientError("identity_mismatch", "Descriptor differs."); },
		} as unknown as MessagingClient;
		const native = new NativeAgentService(session, messaging);
		await expect(native.bindLaunched(bindLaunchedRequest(control))).rejects.toMatchObject({ code: "identity_mismatch" });
		expect([...agents.keys()]).toEqual([]);
	});
});

function bindLaunchedRequest(control: ManagedAgentControl) {
	return {
		ctx: {
			cwd: control.owner.cwd,
			sessionManager: { getSessionId: () => control.owner.sessionId, getSessionFile: () => control.owner.sessionFile },
		} as unknown as ExtensionContext,
		registration: { targetKey: "pi_session_1", registrationId: "reg_pi", registrationKey: "key_pi", leaseUntil: 31_000 },
		plan: { agentName: control.agentName, targetKey: control.targetKey },
		driver: control.driver,
		profile: control.profile,
		protocol: control.protocol,
		participantId: control.participantId,
		projectRoot: control.projectRoot,
		cwd: control.cwd,
		tab: { tabId: "tab_1", paneId: control.paneId, terminalId: control.terminalId },
		agentSession: control.agentSession,
		callerParticipantKey: "participant_main",
		expectedCallerGeneration: "lease_main",
		messagingConfigured: true,
	};
}
