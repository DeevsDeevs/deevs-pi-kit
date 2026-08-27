import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { HOSTED_BRIDGE_FORBIDDEN_METADATA_KEYS, HOSTED_BRIDGE_MAX_METADATA_ENTRIES, HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES, type HostedBridgeLaunch, type HostedBridgeTarget, type HostedCollaboratorProfile } from "../hosted-types.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveRegistration, type RegisterBridgeInput } from "./registration.ts";
import { deriveParticipantKey, HostedStateStore } from "./state.ts";

const DEFAULT_LAUNCH_LEASE_MS = 30_000;
const TOKEN = /^bridge_launch_([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FORBIDDEN_METADATA = new Set<string>(HOSTED_BRIDGE_FORBIDDEN_METADATA_KEYS);

export class HostedBridgeError extends Error {
	readonly code: "invalid_request" | "not_found" | "conflict" | "capability_unavailable" | "identity_mismatch";

	constructor(code: HostedBridgeError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

export interface CreateBridgeLaunchInput {
	requestId: string;
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
		const callerTarget = this.store.read().targets[caller.targetKey];
		if (callerTarget?.kind !== "pi") throw new HostedBridgeError("conflict", "Only an authenticated Pi target may authorize a bridge launch.");
		if (!this.host.getPaneIdentity) throw new HostedBridgeError("capability_unavailable", "Herdr pane identity verification is unavailable.");
		const pane = await this.host.getPaneIdentity(input.herdr.paneId);
		if (pane.paneId !== input.herdr.paneId || pane.terminalId !== input.herdr.terminalId || pane.paneCount !== 1 || pane.agent !== undefined) throw new HostedBridgeError("identity_mismatch", "Bridge launch pane is not the exact empty single-pane Herdr target.");
		let projectRoot: string;
		let paneRoot: string;
		try {
			projectRoot = realpathSync(callerTarget.projectRoot);
			paneRoot = realpathSync(pane.cwd);
		} catch {
			throw new HostedBridgeError("identity_mismatch", "Bridge project or pane cwd is unavailable.");
		}
		if (paneRoot !== projectRoot) throw new HostedBridgeError("identity_mismatch", "Bridge pane cwd does not match the caller project.");
		const protocol = participantName(input.protocol, "protocol");
		const participantId = participantName(input.participantId, "participant ID");
		const requestId = bounded(input.requestId, "request ID", 200);
		const callerParticipantKey = bounded(input.callerParticipantKey, "caller participant key", 200);
		const callerGeneration = bounded(input.expectedCallerGeneration, "caller generation", 200);
		const configurationHash = digest(input.configurationHash, "configuration hash");
		if (input.profile !== "read-only" && input.profile !== "workspace-write") throw new HostedBridgeError("invalid_request", "Bridge profile must be read-only or workspace-write.");
		const metadata = bridgeMetadata(input.metadata ?? {});
		const launchId = this.options.createId?.() ?? `launch_${randomUUID()}`;
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(launchId)) throw new HostedBridgeError("invalid_request", "Bridge launch ID has invalid syntax.");
		const holderGeneration = this.options.createGeneration?.() ?? `lease_${randomUUID()}`;
		const launchSecret = secret(this.options.createSecret?.() ?? randomBytes(32).toString("base64url"));
		const reconnectSecret = secret(this.options.createSecret?.() ?? randomBytes(32).toString("base64url"));
		const launchToken = `bridge_launch_${launchId}.${launchSecret}`;
		const targetKey = deriveBridgeTargetKey(projectRoot, launchId);
		const now = this.now();
		const launch: HostedBridgeLaunch = {
			version: 1,
			launchId,
			requestId,
			launchDigest: sha256(launchToken),
			reconnectDigest: sha256(reconnectSecret),
			callerParticipantKey,
			callerGeneration,
			callerTargetKey: caller.targetKey,
			participantKey: deriveParticipantKey(projectRoot, protocol, participantId),
			protocol,
			participantId,
			...(input.expectedParticipantGeneration ? { expectedParticipantGeneration: bounded(input.expectedParticipantGeneration, "expected participant generation", 200) } : {}),
			holderGeneration,
			targetKey,
			projectRoot,
			profile: input.profile,
			configurationHash,
			herdr: { paneId: pane.paneId, terminalId: pane.terminalId, tabId: pane.tabId, workspaceId: pane.workspaceId },
			metadata,
			createdAt: now,
			expiresAt: now + (this.options.leaseMs ?? DEFAULT_LAUNCH_LEASE_MS),
			status: "pending",
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
		await verifyBridgeAgent(this.host, target, input.herdr);
		this.store.apply({ type: "bridge.launch.consume", launchId: launch.launchId, launchDigest: launch.launchDigest, clientGeneration: input.clientGeneration, target, at: now });
		const registration = await this.registrations.registerBridge(input, target, bridgeCredentials(target.targetKey, input.reconnectToken));
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
}

export function deriveBridgeTargetKey(projectRoot: string, launchId: string): string {
	return `bridge_${createHash("sha256").update(projectRoot).update("\0").update(launchId).digest("hex")}`;
}

function bridgeTarget(launch: HostedBridgeLaunch, clientGeneration: string, createdAt: number): HostedBridgeTarget {
	return { kind: "bridge", targetKey: launch.targetKey, projectRoot: launch.projectRoot, bridgeId: launch.launchId, participantKey: launch.participantKey, holderGeneration: launch.holderGeneration, profile: launch.profile, configurationHash: launch.configurationHash, clientGeneration: bounded(clientGeneration, "client generation", 200), reconnectDigest: launch.reconnectDigest, herdr: launch.herdr, metadata: launch.metadata, createdAt };
}

async function verifyBridgeAgent(host: HostedHostVerifier, target: HostedBridgeTarget, herdr: { paneId: string; terminalId: string }): Promise<void> {
	const agent = await host.getPane(herdr.paneId);
	let cwd: string;
	try { cwd = realpathSync(agent.cwd); } catch { throw new HostedBridgeError("identity_mismatch", "Bridge agent cwd is unavailable."); }
	if (agent.paneId !== herdr.paneId || agent.terminalId !== herdr.terminalId || agent.paneId !== target.herdr.paneId || agent.terminalId !== target.herdr.terminalId || agent.tabId !== target.herdr.tabId || agent.workspaceId !== target.herdr.workspaceId || cwd !== target.projectRoot || agent.agentSession.source !== "pi-kit-bridge" || agent.agentSession.agent !== "bridge" || agent.agentSession.kind !== "id" || agent.agentSession.value !== target.bridgeId) throw new HostedBridgeError("identity_mismatch", "Bridge process does not match the exact authorized Herdr identity.");
}

function bridgeCredentials(targetKey: string, reconnectToken: string): { registrationId: string; registrationKey: string } {
	const token = secret(reconnectToken);
	return {
		registrationId: `reg_bridge_${createHash("sha256").update("id\0").update(targetKey).update("\0").update(token).digest("hex").slice(0, 40)}`,
		registrationKey: createHash("sha256").update("key\0").update(targetKey).update("\0").update(token).digest("base64url"),
	};
}

function result(registration: HostedLiveRegistration, target: HostedBridgeTarget): BridgeRegistrationResult {
	return { registration, participantKey: target.participantKey, holderGeneration: target.holderGeneration, profile: target.profile, configurationHash: target.configurationHash, metadata: target.metadata };
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
		if (!NAME.test(key) || FORBIDDEN_METADATA.has(key) || typeof item !== "string" || Buffer.byteLength(item) > HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES) throw new HostedBridgeError("invalid_request", "Bridge metadata is invalid, reserved, or exceeds its byte limit.");
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
