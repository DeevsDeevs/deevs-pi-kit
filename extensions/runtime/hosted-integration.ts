import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { CollaboratorToolBlock } from "./collaborator-policy.ts";
import {
	CollaboratorService,
	type CollaboratorManageInput,
	type CollaboratorManageResult,
	type CollaboratorWorktreeInput,
} from "./collaborators.ts";
import { HostedDelivery } from "./delivery.ts";
import { MessagingClient } from "./messaging-client.ts";
import { NativeAgentService } from "./native-agents.ts";
import type { ClientParticipantStatus, HostedHeartbeat, LiveClientRegistration, SerializedValue } from "./responses.ts";
import { runRuntimeCommand, type RuntimeCommandServices } from "./runtime-command.ts";
import { RuntimeSession, type RuntimeSessionHooks } from "./runtime-session.ts";
import { HostedSessionStore } from "./session-record.ts";

interface BeforeAgentStartResult {
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

	constructor(pi: ExtensionAPI, root = defaultRuntimeRoot()) {
		this.store = new HostedSessionStore(pi);
		this.session = new RuntimeSession(pi, root, this.store, this);
		this.delivery = new HostedDelivery(this.session);
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

	/** Adds any collaborator persona prompt; durable events arrive through the heartbeat alone. */
	beforeAgentStart(systemPrompt: string, ctx: ExtensionContext): BeforeAgentStartResult | undefined {
		this.session.setContext(ctx);
		const persona = this.store.launch?.persona;
		if (!this.session.isActive || !persona) return undefined;
		return { systemPrompt: `${systemPrompt}\n\n# Collaborator persona: ${persona.name}\n\n${persona.prompt}` };
	}

	restoreSessionState(ctx: ExtensionContext): void {
		this.native.clearRegistrations();
		this.messaging.clearManagedIssuance();
		this.store.restore(ctx);
	}

	canAdmit(ctx: ExtensionContext): boolean {
		return this.delivery.canAdmit(ctx);
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
		await this.delivery.admit(registration, ctx, heartbeat.events);
		this.session.requireCurrentScope(current);
		this.messaging.offerMailHint(registration, ctx, heartbeat.mail);
	}

	afterHeartbeatSettled(): Promise<void> {
		return this.native.heartbeatManagedAgents();
	}
}

function defaultRuntimeRoot(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "runtime");
}
