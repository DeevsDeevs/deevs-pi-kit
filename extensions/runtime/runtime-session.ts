import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import { delay, shellQuote } from "./herdr.ts";
import { HOSTED_MAX_DELIVERY_BATCH } from "./hosted-types.ts";
import {
	auth,
	parseAcquireResult,
	parseHeartbeat,
	parseParticipant,
	parseRegistration,
	strictObject,
	text,
	type ClientParticipantStatus,
	type HostedHeartbeat,
	type LiveClientRegistration,
} from "./responses.ts";
import { HostedSessionStore, type ParticipantIdentity } from "./session-record.ts";

// ponytail: two-second host verification is fine for small teams; add Runtime subscriptions if concurrent Pi count makes it measurable.
const HEARTBEAT_MS = 2_000;

export interface HostedReceipt {
	claimId: string;
	eventIds: string[];
}

/** Everything the session lifecycle hands back to the collaborator, delivery and messaging services. */
export interface RuntimeSessionHooks {
	restoreSessionState(ctx: ExtensionContext): void;
	admittedClaims(): HostedReceipt[];
	clearPendingAcks(): void;
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
			return !registration || this.registrationMatches(registration);
		};
	}

	private registrationMatches(registration: LiveClientRegistration): boolean {
		const live = this.registration;
		if (!live) return false;
		return live.registrationId === registration.registrationId
			&& live.registrationKey === registration.registrationKey
			&& live.targetKey === registration.targetKey;
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
		const starting = this.startOnce(ctx);
		this.starting = starting;
		const cleanup = () => { if (this.starting === starting) this.starting = undefined; };
		void starting.then(cleanup, cleanup);
		return starting;
	}

	private async startOnce(ctx: Pick<ExtensionContext, "isProjectTrusted">): Promise<void> {
		try {
			await this.client.hello();
			return;
		} catch {}
		if (process.env.HERDR_ENV !== "1") {
			throw new HostedRuntimeClientError("host_unavailable", "Runtime start requires this Pi session to run inside Herdr.");
		}
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Runtime start requires a trusted project.");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const workspace = await this.createServicesWorkspace();
		const serviceMain = fileURLToPath(new URL("./service/main.ts", import.meta.url));
		const command = `exec node ${shellQuote(serviceMain)} --root ${shellQuote(this.root)}`;
		const launched = await this.pi.exec("herdr", ["pane", "run", workspace.paneId, command], { timeout: 5_000 });
		if (launched.code !== 0) {
			await this.closeServicesWorkspace(workspace.workspaceId);
			throw new HostedRuntimeClientError("host_unavailable", "Herdr could not launch the Runtime service.");
		}
		for (let attempt = 0; attempt < 30; attempt++) {
			try { await this.client.hello(); return; } catch { await delay(100); }
		}
		await this.closeServicesWorkspace(workspace.workspaceId);
		throw new HostedRuntimeClientError("unavailable", "Runtime service did not become ready.");
	}

	private async createServicesWorkspace(): Promise<RuntimeServicesWorkspace> {
		const args = ["workspace", "create", "--cwd", this.root, "--label", "pi-kit-services", "--no-focus"];
		const created = await this.pi.exec("herdr", args, { timeout: 5_000 });
		if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the Runtime services workspace.");
		const result = strictObject(strictObject(JSON.parse(created.stdout), "Herdr response").result, "Herdr result");
		const workspaceId = text(strictObject(result.workspace, "Herdr workspace").workspace_id);
		const paneId = text(strictObject(result.root_pane, "Herdr root pane").pane_id);
		const tabId = text(strictObject(result.tab, "Herdr tab").tab_id);
		await this.pi.exec("herdr", ["tab", "rename", tabId, "pi-kit-runtime"], { timeout: 5_000 });
		return { workspaceId, paneId };
	}

	private async closeServicesWorkspace(workspaceId: string): Promise<void> {
		await this.pi.exec("herdr", ["workspace", "close", workspaceId], { timeout: 5_000 });
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
		this.hooks.clearPendingAcks();
		this.registration = registration;
		this.startHeartbeat();
		try {
			await this.restoreHeldParticipant(registration, ctx);
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
			admittedClaims: this.hooks.admittedClaims().slice(-HOSTED_MAX_DELIVERY_BATCH),
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
		const heartbeat = parseHeartbeat(await this.client.call("pi.heartbeat", auth(registration)));
		this.requireCurrentScope(current);
		if (!sameRegistrationIdentity(heartbeat.registration, registration)) {
			throw new HostedRuntimeClientError("registration_stale", "Heartbeat replaced its registration identity.");
		}
		this.registration = heartbeat.registration;
		if (this.store.identity?.participantKey) await this.restoreHeldParticipant(this.registration, ctx);
		this.requireCurrentScope(current);
		await this.hooks.afterHeartbeat(this.registration, ctx, heartbeat, current);
	}

	/** Re-proves a persisted held identity against Runtime, demoting it in session history when it no longer holds. */
	async restoreHeldParticipant(registration: LiveClientRegistration, ctx: ExtensionContext): Promise<void> {
		const identity = this.store.identity;
		const scope = this.scope(ctx, registration);
		const currentScope = () => scope() && this.store.identity === identity;
		if (!identity || identity.disposition !== "held") return;
		this.requireCurrentScope(currentScope);
		if (identity.participantKey && await this.verifyHeldParticipant(identity, registration, ctx, currentScope)) return;
		const acquired = parseAcquireResult(await this.client.call("participant.acquire", {
			...auth(registration),
			protocol: identity.protocol,
			participantId: identity.participantId,
			revive: identity.reviveAuthorized === true,
		}));
		this.requireCurrentScope(currentScope);
		const restored: ParticipantIdentity = {
			protocol: identity.protocol,
			participantId: identity.participantId,
			participantKey: acquired.participant.participantKey,
			generation: acquired.participant.generation,
			disposition: "held",
		};
		const changed = identity.participantKey !== restored.participantKey || identity.generation !== restored.generation;
		if (changed) this.store.persistIdentity(restored);
	}

	/** True when the persisted key resolved and no further acquisition should follow. */
	private async verifyHeldParticipant(
		identity: ParticipantIdentity,
		registration: LiveClientRegistration,
		ctx: ExtensionContext,
		currentScope: () => boolean,
	): Promise<boolean> {
		const participantKey = identity.participantKey;
		if (!participantKey) return false;
		let current: ClientParticipantStatus;
		try {
			current = parseParticipant(await this.client.call("participant.get", { ...auth(registration), participantKey }));
		} catch (error) {
			this.requireCurrentScope(currentScope);
			if (!(error instanceof HostedRuntimeClientError) || error.code !== "not_found") throw error;
			this.store.persistIdentity({ protocol: identity.protocol, participantId: identity.participantId, disposition: "vacant" });
			const name = `${identity.protocol}/${identity.participantId}`;
			ctx.ui.notify(`Collaborator ${name} is absent from Runtime; explicit acquire is required.`, "warning");
			return true;
		}
		this.requireCurrentScope(currentScope);
		if (current.protocol !== identity.protocol || current.participantId !== identity.participantId) {
			this.store.persistIdentity({ protocol: identity.protocol, participantId: identity.participantId, disposition: "vacant" });
			const name = `${identity.protocol}/${identity.participantId}`;
			ctx.ui.notify(`Collaborator identity key does not match ${name}; explicit acquire is required.`, "warning");
			return true;
		}
		if (current.state === "held" && current.holderTargetKey === registration.targetKey) return false;
		this.store.persistIdentity({
			...identity,
			participantKey: current.participantKey,
			generation: current.generation,
			disposition: current.state === "ended" ? "ended" : "vacant",
		});
		const name = `${identity.protocol}/${identity.participantId}`;
		ctx.ui.notify(`Collaborator ${name} is ${current.state}; explicit acquire or takeover is required.`, "warning");
		return true;
	}
}

interface RuntimeServicesWorkspace {
	workspaceId: string;
	paneId: string;
}

interface RegisterPiParams {
	projectRoot: string;
	piSessionId: string;
	piSessionFile: string;
	admittedClaims: HostedReceipt[];
	worktreePath?: string;
}

function sameRegistrationIdentity(left: LiveClientRegistration, right: LiveClientRegistration): boolean {
	return left.registrationId === right.registrationId
		&& left.registrationKey === right.registrationKey
		&& left.targetKey === right.targetKey;
}
