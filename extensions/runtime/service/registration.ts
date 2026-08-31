import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { quiesceBridgeRunner } from "../legacy-bridge/stop.ts";
import type { HostedExternalTarget, HostedParticipant, HostedPiTarget, HostedTarget } from "../hosted-types.ts";
import { HostedStateStore } from "./state.ts";

const REGISTRATION_LEASE_MS = 30_000;
const MAX_ADMITTED_CLAIMS = 12;

export type RegistrationErrorCode = "invalid_request" | "not_found" | "conflict" | "registration_stale" | "identity_mismatch" | "host_unavailable";

export class RegistrationError extends Error {
	readonly code: RegistrationErrorCode;

	constructor(code: RegistrationErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface HostedAgentSessionIdentity {
	source: string;
	agent: string;
	kind: "id" | "path";
	value: string;
}

export type HostedAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HostedLiveAgent {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	terminalId: string;
	cwd: string;
	name?: string;
	agentSession: HostedAgentSessionIdentity;
	status: HostedAgentStatus;
	focused?: boolean;
	stateChangeSeq: number;
}

export interface HostedPaneIdentity {
	paneId: string;
	tabId: string;
	workspaceId: string;
	terminalId: string;
	cwd: string;
	agent?: string;
	paneCount: number;
	revision: number;
}

export interface HostedHostVerifier {
	getPane(paneId: string): Promise<HostedLiveAgent>;
	findTerminal(terminalId: string): Promise<HostedLiveAgent>;
	getPaneIdentity?(paneId: string): Promise<HostedPaneIdentity>;
	closeTarget?(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged">;
}

export interface RegisterWorkspacePiInput {
	piSessionId: string;
	piSessionFile: string;
	clientGeneration: string;
	admittedClaims: Array<{ claimId: string; eventIds: string[] }>;
	herdr: { paneId: string; terminalId: string; agentName?: string };
}

export interface RegisterBridgeInput {
	clientGeneration: string;
	admittedClaims: Array<{ claimId: string; eventIds: string[] }>;
	herdr: { paneId: string; terminalId: string };
}

export interface RegisterPiInput {
	projectRoot: string;
	piSessionId: string;
	piSessionFile: string;
	clientGeneration: string;
	admittedClaims: Array<{ claimId: string; eventIds: string[] }>;
	herdr: { paneId: string; terminalId: string; agentName?: string };
}

export interface HostedLiveRegistration {
	targetKey: string;
	registrationId: string;
	registrationKey: string;
	clientGeneration: string;
	leaseUntil: number;
	host: HostedLiveAgent;
}

export interface RegistrationManagerOptions {
	now?: () => number;
	createId?: () => string;
	createKey?: () => string;
	leaseMs?: number;
	onReady?: (targetKey: string) => void;
}

export class RuntimeRegistrationManager {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly options: RegistrationManagerOptions;
	private readonly registrations = new Map<string, HostedLiveRegistration>();
	private readonly byTarget = new Map<string, string>();
	private readonly byTerminal = new Map<string, string>();
	private readonly verifications = new Map<string, Promise<HostedLiveRegistration>>();
	private closed = false;

	constructor(store: HostedStateStore, host: HostedHostVerifier, options: RegistrationManagerOptions = {}) {
		this.store = store;
		this.host = host;
		this.options = options;
	}

	async register(input: RegisterPiInput): Promise<HostedLiveRegistration> {
		const projectRoot = canonicalDirectory(input.projectRoot, "project root");
		const piSessionFile = canonicalFile(input.piSessionFile, "Pi session file");
		verifyPiSessionHeader(piSessionFile, input.piSessionId, projectRoot);
		const targetKey = deriveTargetKey(projectRoot, input.piSessionId);
		const verified = await this.host.getPane(input.herdr.paneId);
		this.ensureOpen();
		verifyIdentity(verified, { ...input, projectRoot, piSessionFile }, false);
		this.validateAdmissions(targetKey, input.admittedClaims);
		const target: HostedTarget = { kind: "pi", targetKey, projectRoot, piSessionId: input.piSessionId, piSessionFile, createdAt: this.now() };
		this.store.apply({ type: "target.ensure", target });
		return this.install(targetKey, input.clientGeneration, input.admittedClaims, verified);
	}

	async registerWorkspacePi(input: RegisterWorkspacePiInput, target: HostedPiTarget, onVerified?: () => void): Promise<HostedLiveRegistration> {
		if (!target.workspaceId || !target.workspaceRoot || target.piSessionId !== input.piSessionId || target.targetKey !== deriveTargetKey(target.projectRoot, input.piSessionId)) throw new RegistrationError("conflict", "Workspace Pi target does not match its session authority.");
		const sessionFile = canonicalFile(input.piSessionFile, "Pi session file");
		if (sessionFile !== target.piSessionFile) throw new RegistrationError("identity_mismatch", "Workspace Pi session file changed.");
		verifyPiSessionHeader(sessionFile, input.piSessionId, target.workspaceRoot);
		const verified = await this.host.getPane(input.herdr.paneId);
		this.ensureOpen();
		verifyIdentity(verified, { projectRoot: target.projectRoot, piSessionId: input.piSessionId, piSessionFile: sessionFile, clientGeneration: input.clientGeneration, admittedClaims: input.admittedClaims, herdr: input.herdr }, false, target.workspaceRoot);
		this.validateAdmissions(target.targetKey, input.admittedClaims);
		onVerified?.();
		const durable = this.store.read().targets[target.targetKey];
		const workspace = target.workspaceId ? this.store.read().workspaces[target.workspaceId] : undefined;
		const participant = workspace ? this.store.read().participants[workspace.participantKey] : undefined;
		if (!durable || durable.kind !== "pi" || !samePiTarget(durable, target) || !workspace || workspace.state !== "active" || !workspaceRegistrationAllowed(participant, target, workspace.holderGeneration)) throw new RegistrationError("registration_stale", "Workspace Pi target or participant succession changed during registration.");
		return this.install(target.targetKey, input.clientGeneration, input.admittedClaims, verified);
	}

	async registerBridge(input: RegisterBridgeInput, target: HostedExternalTarget, credentials: { registrationId: string; registrationKey: string }, onVerified?: () => void): Promise<HostedLiveRegistration> {
		const durable = this.store.read().targets[target.targetKey];
		if (!onVerified && (!durable || (durable.kind !== "bridge" && durable.kind !== "agent") || !sameBridgeTarget(durable, target))) throw new RegistrationError("conflict", "Bridge target does not match durable launch authority.");
		if (this.host.getPaneIdentity) {
			const pane = await this.host.getPaneIdentity(input.herdr.paneId);
			if (pane.paneCount !== 1 || pane.paneId !== target.herdr.paneId || pane.terminalId !== target.herdr.terminalId || pane.tabId !== target.herdr.tabId || pane.workspaceId !== target.herdr.workspaceId) throw new RegistrationError("identity_mismatch", "Bridge tab is not the exact authorized single-pane Herdr target.");
		}
		const verified = await this.host.getPane(input.herdr.paneId);
		this.ensureOpen();
		verifyBridgeIdentity(verified, target, input.herdr, false);
		this.validateAdmissions(target.targetKey, input.admittedClaims);
		onVerified?.();
		const currentTarget = this.store.read().targets[target.targetKey];
		if (!currentTarget || (currentTarget.kind !== "bridge" && currentTarget.kind !== "agent") || !sameBridgeTarget(currentTarget, target)) throw new RegistrationError("registration_stale", "Bridge target changed during host verification.");
		const participant = this.store.read().participants[target.participantKey];
		const workspace = target.workspaceId ? this.store.read().workspaces[target.workspaceId] : undefined;
		if (!participant || participant.state !== "held" || participant.holderTargetKey !== target.targetKey || participant.generation !== target.holderGeneration || target.workspaceId && (!workspace || workspace.state !== "active" || workspace.targetKey !== target.targetKey || workspace.holderGeneration !== target.holderGeneration)) throw new RegistrationError("registration_stale", "Bridge participant or workspace generation changed during host verification.");
		return this.install(target.targetKey, input.clientGeneration, input.admittedClaims, verified, credentials);
	}

	async heartbeat(registrationId: string, registrationKey: string): Promise<HostedLiveRegistration> {
		const registration = await this.verify(registrationId, registrationKey, true);
		this.ready(registration.targetKey);
		return registration;
	}

	async verifyTarget(targetKey: string): Promise<HostedLiveRegistration> {
		this.expire();
		const registrationId = this.byTarget.get(targetKey);
		const registration = registrationId ? this.registrations.get(registrationId) : undefined;
		if (!registration) throw new RegistrationError("registration_stale", "Target has no live registration.");
		return this.verify(registration.registrationId, registration.registrationKey, false);
	}

	unregister(registrationId: string, registrationKey: string): void {
		this.authorize(registrationId, registrationKey);
		this.drop(registrationId);
	}

	authorize(registrationId: string, registrationKey: string): HostedLiveRegistration {
		this.expire();
		const registration = this.registrations.get(registrationId);
		if (!registration || registration.registrationKey !== registrationKey) throw new RegistrationError("registration_stale", "Registration is absent, expired, or does not match its key.");
		return registration;
	}

	isLiveTarget(targetKey: string): boolean {
		this.expire();
		return this.byTarget.has(targetKey);
	}

	hasLiveTarget(targetKey: string): boolean { return this.isLiveTarget(targetKey); }

	close(): void {
		this.closed = true;
		this.registrations.clear();
		this.byTarget.clear();
		this.byTerminal.clear();
		this.verifications.clear();
	}

	private install(targetKey: string, clientGeneration: string, admittedClaims: Array<{ claimId: string; eventIds: string[] }>, verified: HostedLiveAgent, credentials?: { registrationId: string; registrationKey: string }): HostedLiveRegistration {
		this.expire();
		const existingId = this.byTarget.get(targetKey);
		const existing = existingId ? this.registrations.get(existingId) : undefined;
		if (existing && existing.host.terminalId !== verified.terminalId) throw new RegistrationError("conflict", "Another live terminal owns this target.");
		this.validateAdmissions(targetKey, admittedClaims);
		if (existing && existing.clientGeneration === clientGeneration && existing.host.terminalId === verified.terminalId) {
			if (credentials && (existing.registrationId !== credentials.registrationId || existing.registrationKey !== credentials.registrationKey)) throw new RegistrationError("conflict", "Bridge registration credentials changed for an active target.");
			this.reconcileAdmissions(targetKey, admittedClaims);
			const renewed = { ...existing, leaseUntil: this.now() + this.leaseMs(), host: verified };
			this.registrations.set(renewed.registrationId, renewed);
			this.ready(renewed.targetKey);
			return renewed;
		}
		const terminalRegistrationId = this.byTerminal.get(verified.terminalId);
		const registrationId = credentials?.registrationId ?? this.options.createId?.() ?? `reg_${randomUUID()}`;
		const registrationKey = credentials?.registrationKey ?? this.options.createKey?.() ?? randomBytes(32).toString("base64url");
		const collision = this.registrations.get(registrationId);
		if (collision && collision.targetKey !== targetKey) throw new RegistrationError("conflict", "Registration ID already belongs to another target.");
		this.reconcileAdmissions(targetKey, admittedClaims);
		if (existing) this.drop(existing.registrationId);
		if (terminalRegistrationId) this.drop(terminalRegistrationId);
		const registration: HostedLiveRegistration = { targetKey, registrationId, registrationKey, clientGeneration, leaseUntil: this.now() + this.leaseMs(), host: verified };
		this.registrations.set(registration.registrationId, registration);
		this.byTarget.set(targetKey, registration.registrationId);
		this.byTerminal.set(verified.terminalId, registration.registrationId);
		this.ready(registration.targetKey);
		return registration;
	}

	private verify(registrationId: string, registrationKey: string, renew: boolean): Promise<HostedLiveRegistration> {
		const prior = this.verifications.get(registrationId) ?? Promise.resolve(undefined);
		const verification = prior.catch(() => undefined).then(async () => {
			const current = this.authorize(registrationId, registrationKey);
			const verified = await this.host.findTerminal(current.host.terminalId);
			this.ensureOpen();
			if (this.registrations.get(registrationId) !== current) throw new RegistrationError("registration_stale", "Registration changed while its host identity was being verified.");
			const target = this.store.read().targets[current.targetKey];
			if (!target) throw new RegistrationError("not_found", "Runtime target no longer exists.");
			if (target.kind === "pi") {
				verifyIdentity(verified, { projectRoot: target.projectRoot, piSessionId: target.piSessionId, piSessionFile: target.piSessionFile, clientGeneration: current.clientGeneration, admittedClaims: [], herdr: { paneId: current.host.paneId, terminalId: current.host.terminalId, agentName: current.host.name } }, !target.workspaceId, target.workspaceRoot ?? target.projectRoot);
				if (target.workspaceId) {
					const workspace = this.store.read().workspaces[target.workspaceId];
					const participant = workspace ? this.store.read().participants[workspace.participantKey] : undefined;
					if (!workspace || workspace.state !== "active" || !workspaceRegistrationAllowed(participant, target, workspace.holderGeneration)) throw new RegistrationError("registration_stale", "Workspace Pi participant succession is no longer authorized for this target.");
				}
			} else {
				const participant = this.store.read().participants[target.participantKey];
				if (!participant || participant.state !== "held" || participant.holderTargetKey !== target.targetKey || participant.generation !== target.holderGeneration) throw new RegistrationError("registration_stale", "Bridge participant generation is no longer held by this target.");
				verifyBridgeIdentity(verified, target, { paneId: target.herdr.paneId, terminalId: target.herdr.terminalId }, false);
			}
			const next = { ...current, leaseUntil: renew ? this.now() + this.leaseMs() : current.leaseUntil, host: verified };
			this.registrations.set(registrationId, next);
			return next;
		});
		this.verifications.set(registrationId, verification);
		const cleanup = () => { if (this.verifications.get(registrationId) === verification) this.verifications.delete(registrationId); };
		void verification.then(cleanup, cleanup);
		return verification;
	}

	private ensureOpen(): void {
		if (this.closed) throw new RegistrationError("registration_stale", "Runtime registration service is closing.");
	}

	private validateAdmissions(targetKey: string, admittedClaims: Array<{ claimId: string; eventIds: string[] }>): void {
		if (admittedClaims.length > MAX_ADMITTED_CLAIMS || new Set(admittedClaims.map((receipt) => receipt.claimId)).size !== admittedClaims.length) throw new RegistrationError("invalid_request", `At most ${MAX_ADMITTED_CLAIMS} unique admitted claims may be reconciled.`);
		for (const receipt of admittedClaims) {
			const claim = this.store.read().claims[receipt.claimId];
			if (claim && (claim.targetKey !== targetKey || !sameIds(claim.eventIds, receipt.eventIds))) throw new RegistrationError("conflict", "Admitted claim receipt does not match durable state.");
		}
	}

	private reconcileAdmissions(targetKey: string, admittedClaims: Array<{ claimId: string; eventIds: string[] }>): void {
		if (admittedClaims.length) this.store.apply({ type: "inbox.reconcile_many", targetKey, receipts: admittedClaims, at: this.now() });
	}

	private expire(): void {
		const now = this.now();
		for (const registration of this.registrations.values()) if (registration.leaseUntil <= now) this.drop(registration.registrationId);
	}

	private drop(registrationId: string): void {
		const registration = this.registrations.get(registrationId);
		if (!registration) return;
		this.registrations.delete(registrationId);
		if (this.byTarget.get(registration.targetKey) === registrationId) this.byTarget.delete(registration.targetKey);
		if (this.byTerminal.get(registration.host.terminalId) === registrationId) this.byTerminal.delete(registration.host.terminalId);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private leaseMs(): number {
		return this.options.leaseMs ?? REGISTRATION_LEASE_MS;
	}

	private ready(targetKey: string): void {
		if (this.options.onReady) queueMicrotask(() => this.options.onReady?.(targetKey));
	}
}

export class HerdrCliHostVerifier implements HostedHostVerifier {
	async getPane(paneId: string): Promise<HostedLiveAgent> {
		const response = await runHerdr(["agent", "get", paneId]);
		return parseLiveAgent(strictObject(strictObject(response, "Herdr response").result, "Herdr result").agent);
	}

	async findTerminal(terminalId: string): Promise<HostedLiveAgent> {
		const response = await runHerdr(["agent", "list"]);
		const agents = strictObject(strictObject(response, "Herdr response").result, "Herdr result").agents;
		if (!Array.isArray(agents)) throw new RegistrationError("host_unavailable", "Herdr agent list is malformed.");
		const matches = agents.map(parseLiveAgent).filter((agent) => agent.terminalId === terminalId);
		if (matches.length !== 1) throw new RegistrationError("identity_mismatch", "The registered terminal is not uniquely live in Herdr.");
		return matches[0]!;
	}

	async getPaneIdentity(paneId: string): Promise<HostedPaneIdentity> {
		const response = await runHerdr(["pane", "get", paneId]);
		const pane = parsePaneIdentity(strictObject(strictObject(response, "Herdr response").result, "Herdr result").pane);
		const tabResponse = await runHerdr(["tab", "get", pane.tabId]);
		const tab = strictObject(strictObject(strictObject(tabResponse, "Herdr response").result, "Herdr result").tab, "Herdr tab");
		if (tab.tab_id !== pane.tabId || tab.workspace_id !== pane.workspaceId || !Number.isSafeInteger(tab.pane_count) || Number(tab.pane_count) < 1) throw new RegistrationError("host_unavailable", "Herdr returned malformed tab identity.");
		return { ...pane, paneCount: Number(tab.pane_count) };
	}

	async closeTarget(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged"> {
		if (target.kind === "bridge" || target.kind === "agent") return this.closeBridgeTarget(target, runtimeRoot);
		let sessionFile: string;
		try {
			sessionFile = canonicalFile(target.piSessionFile, "collaborator session file");
			if (dirname(sessionFile) !== realpathSync(join(runtimeRoot, "collaborator-sessions"))) return "unmanaged";
			verifyPiSessionHeader(sessionFile, target.piSessionId, target.workspaceRoot ?? target.projectRoot);
		} catch {
			return "unmanaged";
		}
		const find = async () => (await this.listAgents()).filter((agent) => agent.agentSession.kind === "path" && canonicalPath(agent.agentSession.value) === sessionFile);
		const matches = await find();
		if (matches.length === 0) return "already_absent";
		if (matches.length !== 1) throw new RegistrationError("identity_mismatch", "Collaborator session is not unique in Herdr.");
		const agent = matches[0]!;
		if (!agent.tabId || !agent.workspaceId || canonicalDirectory(agent.cwd, "Herdr cwd") !== (target.workspaceRoot ?? target.projectRoot) || agent.agentSession.agent !== "pi" || agent.agentSession.source !== "herdr:pi" || deriveTargetKey(target.projectRoot, target.piSessionId) !== target.targetKey) {
			throw new RegistrationError("identity_mismatch", "Herdr collaborator identity does not match its Runtime target.");
		}
		const response = await runHerdr(["tab", "get", agent.tabId]);
		const tab = strictObject(strictObject(strictObject(response, "Herdr response").result, "Herdr result").tab, "Herdr tab");
		if (tab.tab_id !== agent.tabId || tab.workspace_id !== agent.workspaceId || tab.pane_count !== 1) throw new RegistrationError("identity_mismatch", "Collaborator tab identity changed before stop.");
		try {
			await runHerdr(["tab", "close", agent.tabId]);
			return "closed";
		} catch (error) {
			if ((await find()).length === 0) return "already_absent";
			throw error;
		}
	}

	private async closeBridgeTarget(target: HostedExternalTarget, runtimeRoot: string): Promise<"closed" | "already_absent"> {
		const find = async () => (await this.listAgents()).filter((agent) => target.kind === "agent" ? sameAgentSession(agent.agentSession, target.agentSession) : agent.agentSession.source === "pi-kit-bridge" && agent.agentSession.agent === "bridge" && agent.agentSession.kind === "id" && agent.agentSession.value === target.bridgeId);
		const matches = await find();
		if (matches.length > 1) throw new RegistrationError("identity_mismatch", "Bridge identity is not unique in Herdr.");
		let outcome: "closed" | "already_absent" = "already_absent";
		if (matches.length === 1) {
			const agent = matches[0]!;
			verifyBridgeIdentity(agent, target, { paneId: target.herdr.paneId, terminalId: target.herdr.terminalId }, false);
			const response = await runHerdr(["tab", "get", target.herdr.tabId]);
			const tab = strictObject(strictObject(strictObject(response, "Herdr response").result, "Herdr result").tab, "Herdr tab");
			if (tab.tab_id !== target.herdr.tabId || tab.workspace_id !== target.herdr.workspaceId || tab.pane_count !== 1) throw new RegistrationError("identity_mismatch", "Bridge tab identity changed before stop.");
			try { await runHerdr(["tab", "close", target.herdr.tabId]); outcome = "closed"; }
			catch (error) { if ((await find()).length !== 0) throw error; }
		}
		if (target.kind === "bridge") try {
			await quiesceBridgeRunner(join(realpathSync(runtimeRoot), "bridges", target.bridgeId), target);
		} catch (error) {
			throw new RegistrationError("identity_mismatch", `Bridge stop could not prove worker quiescence: ${error instanceof Error ? error.message : String(error)}`);
		}
		return outcome;
	}

	private async listAgents(): Promise<HostedLiveAgent[]> {
		const response = await runHerdr(["agent", "list"]);
		const agents = strictObject(strictObject(response, "Herdr response").result, "Herdr result").agents;
		if (!Array.isArray(agents)) throw new RegistrationError("host_unavailable", "Herdr agent list is malformed.");
		return agents.map(parseLiveAgent);
	}
}

export function deriveTargetKey(projectRoot: string, piSessionId: string): string {
	return `pi_${createHash("sha256").update(projectRoot).update("\0").update(piSessionId).digest("hex")}`;
}

function verifyIdentity(agent: HostedLiveAgent, input: RegisterPiInput, allowMovedPane: boolean, expectedHostRoot = input.projectRoot): void {
	if (!allowMovedPane && agent.paneId !== input.herdr.paneId) throw new RegistrationError("identity_mismatch", "Herdr pane locator does not match.");
	if (agent.terminalId !== input.herdr.terminalId) throw new RegistrationError("identity_mismatch", "Herdr terminal identity does not match.");
	if (input.herdr.agentName && agent.name !== input.herdr.agentName) throw new RegistrationError("identity_mismatch", "Herdr agent name does not match.");
	let hostCwd: string;
	try { hostCwd = canonicalDirectory(agent.cwd, "Herdr cwd"); } catch { throw new RegistrationError("identity_mismatch", "Herdr cwd is unavailable or not canonical."); }
	if (hostCwd !== expectedHostRoot) throw new RegistrationError("identity_mismatch", "Herdr cwd does not match the authorized Pi workspace root.");
	const session = agent.agentSession;
	if (session.agent !== "pi" || (session.source !== "herdr:pi" && session.source !== "pi-kit-runtime")) throw new RegistrationError("identity_mismatch", "Herdr does not report an authoritative Pi session.");
	if (session.kind === "id" && session.value !== input.piSessionId) throw new RegistrationError("identity_mismatch", "Herdr Pi session ID does not match.");
	if (session.kind === "path") {
		let hostSessionFile: string;
		try { hostSessionFile = canonicalFile(session.value, "Herdr Pi session file"); } catch { throw new RegistrationError("identity_mismatch", "Herdr Pi session file is unavailable or not canonical."); }
		if (hostSessionFile !== input.piSessionFile) throw new RegistrationError("identity_mismatch", "Herdr Pi session file does not match.");
	}
}

function verifyBridgeIdentity(agent: HostedLiveAgent, target: HostedExternalTarget, herdr: { paneId: string; terminalId: string }, allowMovedPane: boolean): void {
	if (!allowMovedPane && agent.paneId !== herdr.paneId) throw new RegistrationError("identity_mismatch", "Herdr bridge pane locator does not match.");
	if (agent.terminalId !== herdr.terminalId || agent.paneId !== target.herdr.paneId || agent.terminalId !== target.herdr.terminalId || agent.tabId !== target.herdr.tabId || agent.workspaceId !== target.herdr.workspaceId) throw new RegistrationError("identity_mismatch", "Herdr bridge host identity does not match launch authority.");
	let hostCwd: string;
	try { hostCwd = canonicalDirectory(agent.cwd, "Herdr cwd"); } catch { throw new RegistrationError("identity_mismatch", "Herdr bridge cwd is unavailable or not canonical."); }
	if (hostCwd !== (target.workspaceRoot ?? target.projectRoot)) throw new RegistrationError("identity_mismatch", "Herdr bridge cwd does not match its authorized project/workspace root.");
	const session = agent.agentSession;
	if (target.kind === "agent") {
		const expectedAgent = target.driver === "claude-code" ? "claude" : "codex";
		if (session.source !== `herdr:${expectedAgent}` || session.agent !== expectedAgent || !sameAgentSession(session, target.agentSession)) throw new RegistrationError("identity_mismatch", "Herdr does not report the authoritative interactive agent session.");
	} else if (session.source !== "pi-kit-bridge" || session.agent !== "bridge" || session.kind !== "id" || session.value !== target.bridgeId) throw new RegistrationError("identity_mismatch", "Herdr does not report the authoritative generic bridge identity.");
}

function sameAgentSession(left: HostedAgentSessionIdentity, right: HostedAgentSessionIdentity | undefined): boolean {
	return Boolean(right) && left.source === right!.source && left.agent === right!.agent && left.kind === right!.kind && left.value === right!.value;
}

function workspaceRegistrationAllowed(participant: HostedParticipant | undefined, target: HostedPiTarget, holderGeneration: string): boolean {
	if (participant?.state === "held") return participant.holderTargetKey === target.targetKey && participant.generation === holderGeneration;
	const latest = participant?.transitions.at(-1);
	return participant?.state === "vacant" && latest?.cause === "stand_down" && latest.previousHolderTargetKey === target.targetKey && latest.previousGeneration === holderGeneration;
}

function samePiTarget(left: HostedPiTarget, right: HostedPiTarget): boolean {
	return left.targetKey === right.targetKey && left.projectRoot === right.projectRoot && left.piSessionId === right.piSessionId && left.piSessionFile === right.piSessionFile && left.workspaceId === right.workspaceId && left.workspaceRoot === right.workspaceRoot;
}

function sameBridgeTarget(left: HostedExternalTarget, right: HostedExternalTarget): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalDirectory(path: string, name: string): string {
	try {
		const canonical = realpathSync(path);
		if (!lstatSync(canonical).isDirectory()) throw new Error();
		return canonical;
	} catch {
		throw new RegistrationError("invalid_request", `${name} must be an existing directory.`);
	}
}

function canonicalFile(path: string, name: string): string {
	try {
		const canonical = realpathSync(path);
		if (!lstatSync(canonical).isFile()) throw new Error();
		return canonical;
	} catch {
		throw new RegistrationError("invalid_request", `${name} must be an existing regular file.`);
	}
}

function verifyPiSessionHeader(path: string, expectedId: string, expectedCwd: string): void {
	const buffer = Buffer.alloc(64 * 1024);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytes).indexOf(0x0a);
		if (newline < 0) throw new Error("missing bounded header");
		const header = strictObject(JSON.parse(buffer.subarray(0, newline).toString("utf8")), "Pi session header");
		if (header.type !== "session" || header.id !== expectedId || canonicalDirectory(text(header.cwd), "Pi session cwd") !== expectedCwd) throw new Error("session identity mismatch");
	} catch {
		throw new RegistrationError("invalid_request", "Pi session file header does not match the supplied session ID.");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function parsePaneIdentity(value: unknown): HostedPaneIdentity {
	try {
		const pane = strictObject(value, "Herdr pane");
		if (!Number.isSafeInteger(pane.revision) || Number(pane.revision) < 0) throw new Error("invalid pane revision");
		return {
			paneId: text(pane.pane_id),
			tabId: text(pane.tab_id),
			workspaceId: text(pane.workspace_id),
			terminalId: text(pane.terminal_id),
			cwd: text(pane.cwd),
			...(typeof pane.agent === "string" ? { agent: pane.agent } : {}),
			paneCount: 0,
			revision: Number(pane.revision),
		};
	} catch {
		throw new RegistrationError("host_unavailable", "Herdr returned malformed pane identity.");
	}
}

function parseLiveAgent(value: unknown): HostedLiveAgent {
	try {
		const agent = strictObject(value, "Herdr agent");
		const label = text(agent.agent);
		const bridge = /^bridge:([A-Za-z0-9_-]{1,200})$/.exec(label);
		const session = agent.agent_session === undefined
			? bridge
				? { source: "pi-kit-bridge", agent: "bridge", kind: "id" as const, value: bridge[1] }
				: { source: `herdr:${label}`, agent: label, kind: "id" as const, value: text(agent.name) }
			: strictObject(agent.agent_session, "Herdr agent session");
		if (session.kind !== "id" && session.kind !== "path") throw new Error("invalid session kind");
		if (!Number.isSafeInteger(agent.state_change_seq) || Number(agent.state_change_seq) < 0) throw new Error("invalid state sequence");
		const status = agent.agent_status;
		if (status !== "idle" && status !== "working" && status !== "blocked" && status !== "done" && status !== "unknown") throw new Error("invalid agent status");
		return {
			paneId: text(agent.pane_id),
			...(typeof agent.tab_id === "string" ? { tabId: agent.tab_id } : {}),
			...(typeof agent.workspace_id === "string" ? { workspaceId: agent.workspace_id } : {}),
			terminalId: text(agent.terminal_id),
			cwd: text(agent.cwd),
			...(typeof agent.name === "string" ? { name: agent.name } : {}),
			agentSession: { source: text(session.source), agent: text(session.agent), kind: session.kind, value: text(session.value) },
			status,
			...(typeof agent.focused === "boolean" ? { focused: agent.focused } : {}),
			stateChangeSeq: Number(agent.state_change_seq),
		};
	} catch (error) {
		if (error instanceof RegistrationError) throw error;
		throw new RegistrationError("host_unavailable", "Herdr returned malformed agent identity.");
	}
}

function canonicalPath(path: string): string | undefined {
	try { return realpathSync(path); } catch { return undefined; }
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Each Herdr query result is decoded by listAgents before identity decisions.
function runHerdr(args: string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile("herdr", args, { timeout: 2_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) {
				reject(new RegistrationError("host_unavailable", "Herdr identity query failed."));
				return;
			}
			try { resolve(JSON.parse(stdout)); } catch { reject(new RegistrationError("host_unavailable", "Herdr returned invalid JSON.")); }
		});
	});
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("expected non-empty text");
	return value;
}

function sameIds(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const sorted = [...right].sort();
	return [...left].sort().every((value, index) => value === sorted[index]);
}
