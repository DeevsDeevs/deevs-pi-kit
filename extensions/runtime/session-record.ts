import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	CollaboratorLaunch,
	CollaboratorWorktree,
	ManagedAgentControl,
	ParticipantIdentity,
} from "./schemas/session.ts";
import { HOSTED_SESSION_ENTRY, restoreSessionRecord, type HostedSessionRecord } from "./session-restore.ts";

export type {
	CollaboratorLaunch,
	CollaboratorPersona,
	ManagedAgentControl,
	ManagedAgentSession,
	ParticipantIdentity,
} from "./schemas/session.ts";

export const COLLABORATOR_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const COLLABORATOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/*:-]{0,199}$/;

/** Reads and writes the single hidden session entry that carries this Pi session's Runtime state. */
export class HostedSessionStore {
	private readonly pi: ExtensionAPI;
	private identityState?: ParticipantIdentity;
	private launchState?: CollaboratorLaunch;
	private worktreeState?: CollaboratorWorktree;
	private readonly agentControls = new Map<string, ManagedAgentControl>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get identity(): ParticipantIdentity | undefined {
		return this.identityState;
	}

	get launch(): CollaboratorLaunch | undefined {
		return this.launchState;
	}

	get worktree(): CollaboratorWorktree | undefined {
		return this.worktreeState;
	}

	get agents(): ReadonlyMap<string, ManagedAgentControl> {
		return this.agentControls;
	}

	agent(targetKey: string): ManagedAgentControl | undefined {
		return this.agentControls.get(targetKey);
	}

	restore(ctx: ExtensionContext): void {
		const restored = restoreSessionRecord(ctx);
		this.identityState = restored.identity;
		this.launchState = restored.launch;
		this.worktreeState = restored.worktree;
		this.agentControls.clear();
		for (const control of restored.agents) this.agentControls.set(control.targetKey, control);
	}

	persistIdentity(identity: ParticipantIdentity): void {
		this.identityState = identity;
		this.persist();
	}

	persistAgent(control: ManagedAgentControl): void {
		this.agentControls.set(control.targetKey, control);
		this.persist();
	}

	forgetAgent(targetKey: string): void {
		if (!this.agentControls.delete(targetKey)) return;
		this.persist();
	}

	private persist(): void {
		const record: HostedSessionRecord = { version: 3 };
		if (this.identityState) record.participant = this.identityState;
		if (this.launchState) record.launch = this.launchState;
		if (this.worktreeState) record.worktree = this.worktreeState;
		if (this.agentControls.size > 0) record.agents = [...this.agentControls.values()];
		this.pi.appendEntry(HOSTED_SESSION_ENTRY, record);
	}
}
