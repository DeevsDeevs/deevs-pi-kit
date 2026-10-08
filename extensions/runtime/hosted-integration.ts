import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CollaboratorCandidate } from "./collaborator-policy.ts";
import { CollaboratorService, LEAD, type CollaboratorManageResult } from "./collaborators.ts";
import { agentDir } from "../shared/config.ts";
import { tasks } from "../shared/tasks.ts";
import { isHeld } from "./schemas/state.ts";
import { MessagingClient } from "./messaging-client.ts";
import { NativeAgentService } from "./native-agents.ts";
import type { HostedHeartbeat, LiveClientRegistration } from "./responses.ts";
import { RuntimeSession, type RuntimeSessionHooks } from "./runtime-session.ts";
import { HostedSessionStore } from "./session-record.ts";

/** Wires the Runtime session, messaging and collaborator services to Pi, and collaborators to the shared roster. */
export class HostedRuntimeIntegration implements RuntimeSessionHooks {
	private readonly store: HostedSessionStore;
	readonly session: RuntimeSession;
	readonly messaging: MessagingClient;
	private readonly native: NativeAgentService;
	readonly collaborators: CollaboratorService;

	constructor(pi: ExtensionAPI, root = join(agentDir(), "runtime")) {
		this.store = new HostedSessionStore(pi);
		this.session = new RuntimeSession(pi, root, this.store, this);
		this.messaging = new MessagingClient(this.session);
		this.native = new NativeAgentService(this.session, this.messaging);
		this.collaborators = new CollaboratorService(this.session, this.native);
	}

	async start(participants: CollaboratorCandidate[], ctx: ExtensionContext, signal?: AbortSignal): Promise<CollaboratorManageResult[]> {
		const results = await this.collaborators.start(participants, ctx, signal);
		// The lead may SendMessage in its very next call: each started row is on the roster before this returns.
		for (const result of results) if (result.status === "started") this.row(ctx, result.participant, `${result.driver} ${result.profile ?? "read-only"}`, true);
		// A first start acquires main; its namespace must exist before a collaborator can mail it.
		if (isHeld(this.store.identity?.disposition)) await this.messaging.descriptor(ctx).then(() => this.syncRoster(ctx)).catch(() => {});
		return results;
	}

	private async standDown(name: string, ctx: ExtensionContext): Promise<void> {
		const result = await this.collaborators.standDown(name, ctx);
		await this.syncRoster(ctx).catch(() => {});
		if (result.status !== "stood_down" && result.status !== "already_vacant") throw new Error(`${name} was not stood down: ${result.error ?? result.status}`);
	}

	/** A stood-down collaborator resumes in a new tab: a Pi one from its session file, a Claude or Codex one from its native session. */
	private async relaunch(name: string, driver: string | undefined, ctx: ExtensionContext): Promise<void> {
		const spec = this.store.started.get(name);
		if (!spec && driver !== "pi") throw new Error(`${name} ran ${driver ?? "an unknown driver"} and its start spec is gone; start it again with collaborator_start and its model.`);
		const [result] = await this.start([spec ?? { participantId: name }], ctx);
		if (result?.status !== "started") throw new Error(`${name} did not resume: ${result?.error ?? result?.status}`);
	}

	/** A collaborator's rows only send: it neither stands down nor resumes its peers. */
	private row(ctx: ExtensionContext, name: string, description: string, held: boolean, driver?: string): void {
		const current = () => this.session.context ?? ctx;
		const lead = !this.store.launch;
		tasks.register({
			id: name,
			kind: "collaborator",
			name,
			description,
			status: held ? "running" : "completed",
			ownerSession: ctx.sessionManager.getSessionId(),
			startedAt: Date.now(),
			stop: name === LEAD || !lead ? undefined : () => this.standDown(name, current()),
			send: async (message, images) => {
				if (!held && lead) await this.relaunch(name, driver, current());
				return this.messaging.send(current(), name, message, images);
			},
		});
	}

	/** Collaborators join the shared roster: the lead sees each one by name, a collaborator sees main and its peers. */
	private async syncRoster(ctx: ExtensionContext): Promise<void> {
		const identity = this.store.identity;
		if (!identity || !isHeld(identity.disposition)) return;
		if (this.store.launch) this.row(ctx, LEAD, "the lead", true);
		for (const participant of await this.collaborators.list(ctx)) {
			if (participant.protocol !== identity.protocol || participant.participantId === identity.participantId || participant.participantId === LEAD) continue;
			const profile = participant.profile ?? this.store.started.get(participant.participantId)?.profile ?? "read-only";
			const description = `${participant.driver ?? "pi"} ${profile}${participant.repo ? ` in ${participant.repo}` : ""}`;
			this.row(ctx, participant.participantId, description, isHeld(participant.state), participant.driver);
		}
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
		// A collaborator's turns start from mail: its roster lists its peers again just before the delivery that starts one.
		if (heartbeat.mail && this.store.launch && ctx.isIdle()) await this.syncRoster(ctx).catch(() => {});
		return this.messaging.deliverMail(registration, ctx, heartbeat.mail);
	}

	afterHeartbeatSettled(): Promise<void> {
		return this.native.heartbeatManagedAgents();
	}
}
