import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import { restoreHeldParticipant } from "./held-identity.ts";
import {
	auth,
	parseHeartbeat,
	parseParticipant,
	parseRegistration,
	strictObject,
	type ClientParticipantStatus,
	type HostedHeartbeat,
	type LiveClientRegistration,
} from "./responses.ts";
import { startRuntimeService } from "./service-launch.ts";
import { HostedSessionStore, type ParticipantIdentity } from "./session-record.ts";

// ponytail: two-second host verification is fine for small teams; add Runtime subscriptions if concurrent Pi count makes it measurable.
const HEARTBEAT_MS = 2_000;

/** Everything the session lifecycle hands back to the collaborator, delivery and messaging services. */
export interface RuntimeSessionHooks {
	restoreSessionState(ctx: ExtensionContext): void;
	canAdmit(ctx: ExtensionContext): boolean;
	afterRegister(registration: LiveClientRegistration, ctx: ExtensionContext, current: () => boolean): Promise<void>;
	afterHeartbeat(
		registration: LiveClientRegistration,
		ctx: ExtensionContext,
		heartbeat: HostedHeartbeat,
		current: () => boolean,
	): Promise<void>;
	afterHeartbeatSettled(): Promise<void>;
}

/** Owns the Runtime service lifecycle, this Pi session's registration, and its heartbeat. */
export class RuntimeSession {
	readonly pi: ExtensionAPI;
	readonly root: string;
	readonly client: HostedRuntimeClient;
	readonly store: HostedSessionStore;
	private readonly hooks: RuntimeSessionHooks;
	private registration?: LiveClientRegistration;
	private registering?: Promise<LiveClientRegistration>;
	private starting?: Promise<void>;
	private heartbeatTimer?: NodeJS.Timeout;
	private sessionContext?: ExtensionContext;
	private active = false;
	private sessionEpoch = 0;
	private heartbeatActive = false;

	constructor(pi: ExtensionAPI, root: string, store: HostedSessionStore, hooks: RuntimeSessionHooks) {
		this.pi = pi;
		this.root = root;
		this.store = store;
		this.hooks = hooks;
		this.client = new HostedRuntimeClient(join(root, "runtime.sock"));
	}

	get isActive(): boolean {
		return this.active;
	}

	get context(): ExtensionContext | undefined {
		return this.sessionContext;
	}

	get liveRegistration(): LiveClientRegistration | undefined {
		return this.registration;
	}

	/** The registration a wake may act on, awaiting an in-flight registration instead of racing it. */
	async settledRegistration(): Promise<LiveClientRegistration | undefined> {
		return this.registration ?? await this.registering;
	}

	async sessionStart(ctx: ExtensionContext): Promise<void> {
		this.sessionEpoch++;
		this.active = true;
		this.sessionContext = ctx;
		this.hooks.restoreSessionState(ctx);
		this.startHeartbeat();
		if (!existsSync(this.client.socketPath)) return;
		try { await this.register(ctx); } catch {}
	}

	sessionTree(ctx: ExtensionContext): void {
		this.sessionEpoch++;
		this.sessionContext = ctx;
		this.hooks.restoreSessionState(ctx);
	}

	sessionCompact(ctx: ExtensionContext): void {
		this.sessionEpoch++;
		this.sessionContext = ctx;
	}

	async sessionShutdown(): Promise<void> {
		this.sessionEpoch++;
		this.active = false;
		this.sessionContext = undefined;
		this.stopHeartbeat();
		const registration = this.registration;
		this.registration = undefined;
		if (!registration) return;
		try {
			await this.client.call("pi.unregister", { registrationId: registration.registrationId, registrationKey: registration.registrationKey });
		} catch {}
	}

	setContext(ctx: ExtensionContext): void {
		this.sessionContext = ctx;
	}

	/** True while this Pi session, its cwd and (when given) its registration are still the ones work began on. */
	scope(ctx: ExtensionContext, registration?: LiveClientRegistration): () => boolean {
		const epoch = this.sessionEpoch;
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const cwd = ctx.cwd;
		return () => {
			if (!this.active || this.sessionEpoch !== epoch) return false;
			const current = this.sessionContext;
			if (current?.cwd !== cwd) return false;
			if (current.sessionManager.getSessionId() !== sessionId || current.sessionManager.getSessionFile() !== sessionFile) return false;
			if (!registration) return true;
			return this.registration !== undefined && sameRegistrationIdentity(this.registration, registration);
		};
	}

	requireCurrentScope(current: () => boolean): void {
		if (!current()) throw new HostedRuntimeClientError("registration_stale", "Pi session or registration changed during Runtime work.");
	}

	async requireRegistration(ctx: ExtensionContext): Promise<LiveClientRegistration> {
		if (this.registration) return this.registration;
		await this.start(ctx);
		return this.register(ctx);
	}

	async listParticipants(registration: LiveClientRegistration): Promise<ClientParticipantStatus[]> {
		const result = strictObject(await this.client.call("participant.list", auth(registration)), "Participant list");
		if (!Array.isArray(result.participants)) throw new HostedRuntimeClientError("invalid_response", "Participant list must be an array.");
		return result.participants.map(parseParticipant);
	}

	requireParticipantIdentity(): ParticipantIdentity {
		const identity = this.store.identity;
		if (!identity) {
			throw new HostedRuntimeClientError("not_found", "This Pi session has no collaborator identity. Use /runtime collaborate first.");
		}
		return identity;
	}

	start(ctx: Pick<ExtensionContext, "isProjectTrusted">): Promise<void> {
		if (this.starting) return this.starting;
		const starting = startRuntimeService(this.pi, this.client, this.root, ctx);
		this.starting = starting;
		const cleanup = () => { if (this.starting === starting) this.starting = undefined; };
		void starting.then(cleanup, cleanup);
		return starting;
	}

	register(ctx: ExtensionContext): Promise<LiveClientRegistration> {
		if (this.registering) return this.registering;
		const registration = this.registerOnce(ctx);
		this.registering = registration;
		const cleanup = () => { if (this.registering === registration) this.registering = undefined; };
		void registration.then(cleanup, cleanup);
		return registration;
	}

	private async registerOnce(ctx: ExtensionContext): Promise<LiveClientRegistration> {
		const current = this.scope(ctx);
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Runtime registration requires a trusted project.");
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new HostedRuntimeClientError("invalid_request", "Runtime requires a persisted Pi session.");
		const params = this.registrationParams(ctx, sessionFile);
		const registration = parseRegistration(await this.client.call("pi.register", params));
		if (!current()) {
			try { await this.client.call("pi.unregister", auth(registration)); } catch {}
			this.requireCurrentScope(current);
		}
		this.registration = registration;
		this.startHeartbeat();
		try {
			await restoreHeldParticipant(this, registration, ctx);
			this.requireCurrentScope(current);
			await this.hooks.afterRegister(registration, ctx, current);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			if (current()) ctx.ui.notify(`Collaborator identity or messaging unavailable: ${cause}`, "warning");
		}
		this.requireCurrentScope(current);
		return registration;
	}

	private registrationParams(ctx: ExtensionContext, sessionFile: string): RegisterPiParams {
		const worktree = this.store.worktree;
		const params: RegisterPiParams = {
			projectRoot: worktree?.projectRoot ?? realpathSync(ctx.cwd),
			piSessionId: ctx.sessionManager.getSessionId(),
			piSessionFile: realpathSync(sessionFile),
		};
		if (worktree) params.worktreePath = worktree.worktreePath;
		return params;
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) return;
		this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private async heartbeat(): Promise<void> {
		if (this.heartbeatActive || !this.active || !this.sessionContext) return;
		this.heartbeatActive = true;
		const ctx = this.sessionContext;
		const registration = this.registration;
		const current = this.scope(ctx, registration);
		try {
			if (!registration) {
				if (existsSync(this.client.socketPath)) await this.register(ctx);
				return;
			}
			await this.heartbeatOnce(registration, ctx, current);
		} catch {
			if (current()) this.registration = undefined;
		} finally {
			try { if (current()) await this.hooks.afterHeartbeatSettled(); }
			finally { this.heartbeatActive = false; }
		}
	}

	private async heartbeatOnce(registration: LiveClientRegistration, ctx: ExtensionContext, current: () => boolean): Promise<void> {
		const params = { ...auth(registration), admit: this.hooks.canAdmit(ctx) };
		const heartbeat = parseHeartbeat(await this.client.call("pi.heartbeat", params));
		this.requireCurrentScope(current);
		if (!sameRegistrationIdentity(heartbeat.registration, registration)) {
			throw new HostedRuntimeClientError("registration_stale", "Heartbeat replaced its registration identity.");
		}
		this.registration = heartbeat.registration;
		if (this.store.identity?.participantKey) await restoreHeldParticipant(this, this.registration, ctx);
		this.requireCurrentScope(current);
		await this.hooks.afterHeartbeat(this.registration, ctx, heartbeat, current);
	}
}

interface RegisterPiParams {
	projectRoot: string;
	piSessionId: string;
	piSessionFile: string;
	worktreePath?: string;
}

function sameRegistrationIdentity(left: LiveClientRegistration, right: LiveClientRegistration): boolean {
	return left.registrationId === right.registrationId
		&& left.registrationKey === right.registrationKey
		&& left.targetKey === right.targetKey;
}
