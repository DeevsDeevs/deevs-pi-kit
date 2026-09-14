import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageStartEvent,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { markClaudeWorkspaceTrusted } from "./claude-trust.ts";
import type { CollaboratorToolBlock } from "./collaborator-policy.ts";
import {
	CollaboratorService,
	type CollaboratorManageInput,
	type CollaboratorManageResult,
	type CollaboratorWorktreeInput,
} from "./collaborators.ts";
import { HostedDelivery, type HostedClaimCustomMessage } from "./delivery.ts";
import { MessagingClient } from "./messaging-client.ts";
import { NativeAgentService } from "./native-agents.ts";
import type { ClientParticipantStatus, HostedHeartbeat, LiveClientRegistration, SerializedValue } from "./responses.ts";
import { runRuntimeCommand, type RuntimeCommandServices } from "./runtime-command.ts";
import { RuntimeSession, type HostedReceipt, type RuntimeSessionHooks } from "./runtime-session.ts";
import { HostedSessionStore } from "./session-record.ts";

interface BeforeAgentStartResult {
	message?: HostedClaimCustomMessage;
	systemPrompt?: string;
}

/** Wires the Runtime session, delivery, messaging and collaborator services to Pi's extension events. */
export class HostedRuntimeIntegration implements RuntimeSessionHooks {
	private readonly store: HostedSessionStore;
	private readonly session: RuntimeSession;
	private readonly delivery: HostedDelivery;
	private readonly messaging: MessagingClient;
	private readonly native: NativeAgentService;
	private readonly collaborators: CollaboratorService;

	constructor(pi: ExtensionAPI, root = defaultRuntimeRoot(), trustClaudeWorkspace: (cwd: string) => void = markClaudeWorkspaceTrusted) {
		this.store = new HostedSessionStore(pi);
		this.session = new RuntimeSession(pi, root, this.store, this);
		this.delivery = new HostedDelivery(this.session);
		this.messaging = new MessagingClient(this.session);
		this.native = new NativeAgentService(this.session, this.messaging, trustClaudeWorkspace);
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

	acceptWake(args: string, ctx: ExtensionCommandContext): Promise<void> {
		return this.delivery.acceptWake(args, ctx);
	}

	acknowledgeMessage(message: MessageStartEvent["message"]): void {
		this.delivery.acknowledgeMessage(message);
	}

	messagingDescriptor(ctx: ExtensionContext): Promise<string> {
		return this.messaging.descriptor(ctx);
	}

	command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const services: RuntimeCommandServices = { session: this.session, messaging: this.messaging };
		return runRuntimeCommand(services, args, ctx);
	}

	guardCollaboratorTool(toolName: string, input: ToolCallEvent["input"] | undefined, cwd: string): CollaboratorToolBlock | undefined {
		return this.collaborators.guardTool(toolName, input, cwd);
	}

	listCollaborators(ctx: ExtensionContext): Promise<ClientParticipantStatus[]> {
		return this.collaborators.list(ctx);
	}

	manageCollaborators(input: CollaboratorManageInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		return this.collaborators.manage(input, ctx, signal);
	}

	manageWorktrees(input: CollaboratorWorktreeInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<SerializedValue> {
		return this.collaborators.manageWorktrees(input, ctx, signal);
	}

	/** Adds any collaborator persona prompt and admits one claimed batch before the turn starts. */
	async beforeAgentStart(systemPrompt: string, ctx: ExtensionContext): Promise<BeforeAgentStartResult | undefined> {
		this.session.setContext(ctx);
		if (!this.session.isActive) return undefined;
		const current = this.session.scope(ctx);
		const result: BeforeAgentStartResult = {};
		const persona = this.store.launch?.persona;
		if (persona) result.systemPrompt = `${systemPrompt}\n\n# Collaborator persona: ${persona.name}\n\n${persona.prompt}`;
		let registration: LiveClientRegistration;
		try { registration = await this.session.requireRegistration(ctx); } catch { return personaOnly(result); }
		if (!current()) return undefined;
		const claim = await this.delivery.claimForTurn(registration, current);
		switch (claim.status) {
			case "none": return personaOnly(result);
			case "stale": return undefined;
			case "claimed": {
				result.message = claim.message;
				return result;
			}
			default: {
				const unreachable: never = claim;
				return unreachable;
			}
		}
	}

	restoreSessionState(ctx: ExtensionContext): void {
		this.native.clearRegistrations();
		this.messaging.clearManagedIssuance();
		this.store.restore(ctx);
		this.delivery.restoreAdmissions(ctx);
	}

	admittedClaims(): HostedReceipt[] {
		return this.delivery.admittedClaims();
	}

	clearPendingAcks(): void {
		this.delivery.clearPendingAcks();
	}

	async afterRegister(registration: LiveClientRegistration, _ctx: ExtensionContext, current: () => boolean): Promise<void> {
		if (this.store.identity?.disposition === "held") await this.messaging.provision(registration, current);
	}

	async afterHeartbeat(
		registration: LiveClientRegistration,
		ctx: ExtensionContext,
		heartbeat: HostedHeartbeat,
		current: () => boolean,
	): Promise<void> {
		await this.delivery.retryAdmissions(registration);
		this.session.requireCurrentScope(current);
		if (heartbeat.inboxReady) await this.delivery.admitHeartbeatInbox(registration, ctx);
		this.session.requireCurrentScope(current);
		this.messaging.offerMailHint(registration, ctx, heartbeat.mail);
	}

	afterHeartbeatSettled(): Promise<void> {
		return this.native.heartbeatManagedAgents();
	}
}

function personaOnly(result: BeforeAgentStartResult): BeforeAgentStartResult | undefined {
	return result.systemPrompt ? result : undefined;
}

function defaultRuntimeRoot(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "runtime");
}
