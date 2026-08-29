import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { HOSTED_BRIDGE_MAX_METADATA_ENTRIES, HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES, type HostedBridgeLaunch, type HostedBridgeTarget, type HostedCollaboratorProfile } from "../hosted-types.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveRegistration, type RegisterBridgeInput } from "./registration.ts";
import { deriveBridgeTargetKey, deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_LAUNCH_LEASE_MS = 30_000;
const TOKEN = /^bridge_launch_([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ALLOWED_METADATA = new Set(["adapter"]);

export class HostedBridgeError extends Error {
	readonly code: "invalid_request" | "not_found" | "conflict" | "capability_unavailable" | "identity_mismatch";

	constructor(code: HostedBridgeError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

export interface CreateBridgeLaunchInput {
	requestId: string;
	launchId?: string;
	workspaceId?: string;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	protocol: string;
	participantId: string;
	expectedParticipantGeneration?: string;
	profile: HostedCollaboratorProfile;
	configurationHash: string;
	herdr: { paneId: string; terminalId: string };
	metadata?: Record<string, string>;
}

export interface BridgeRegisterInput extends RegisterBridgeInput {
	launchToken: string;
	reconnectToken: string;
}

export interface BridgeReconnectInput extends RegisterBridgeInput {
	targetKey: string;
	reconnectToken: string;
}

export interface BridgeCoordinatorOptions {
	now?: () => number;
	leaseMs?: number;
	createId?: () => string;
	createGeneration?: () => string;
	createSecret?: () => string;
}

export class RuntimeBridgeCoordinator {
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly host: HostedHostVerifier;
	private readonly options: BridgeCoordinatorOptions;

	constructor(store: HostedStateStore, registrations: RuntimeRegistrationManager, host: HostedHostVerifier, options: BridgeCoordinatorOptions = {}) {
		this.store = store;
		this.registrations = registrations;
		this.host = host;
		this.options = options;
	}

	async create(caller: HostedLiveRegistration, input: CreateBridgeLaunchInput): Promise<{ launchId: string; targetKey: string; holderGeneration: string; expiresAt: number; launchToken: string; reconnectToken: string; herdr: HostedBridgeLaunch["herdr"] }> {
		const state = this.store.read();
		const callerTarget = state.targets[caller.targetKey];
		if (callerTarget?.kind !== "pi") throw new HostedBridgeError("conflict", "Only an authenticated Pi target may authorize a bridge launch.");
		const projectRoot = realpathSync(callerTarget.projectRoot);
		const protocol = participantName(input.protocol, "protocol");
		const participantId = participantName(input.participantId, "participant ID");
		const requestId = bounded(input.requestId, "request ID", 200);
		const callerParticipantKey = bounded(input.callerParticipantKey, "caller participant key", 200);
		const callerGeneration = bounded(input.expectedCallerGeneration, "caller generation", 200);
		const expectedParticipantGeneration = input.expectedParticipantGeneration ? bounded(input.expectedParticipantGeneration, "expected participant generation", 200) : undefined;
		const configurationHash = digest(input.configurationHash, "configuration hash");
		if (input.profile !== "read-only" && input.profile !== "workspace-write") throw new HostedBridgeError("invalid_request", "Bridge profile must be read-only or workspace-write.");
		const metadata = bridgeMetadata(input.metadata ?? {});
		const requestedLaunchId = input.launchId === undefined ? undefined : bounded(input.launchId, "launch ID", 200);
		const requestedWorkspaceId = input.workspaceId === undefined ? undefined : bounded(input.workspaceId, "workspace ID", 200);
		const prior = Object.values(state.bridgeLaunches).find((candidate) => candidate.callerTargetKey === caller.targetKey && candidate.requestId === requestId);
		if (prior) {
			if (prior.callerParticipantKey !== callerParticipantKey || prior.callerGeneration !== callerGeneration || prior.protocol !== protocol || prior.participantId !== participantId || prior.expectedParticipantGeneration !== expectedParticipantGeneration || prior.profile !== input.profile || prior.configurationHash !== configurationHash || prior.workspaceId !== requestedWorkspaceId || requestedLaunchId !== undefined && prior.launchId !== requestedLaunchId || JSON.stringify(prior.metadata) !== JSON.stringify(metadata)) throw new HostedBridgeError("conflict", "Bridge request ID was reused with different authority.");
			throw new HostedBridgeError("conflict", `Bridge request ${requestId} already exists and requires explicit recovery.`);
		}
		const workspace = requestedWorkspaceId ? state.workspaces[requestedWorkspaceId] : undefined;
		if (input.profile === "workspace-write" ? !workspace || workspace.ownerKind !== "bridge" || workspace.bridgeId !== requestedLaunchId || workspace.state !== "bound" || workspace.projectRoot !== projectRoot || workspace.callerTargetKey !== caller.targetKey || workspace.callerParticipantKey !== callerParticipantKey || workspace.callerGeneration !== callerGeneration || workspace.protocol !== protocol || workspace.participantId !== participantId || workspace.expectedParticipantGeneration !== expectedParticipantGeneration : requestedWorkspaceId !== undefined) throw new HostedBridgeError("conflict", "Bridge workspace authority is absent or does not match the launch.");
		if (!this.host.getPaneIdentity) throw new HostedBridgeError("capability_unavailable", "Herdr pane identity verification is unavailable.");
		const pane = await this.host.getPaneIdentity(input.herdr.paneId);
		if (pane.paneId !== input.herdr.paneId || pane.terminalId !== input.herdr.terminalId || pane.paneCount !== 1 || pane.agent !== undefined) throw new HostedBridgeError("identity_mismatch", "Bridge launch pane is not the exact empty single-pane Herdr target.");
		let paneRoot: string;
		try { paneRoot = realpathSync(pane.cwd); } catch { throw new HostedBridgeError("identity_mismatch", "Bridge pane cwd is unavailable."); }
		const expectedCwd = workspace?.worktreePath ?? projectRoot;
		if (paneRoot !== expectedCwd || workspace?.herdr && JSON.stringify(workspace.herdr) !== JSON.stringify({ paneId: pane.paneId, terminalId: pane.terminalId, tabId: pane.tabId, workspaceId: pane.workspaceId })) throw new HostedBridgeError("identity_mismatch", "Bridge pane cwd or host identity does not match its authority.");
		const launchId = requestedLaunchId ?? this.options.createId?.() ?? `launch_${randomUUID()}`;
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(launchId)) throw new HostedBridgeError("invalid_request", "Bridge launch ID has invalid syntax.");
		const holderGeneration = workspace?.holderGeneration ?? this.options.createGeneration?.() ?? `lease_${randomUUID()}`;
		const launchSecret = secret(this.options.createSecret?.() ?? randomBytes(32).toString("base64url"));
		const reconnectSecret = secret(this.options.createSecret?.() ?? randomBytes(32).toString("base64url"));
		const launchToken = `bridge_launch_${launchId}.${launchSecret}`;
		const targetKey = workspace?.targetKey ?? deriveBridgeTargetKey(projectRoot, launchId);
		const now = this.now();
		const launch: HostedBridgeLaunch = {
			version: 1, launchId, requestId, launchDigest: sha256(launchToken), reconnectDigest: sha256(reconnectSecret), callerParticipantKey, callerGeneration, callerTargetKey: caller.targetKey, participantKey: deriveParticipantKey(projectRoot, protocol, participantId), protocol, participantId, ...(expectedParticipantGeneration ? { expectedParticipantGeneration } : {}), holderGeneration, targetKey, projectRoot, profile: input.profile, configurationHash, herdr: { paneId: pane.paneId, terminalId: pane.terminalId, tabId: pane.tabId, workspaceId: pane.workspaceId }, ...(workspace ? { workspaceId: workspace.workspaceId, workspaceRoot: workspace.worktreePath } : {}), metadata, createdAt: now, expiresAt: now + (this.options.leaseMs ?? DEFAULT_LAUNCH_LEASE_MS), status: "pending",
		};
		this.store.apply({ type: "bridge.launch.ensure", launch });
		return { launchId, targetKey, holderGeneration, expiresAt: launch.expiresAt, launchToken, reconnectToken: reconnectSecret, herdr: launch.herdr };
	}

	async register(input: BridgeRegisterInput): Promise<BridgeRegistrationResult> {
		const parsed = parseLaunchToken(input.launchToken);
		const launch = this.store.read().bridgeLaunches[parsed.launchId];
		if (!launch || !equalDigest(sha256(input.launchToken), launch.launchDigest) || !equalDigest(sha256(secret(input.reconnectToken)), launch.reconnectDigest)) throw new HostedBridgeError("conflict", "Bridge launch capability is absent or does not match.");
		const now = this.now();
		if (launch.status === "pending" && now > launch.expiresAt) {
			this.store.apply({ type: "bridge.launch.expire", launchId: launch.launchId, at: now });
			throw new HostedBridgeError("conflict", "Bridge launch capability expired.");
		}
		if (launch.status !== "pending") throw new HostedBridgeError("conflict", "Bridge launch capability is no longer pending; reconnect with the separate credential.");
		const target = bridgeTarget(launch, input.clientGeneration, now);
		const registration = await this.registrations.registerBridge(input, target, bridgeCredentials(target.targetKey, input.reconnectToken), () => this.store.apply({ type: "bridge.launch.consume", launchId: launch.launchId, launchDigest: launch.launchDigest, clientGeneration: input.clientGeneration, target, at: now }));
		return result(registration, target);
	}

	async reconnect(input: BridgeReconnectInput): Promise<BridgeRegistrationResult> {
		const target = this.store.read().targets[input.targetKey];
		if (!target || target.kind !== "bridge") throw new HostedBridgeError("not_found", "Bridge target does not exist.");
		if (input.clientGeneration !== target.clientGeneration || !equalDigest(sha256(secret(input.reconnectToken)), target.reconnectDigest)) throw new HostedBridgeError("conflict", "Bridge reconnect authority does not match its target generation.");
		const participant = this.store.read().participants[target.participantKey];
		if (!participant || participant.state !== "held" || participant.holderTargetKey !== target.targetKey || participant.generation !== target.holderGeneration) throw new HostedBridgeError("conflict", "Bridge participant generation is no longer held.");
		const registration = await this.registrations.registerBridge(input, target, bridgeCredentials(target.targetKey, input.reconnectToken));
		return result(registration, target);
	}

	recoverLaunch(caller: HostedLiveRegistration, input: { requestId: string; callerParticipantKey: string; expectedCallerGeneration: string }): HostedBridgeLaunch {
		const requestId = bounded(input.requestId, "request ID", 200);
		const launch = Object.values(this.store.read().bridgeLaunches).find((candidate) => candidate.callerTargetKey === caller.targetKey && candidate.requestId === requestId);
		if (!launch) throw new HostedBridgeError("not_found", "Bridge launch request does not exist.");
		if (launch.callerParticipantKey !== bounded(input.callerParticipantKey, "caller participant key", 200) || launch.callerGeneration !== bounded(input.expectedCallerGeneration, "caller generation", 200)) throw new HostedBridgeError("conflict", "Bridge launch recovery authority changed.");
		if (launch.status === "pending") this.store.apply({ type: "bridge.launch.cancel", launchId: launch.launchId, callerTargetKey: caller.targetKey, callerParticipantKey: launch.callerParticipantKey, callerGeneration: launch.callerGeneration, at: this.now() });
		return this.store.read().bridgeLaunches[launch.launchId]!;
	}

	cancel(caller: HostedLiveRegistration, input: { launchId: string; callerParticipantKey: string; expectedCallerGeneration: string }): void {
		this.store.apply({ type: "bridge.launch.cancel", launchId: bounded(input.launchId, "launch ID", 200), callerTargetKey: caller.targetKey, callerParticipantKey: bounded(input.callerParticipantKey, "caller participant key", 200), callerGeneration: bounded(input.expectedCallerGeneration, "caller generation", 200), at: this.now() });
	}

	private now(): number { return this.options.now?.() ?? Date.now(); }
}

export interface BridgeRegistrationResult {
	registration: HostedLiveRegistration;
	participantKey: string;
	holderGeneration: string;
	profile: HostedCollaboratorProfile;
	configurationHash: string;
	metadata: Record<string, string>;
	projectRoot: string;
	cwd: string;
	workspaceId?: string;
}

function bridgeTarget(launch: HostedBridgeLaunch, clientGeneration: string, createdAt: number): HostedBridgeTarget {
	return { kind: "bridge", targetKey: launch.targetKey, projectRoot: launch.projectRoot, bridgeId: launch.launchId, participantKey: launch.participantKey, holderGeneration: launch.holderGeneration, profile: launch.profile, configurationHash: launch.configurationHash, clientGeneration: bounded(clientGeneration, "client generation", 200), reconnectDigest: launch.reconnectDigest, herdr: launch.herdr, ...(launch.workspaceId ? { workspaceId: launch.workspaceId, workspaceRoot: launch.workspaceRoot! } : {}), metadata: launch.metadata, createdAt };
}

function bridgeCredentials(targetKey: string, reconnectToken: string): { registrationId: string; registrationKey: string } {
	const token = secret(reconnectToken);
	return {
		registrationId: `reg_bridge_${createHash("sha256").update("id\0").update(targetKey).update("\0").update(token).digest("hex").slice(0, 40)}`,
		registrationKey: createHash("sha256").update("key\0").update(targetKey).update("\0").update(token).digest("base64url"),
	};
}

function result(registration: HostedLiveRegistration, target: HostedBridgeTarget): BridgeRegistrationResult {
	return { registration, participantKey: target.participantKey, holderGeneration: target.holderGeneration, profile: target.profile, configurationHash: target.configurationHash, metadata: target.metadata, projectRoot: target.projectRoot, cwd: target.workspaceRoot ?? target.projectRoot, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) };
}

function parseLaunchToken(value: string): { launchId: string } {
	const match = TOKEN.exec(value);
	if (!match) throw new HostedBridgeError("invalid_request", "Bridge launch token has invalid syntax.");
	return { launchId: match[1]! };
}

function bridgeMetadata(value: Record<string, string>): Record<string, string> {
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	if (entries.length > HOSTED_BRIDGE_MAX_METADATA_ENTRIES) throw new HostedBridgeError("invalid_request", `Bridge metadata may contain at most ${HOSTED_BRIDGE_MAX_METADATA_ENTRIES} entries.`);
	return Object.fromEntries(entries.map(([key, item]) => {
		if (!NAME.test(key) || !ALLOWED_METADATA.has(key) || typeof item !== "string" || Buffer.byteLength(item) > HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES) throw new HostedBridgeError("invalid_request", "Bridge metadata is not allowlisted or exceeds its byte limit.");
		return [key, item];
	}));
}

function participantName(value: string, name: string): string {
	if (!NAME.test(value)) throw new HostedBridgeError("invalid_request", `${name} has invalid syntax.`);
	return value;
}

function bounded(value: string, name: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes) throw new HostedBridgeError("invalid_request", `${name} must be a non-empty string of at most ${maxBytes} bytes.`);
	return value;
}

function digest(value: string, name: string): string {
	if (!HASH.test(value)) throw new HostedBridgeError("invalid_request", `${name} must be a lowercase SHA-256 digest.`);
	return value;
}

function secret(value: string): string {
	if (!SECRET.test(value)) throw new HostedBridgeError("invalid_request", "Bridge secret has invalid syntax.");
	return value;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function equalDigest(left: string, right: string): boolean {
	if (!HASH.test(left) || !HASH.test(right)) return false;
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
