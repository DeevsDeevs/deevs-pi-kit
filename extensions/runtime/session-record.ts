import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClientParticipantStatus } from "./responses.ts";
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

/** Reads and writes the single hidden session entry that carries this Pi session's Runtime state. */
export class HostedSessionStore {
	private readonly pi: ExtensionAPI;
	private identityState?: ParticipantIdentity;
	private launchState?: CollaboratorLaunch;
	private worktreeState?: CollaboratorWorktree;
	private autoState = false;
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

	/** Whether this session runs collaborator lifecycle changes in its project without confirmation dialogs. */
	get auto(): boolean {
		return this.autoState;
	}

	agent(targetKey: string): ManagedAgentControl | undefined {
		return this.agentControls.get(targetKey);
	}

	restore(ctx: ExtensionContext): void {
		const restored = restoreSessionRecord(ctx);
		this.identityState = restored.identity;
		this.launchState = restored.launch;
		this.worktreeState = restored.worktree;
		this.autoState = readProjectAuto(ctx) ?? restored.auto;
		this.agentControls.clear();
		for (const control of restored.agents) this.agentControls.set(control.targetKey, control);
	}

	persistIdentity(identity: ParticipantIdentity): void {
		this.identityState = identity;
		this.persist();
	}

	/** Records one held identity; revive authorization is one-shot and never written back. */
	persistHeld(protocol: string, participantId: string, participant: ClientParticipantStatus): void {
		this.persistIdentity({
			protocol,
			participantId,
			participantKey: participant.participantKey,
			generation: participant.generation,
			disposition: "held",
		});
	}

	/** Auto mode is a project setting, `.pi/runtime.json`, so every later session in the project starts with it; the session record mirrors it. */
	persistAuto(auto: boolean, ctx: ExtensionContext): void {
		this.autoState = auto;
		const path = projectAutoPath(ctx);
		if (auto) {
			mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ auto: true }, null, 2)}\n`);
		} else {
			rmSync(path, { force: true });
		}
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
		if (this.autoState) record.auto = true;
		this.pi.appendEntry(HOSTED_SESSION_ENTRY, record);
	}
}

function projectAutoPath(ctx: Pick<ExtensionContext, "cwd">): string {
	return join(ctx.cwd, ".pi", "runtime.json");
}

/** Only a trusted project's file counts; anything but a literal `true` is off. */
function readProjectAuto(ctx: ExtensionContext): boolean | undefined {
	if (!ctx.isProjectTrusted()) return undefined;
	let raw: string;
	try { raw = readFileSync(projectAutoPath(ctx), "utf8"); } catch { return undefined; }
	try { return JSON.parse(raw)?.auto === true; } catch { return false; }
}
