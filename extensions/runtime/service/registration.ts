import { randomBytes, randomUUID } from "node:crypto";
import { type HostedAgentTarget, type HostedTarget, isAgentTarget } from "../hosted-types.ts";
import { assertAgentInProject, canonicalDirectory, canonicalFile, heldByTarget, verifyPiSessionHeader } from "./identity.ts";
import { RegistrationError, type HostedHostVerifier } from "./identity.ts";
import { HostedStateStore, piTargetKey } from "./state.ts";
import { isProjectWorktree } from "./worktree.ts";

const REGISTRATION_LEASE_MS = 30_000;

export interface RegisterPiInput {
	projectRoot: string;
	worktreePath?: string;
	piSessionId: string;
	piSessionFile: string;
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
		this.store.apply({ type: "target.ensure", target });
		return this.install(targetKey);
	}

	/** Installs the live registration of a Herdr agent target the binder already verified. */
	registerAgent(target: HostedAgentTarget): HostedLiveRegistration {
		this.ensureOpen();
		const state = this.store.read();
		if (!isAgentTarget(state.targets[target.targetKey])) {
			throw new RegistrationError("registration_stale", "Herdr agent target is absent from durable state.");
		}
		if (!heldByTarget(this.store, target)) {
			throw new RegistrationError("registration_stale", "Herdr agent participant generation is not held by its target.");
		}
		return this.install(target.targetKey);
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
	private install(targetKey: string): HostedLiveRegistration {
		this.expire();
		const registrationId = this.options.createId?.() ?? `reg_${randomUUID()}`;
		if (this.registrations.has(registrationId)) throw new RegistrationError("conflict", "Registration ID is already live.");
		const previous = this.byTarget.get(targetKey);
		if (previous) this.drop(previous);
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
