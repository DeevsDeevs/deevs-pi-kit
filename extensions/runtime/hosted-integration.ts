import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { CollaboratorCandidate, CollaboratorToolBlock } from "./collaborator-policy.ts";
import {
	CollaboratorService,
	LEAD,
	type CollaboratorManageInput,
	type CollaboratorManageResult,
	type CollaboratorWorktreeInput,
	type CollaboratorWorktreeResult,
} from "./collaborators.ts";
import { tasks } from "../shared/tasks.ts";
import { isHeld } from "./schemas/state.ts";
import { COLLABORATOR_GUIDANCE } from "./mcp/native.ts";
import { MessagingClient } from "./messaging-client.ts";
import { NativeAgentService } from "./native-agents.ts";
import type { ClientParticipantStatus, HostedHeartbeat, LiveClientRegistration } from "./responses.ts";
import { RuntimeSession, type RuntimeSessionHooks } from "./runtime-session.ts";
import { HostedSessionStore } from "./session-record.ts";

interface BeforeAgentStartResult {
	systemPrompt?: string;
}

/** Wires the Runtime session, delivery, messaging and collaborator services to Pi's extension events. */
export class HostedRuntimeIntegration implements RuntimeSessionHooks {
	private readonly store: HostedSessionStore;
	private readonly session: RuntimeSession;
	private readonly messaging: MessagingClient;
	private readonly native: NativeAgentService;
	private readonly collaborators: CollaboratorService;
	// ponytail: in memory only; after a lead restart a stood-down collaborator resumes with default settings (a Pi one keeps its profile from its session file).
	private readonly launched = new Map<string, CollaboratorCandidate>();
	/** A roster sync that failed after a start (a slow daemon) is retried on each heartbeat until it lands. */
	private rosterStale = false;

	constructor(pi: ExtensionAPI, root = defaultRuntimeRoot()) {
		this.store = new HostedSessionStore(pi);
		this.session = new RuntimeSession(pi, root, this.store, this);
		this.messaging = new MessagingClient(this.session);
		this.native = new NativeAgentService(this.session, this.messaging);
		this.collaborators = new CollaboratorService(this.session, this.native);
	}

	sessionStart(ctx: ExtensionContext): Promise<void> {
		return this.session.sessionStart(ctx);
	}

	sessionTree(ctx: ExtensionContext): void {
		this.session.sessionTree(ctx);
	}

	sessionCompact(ctx: ExtensionContext): void {
		this.session.sessionCompact(ctx);
	}

	sessionShutdown(): Promise<void> {
		return this.session.sessionShutdown();
	}

	guardCollaboratorTool(toolName: string, input: ToolCallEvent["input"] | undefined, cwd: string): CollaboratorToolBlock | undefined {
		return this.collaborators.guardTool(toolName, input, cwd);
	}

	listCollaborators(ctx: ExtensionContext): Promise<ClientParticipantStatus[]> {
		return this.collaborators.list(ctx);
	}

	async manageCollaborators(input: CollaboratorManageInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		const results = await this.collaborators.manage(input, ctx, signal);
		if (input.action === "start") for (const participant of input.participants) this.launched.set(participant.participantId, participant);
		// A first start acquires main; its namespace must exist before a collaborator can mail it.
		if (isHeld(this.store.identity?.disposition)) await this.provisionAndSync(ctx);
		return results;
	}

	private async relaunch(participantId: string, driver: string | undefined, ctx: ExtensionContext): Promise<void> {
		const launched = this.launched.get(participantId);
		// Only the model spec names a Claude or Codex harness, and it is gone once the lead restarted.
		if (!launched && driver && driver !== "pi") throw new Error(`${participantId} ran ${driver}; start it again with collaborator_manage and its model.`);
		const [result] = await this.manageCollaborators({ action: "start", participants: [launched ?? { participantId }] }, ctx);
		if (result?.status !== "started") throw new Error(`${participantId} did not resume: ${result?.error ?? result?.status}`);
	}

	private async provisionAndSync(ctx: ExtensionContext): Promise<void> {
		this.rosterStale = !await this.messaging.descriptor(ctx).then(() => this.syncRoster(ctx)).then(() => true, () => false);
	}

	/** Collaborators join the shared roster: the lead sees each one by name, a collaborator sees main. */
	private async syncRoster(ctx: ExtensionContext): Promise<void> {
		const identity = this.store.identity;
		if (!identity || !isHeld(identity.disposition)) return;
		const ownerSession = ctx.sessionManager.getSessionId();
		const current = () => this.session.context ?? ctx;
		const row = (name: string, description: string, held: boolean, driver?: string, stop?: () => Promise<void>) => tasks.register({
			id: name,
			kind: "collaborator",
			name,
			description,
			status: held ? "running" : "completed",
			ownerSession,
			startedAt: Date.now(),
			stop,
			send: async (message, images) => {
				// A stood-down collaborator resumes its own transcript in a new tab, then gets the message.
				if (!held) await this.relaunch(name, driver, current());
				return this.messaging.send(current(), name, message, images);
			},
		});
		if (this.store.launch) return row(LEAD, "the lead", true);
		for (const participant of await this.collaborators.list(ctx)) {
			if (participant.protocol !== identity.protocol || participant.participantId === identity.participantId) continue;
			const standDown = { action: "stand_down" as const, protocol: identity.protocol, participants: [{ participantId: participant.participantId }] };
			row(participant.participantId, `${participant.driver ?? "pi"} ${participant.profile ?? "read-only"}`, isHeld(participant.state), participant.driver,
				async () => { await this.manageCollaborators(standDown, current()); });
		}
	}

	manageWorktrees(input: CollaboratorWorktreeInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorWorktreeResult> {
		return this.collaborators.manageWorktrees(input, ctx, signal);
	}

	/** A collaborator session gets the collaborator guidance and any persona prompt. */
	beforeAgentStart(systemPrompt: string, ctx: ExtensionContext): BeforeAgentStartResult | undefined {
		this.session.setContext(ctx);
		const launch = this.store.launch;
		if (!this.session.isActive || !launch) return undefined;
		const persona = launch.persona ? `\n\n# Collaborator persona: ${launch.persona.name}\n\n${launch.persona.prompt}` : "";
		return { systemPrompt: `${systemPrompt}\n\n# Collaborator\n\n${COLLABORATOR_GUIDANCE}${persona}` };
	}

	restoreSessionState(ctx: ExtensionContext): void {
		this.native.clearRegistrations();
		this.messaging.clearManagedIssuance();
		this.store.restore(ctx);
	}

	async afterRegister(registration: LiveClientRegistration, ctx: ExtensionContext): Promise<void> {
		if (!isHeld(this.store.identity?.disposition)) return;
		await this.messaging.provision(registration, ctx);
		await this.syncRoster(ctx);
	}

	async afterHeartbeat(registration: LiveClientRegistration, ctx: ExtensionContext, heartbeat: HostedHeartbeat): Promise<void> {
		if (this.rosterStale) await this.provisionAndSync(ctx);
		return this.messaging.deliverMail(registration, ctx, heartbeat.mail);
	}

	afterHeartbeatSettled(): Promise<void> {
		return this.native.heartbeatManagedAgents();
	}
}

function defaultRuntimeRoot(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "runtime");
}
