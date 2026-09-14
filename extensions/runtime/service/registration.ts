import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostedAgentTarget, HostedTarget } from "../hosted-types.ts";
import { HostedStateStore, piTargetKey } from "./state.ts";
import { isProjectWorktree } from "./worktree.ts";

const REGISTRATION_LEASE_MS = 30_000;
const MAX_ADMITTED_CLAIMS = 12;

type HerdrValue = null | boolean | number | string | HerdrValue[] | HerdrObject;

interface HerdrObject {
	[key: string]: HerdrValue | undefined;
}

export type RegistrationErrorCode =
	| "invalid_request"
	| "not_found"
	| "conflict"
	| "registration_stale"
	| "identity_mismatch"
	| "host_unavailable";

export class RegistrationError extends Error {
	readonly code: RegistrationErrorCode;

	constructor(code: RegistrationErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** What `herdr agent get` reports about one live agent: where it runs, and the tab that owns it. */
export interface HostedLiveAgent {
	name?: string;
	cwd: string;
	tabId?: string;
	workspaceId?: string;
	sessionPath?: string;
}

export interface HostedHostVerifier {
	/** Resolves `herdr agent get <name>` for one exact Herdr agent name. */
	getAgent(agentName: string): Promise<HostedLiveAgent>;
	closeTarget?(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged">;
}

export interface AdmittedClaimReceipt {
	claimId: string;
	eventIds: string[];
}

export interface RegisterPiInput {
	projectRoot: string;
	worktreePath?: string;
	piSessionId: string;
	piSessionFile: string;
	admittedClaims: AdmittedClaimReceipt[];
}

export interface HostedLiveRegistration {
	targetKey: string;
	registrationId: string;
	registrationKey: string;
	leaseUntil: number;
}

export interface RegistrationManagerOptions {
	now?: () => number;
	createId?: () => string;
	createKey?: () => string;
	leaseMs?: number;
	onReady?: (targetKey: string) => void;
}

/**
 * One registration is trusted because it presents its ID and key. It stays live while its target
 * is: a Pi session file that still carries its session ID and project cwd, or a Herdr agent that
 * `herdr agent get` still reports in that project.
 */
export class RuntimeRegistrationManager {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly options: RegistrationManagerOptions;
	private readonly registrations = new Map<string, HostedLiveRegistration>();
	private readonly byTarget = new Map<string, string>();
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
		const worktreePath = input.worktreePath === undefined ? undefined : canonicalDirectory(input.worktreePath, "collaborator worktree");
		if (worktreePath !== undefined && (worktreePath === projectRoot || !await isProjectWorktree(worktreePath, projectRoot))) {
			throw new RegistrationError("identity_mismatch", "Collaborator cwd is not a separate Git worktree of its project.");
		}
		verifyPiSessionHeader(piSessionFile, input.piSessionId, worktreePath ?? projectRoot);
		this.ensureOpen();
		const targetKey = piTargetKey(input.piSessionId);
		const target: HostedTarget = {
			kind: "pi",
			targetKey,
			projectRoot,
			piSessionId: input.piSessionId,
			piSessionFile,
			createdAt: this.now(),
		};
		if (worktreePath) target.worktreePath = worktreePath;
		this.validateAdmissions(targetKey, input.admittedClaims);
		this.store.apply({ type: "target.ensure", target });
		return this.install(targetKey, input.admittedClaims);
	}

	/** Installs the live registration of a Herdr agent target the binder already verified. */
	registerAgent(target: HostedAgentTarget): HostedLiveRegistration {
		this.ensureOpen();
		const state = this.store.read();
		if (state.targets[target.targetKey]?.kind !== "agent") {
			throw new RegistrationError("registration_stale", "Herdr agent target is absent from durable state.");
		}
		if (!heldByTarget(this.store, target)) {
			throw new RegistrationError("registration_stale", "Herdr agent participant generation is not held by its target.");
		}
		return this.install(target.targetKey, []);
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
		if (!registration || registration.registrationKey !== registrationKey) {
			throw new RegistrationError("registration_stale", "Registration is absent, expired, or does not match its key.");
		}
		return registration;
	}

	hasLiveTarget(targetKey: string): boolean {
		this.expire();
		return this.byTarget.has(targetKey);
	}

	close(): void {
		this.closed = true;
		this.registrations.clear();
		this.byTarget.clear();
		this.verifications.clear();
	}

	/** Every registration call mints fresh credentials: the newest client of a target owns it. */
	private install(targetKey: string, admittedClaims: AdmittedClaimReceipt[]): HostedLiveRegistration {
		this.expire();
		this.validateAdmissions(targetKey, admittedClaims);
		const registrationId = this.options.createId?.() ?? `reg_${randomUUID()}`;
		if (this.registrations.has(registrationId)) throw new RegistrationError("conflict", "Registration ID is already live.");
		const previous = this.byTarget.get(targetKey);
		if (previous) this.drop(previous);
		if (admittedClaims.length) {
			this.store.apply({ type: "inbox.reconcile_many", targetKey, receipts: admittedClaims, at: this.now() });
		}
		const registration: HostedLiveRegistration = {
			targetKey,
			registrationId,
			registrationKey: this.options.createKey?.() ?? randomBytes(32).toString("base64url"),
			leaseUntil: this.now() + this.leaseMs(),
		};
		this.registrations.set(registrationId, registration);
		this.byTarget.set(targetKey, registrationId);
		this.ready(targetKey);
		return registration;
	}

	private verify(registrationId: string, registrationKey: string, renew: boolean): Promise<HostedLiveRegistration> {
		const prior = this.verifications.get(registrationId) ?? Promise.resolve(undefined);
		const verification = prior.catch(() => undefined).then(async () => {
			const current = this.authorize(registrationId, registrationKey);
			const target = this.store.read().targets[current.targetKey];
			if (!target) throw new RegistrationError("not_found", "Runtime target no longer exists.");
			await this.assertTargetLive(target);
			this.ensureOpen();
			if (this.registrations.get(registrationId) !== current) {
				throw new RegistrationError("registration_stale", "Registration changed while its target was being verified.");
			}
			const next = renew ? { ...current, leaseUntil: this.now() + this.leaseMs() } : current;
			this.registrations.set(registrationId, next);
			return next;
		});
		this.verifications.set(registrationId, verification);
		const cleanup = () => { if (this.verifications.get(registrationId) === verification) this.verifications.delete(registrationId); };
		void verification.then(cleanup, cleanup);
		return verification;
	}

	private async assertTargetLive(target: HostedTarget): Promise<void> {
		switch (target.kind) {
			case "pi":
				verifyPiSessionHeader(target.piSessionFile, target.piSessionId, target.worktreePath ?? target.projectRoot);
				return;
			case "agent": {
				const live = await this.host.getAgent(target.agentName);
				assertAgentInProject(live, target);
				if (!heldByTarget(this.store, target)) {
					throw new RegistrationError("registration_stale", "Herdr agent participant generation is no longer held.");
				}
				return;
			}
			default: {
				const unreachable: never = target;
				throw new RegistrationError("not_found", `Unsupported runtime target ${JSON.stringify(unreachable)}.`);
			}
		}
	}

	private ensureOpen(): void {
		if (this.closed) throw new RegistrationError("registration_stale", "Runtime registration service is closing.");
	}

	private validateAdmissions(targetKey: string, admittedClaims: AdmittedClaimReceipt[]): void {
		const unique = new Set(admittedClaims.map((receipt) => receipt.claimId)).size === admittedClaims.length;
		if (admittedClaims.length > MAX_ADMITTED_CLAIMS || !unique) {
			throw new RegistrationError("invalid_request", `At most ${MAX_ADMITTED_CLAIMS} unique admitted claims may be reconciled.`);
		}
		for (const receipt of admittedClaims) {
			const claim = this.store.read().claims[receipt.claimId];
			if (claim && (claim.targetKey !== targetKey || !sameIds(claim.eventIds, receipt.eventIds))) {
				throw new RegistrationError("conflict", "Admitted claim receipt does not match durable state.");
			}
		}
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
	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		const response = await runHerdr(["agent", "get", agentName]);
		return parseLiveAgent(strictObject(strictObject(response, "Herdr response").result, "Herdr result").agent);
	}

	async closeTarget(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged"> {
		switch (target.kind) {
			case "agent": return this.closeAgentTarget(target);
			case "pi": return this.closeCollaboratorTab(target.piSessionFile, target.piSessionId, target.worktreePath ?? target.projectRoot, runtimeRoot);
			default: {
				const unreachable: never = target;
				throw new RegistrationError("not_found", `Unsupported runtime target ${JSON.stringify(unreachable)}.`);
			}
		}
	}

	/** Only a Pi collaborator Runtime itself started, proven by its own session file, is ever closed. */
	private async closeCollaboratorTab(
		piSessionFile: string,
		piSessionId: string,
		cwd: string,
		runtimeRoot: string,
	): Promise<"closed" | "already_absent" | "unmanaged"> {
		let sessionFile: string;
		try {
			sessionFile = canonicalFile(piSessionFile, "collaborator session file");
			if (dirname(sessionFile) !== realpathSync(join(runtimeRoot, "collaborator-sessions"))) return "unmanaged";
			verifyPiSessionHeader(sessionFile, piSessionId, cwd);
		} catch {
			return "unmanaged";
		}
		const find = async () => (await this.listAgents()).filter((agent) => agent.sessionPath === sessionFile);
		const matches = await find();
		const [agent] = matches;
		if (!agent) return "already_absent";
		if (matches.length !== 1) throw new RegistrationError("identity_mismatch", "Collaborator session is not unique in Herdr.");
		return this.closeTab(agent.tabId, agent.workspaceId, find);
	}

	private async closeAgentTarget(target: HostedAgentTarget): Promise<"closed" | "already_absent"> {
		const find = async () => (await this.listAgents()).filter((agent) => agent.name === target.agentName);
		if ((await find()).length === 0) return "already_absent";
		return this.closeTab(target.herdr.tabId, target.herdr.workspaceId, find);
	}

	/** A Runtime-owned tab holds exactly its collaborator pane; anything else is the operator's. */
	private async closeTab(
		tabId: string | undefined,
		workspaceId: string | undefined,
		find: () => Promise<HostedLiveAgent[]>,
	): Promise<"closed" | "already_absent"> {
		if (!tabId || !workspaceId) throw new RegistrationError("identity_mismatch", "Collaborator has no exact Herdr tab identity.");
		const response = await runHerdr(["tab", "get", tabId]);
		const tab = strictObject(strictObject(strictObject(response, "Herdr response").result, "Herdr result").tab, "Herdr tab");
		if (tab.tab_id !== tabId || tab.workspace_id !== workspaceId || tab.pane_count !== 1) {
			throw new RegistrationError("identity_mismatch", "Collaborator tab identity changed before stop.");
		}
		try {
			await runHerdr(["tab", "close", tabId]);
			return "closed";
		} catch (error) {
			if ((await find()).length === 0) return "already_absent";
			throw error;
		}
	}

	private async listAgents(): Promise<HostedLiveAgent[]> {
		const response = await runHerdr(["agent", "list"]);
		const agents = strictObject(strictObject(response, "Herdr response").result, "Herdr result").agents;
		if (!Array.isArray(agents)) throw new RegistrationError("host_unavailable", "Herdr agent list is malformed.");
		return agents.map(parseLiveAgent);
	}
}

function heldByTarget(store: HostedStateStore, target: HostedAgentTarget): boolean {
	const participant = store.read().participants[target.participantKey];
	return participant?.state === "held"
		&& participant.holderTargetKey === target.targetKey
		&& participant.generation === target.holderGeneration;
}

function assertAgentInProject(agent: HostedLiveAgent, target: HostedAgentTarget): void {
	if (agent.name !== target.agentName) {
		throw new RegistrationError("identity_mismatch", "Herdr agent name does not match its Runtime target.");
	}
	let hostCwd: string;
	try { hostCwd = canonicalDirectory(agent.cwd, "Herdr cwd"); }
	catch { throw new RegistrationError("identity_mismatch", "Herdr agent cwd is unavailable or not canonical."); }
	if (hostCwd !== (target.worktreePath ?? target.projectRoot)) {
		throw new RegistrationError("identity_mismatch", "Herdr agent cwd does not match its authorized project or worktree root.");
	}
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

/** A Pi target is live exactly while its session file still carries its session ID and project cwd. */
function verifyPiSessionHeader(path: string, expectedId: string, expectedCwd: string): void {
	const buffer = Buffer.alloc(64 * 1024);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytes).indexOf(0x0a);
		if (newline < 0) throw new Error("missing bounded header");
		const header = strictObject(JSON.parse(buffer.subarray(0, newline).toString("utf8")), "Pi session header");
		if (header.type !== "session" || header.id !== expectedId) throw new Error("session identity mismatch");
		if (canonicalDirectory(text(header.cwd), "Pi session cwd") !== expectedCwd) throw new Error("session identity mismatch");
	} catch {
		throw new RegistrationError("invalid_request", "Pi session file header does not match the supplied session ID.");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function parseLiveAgent(value: HerdrValue | undefined): HostedLiveAgent {
	try {
		const agent = strictObject(value, "Herdr agent");
		const session = agent.agent_session === undefined ? undefined : strictObject(agent.agent_session, "Herdr agent session");
		const result: HostedLiveAgent = { cwd: text(agent.cwd) };
		const name = stringValue(agent.name);
		const tabId = stringValue(agent.tab_id);
		const workspaceId = stringValue(agent.workspace_id);
		if (name !== undefined) result.name = name;
		if (tabId !== undefined) result.tabId = tabId;
		if (workspaceId !== undefined) result.workspaceId = workspaceId;
		const sessionPath = session?.kind === "path" ? canonicalPath(text(session.value)) : undefined;
		if (sessionPath !== undefined) result.sessionPath = sessionPath;
		return result;
	} catch (error) {
		if (error instanceof RegistrationError) throw error;
		throw new RegistrationError("host_unavailable", "Herdr returned malformed agent identity.");
	}
}

function canonicalPath(path: string): string | undefined {
	try { return realpathSync(path); } catch { return undefined; }
}

function runHerdr(args: string[]): Promise<HerdrValue> {
	return new Promise((resolve, reject) => {
		execFile("herdr", args, { timeout: 2_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) {
				reject(herdrQueryFailure(stdout));
				return;
			}
			try { resolve(JSON.parse(stdout)); } catch { reject(new RegistrationError("host_unavailable", "Herdr returned invalid JSON.")); }
		});
	});
}

/** A structured Herdr error means Herdr answered and the agent is absent; anything else is an unanswered query. */
function herdrQueryFailure(stdout: string): RegistrationError {
	if (stdout.length > 8192) return new RegistrationError("host_unavailable", "Herdr identity query failed.");
	try {
		// SAFETY: Herdr CLI output is untrusted JSON, narrowed to an error object before it is trusted.
		const response = JSON.parse(stdout) as HerdrValue;
		if (!isHerdrObject(response) || !isHerdrObject(response.error)) throw new Error("unstructured output");
		return new RegistrationError("identity_mismatch", "Herdr reports no such agent.");
	} catch {
		return new RegistrationError("host_unavailable", "Herdr identity query failed.");
	}
}

function strictObject(value: HerdrValue | undefined, name: string): HerdrObject {
	if (!isHerdrObject(value)) throw new Error(`${name} must be an object.`);
	return value;
}

function text(value: HerdrValue | undefined): string {
	const result = stringValue(value);
	if (result === undefined || result.length === 0) throw new Error("expected non-empty text");
	return result;
}

function isHerdrObject(value: HerdrValue | undefined): value is HerdrObject {
	if (value === null || value === undefined || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function stringValue(value: HerdrValue | undefined): string | undefined {
	try {
		const result = String.prototype.valueOf.call(value);
		return result === value ? result : undefined;
	} catch {
		return undefined;
	}
}

function sameIds(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const sorted = [...right].sort();
	return [...left].sort().every((value, index) => value === sorted[index]);
}
