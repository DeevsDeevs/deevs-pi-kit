import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { inheritClaudeTrust } from "./claude-trust.ts";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import type { ResolvedCollaboratorCandidate } from "./collaborator-policy.ts";
import { DRIVERS, driverLaunchArgv, type DriverSpec } from "./drivers.ts";
import { createCollaboratorTab, throwIfAborted, waitForHerdrPaneCwd, type CollaboratorTab } from "./herdr.ts";
import { isVacant, isWriter } from "./schemas/state.ts";
import type { ManagedAgentPlan, NativeAgentService } from "./native-agents.ts";
import { auth, strictObject, text, type ClientParticipantStatus, type LiveClientRegistration, type RegistrationAuth } from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { CollaboratorLaunch, ManagedAgentSession } from "./session-record.ts";
import { COLLABORATOR_ENV, HOSTED_SESSION_ENTRY, type HostedSessionRecord } from "./session-restore.ts";

/** The authority one confirmed start batch shares across its launches. */
export interface CollaboratorStart {
	ctx: ExtensionContext;
	protocol: string;
	registration: LiveClientRegistration;
	caller: ClientParticipantStatus;
	projectRoot: string;
	signal?: AbortSignal;
}

interface CollaboratorLaunchRequest {
	start: CollaboratorStart;
	candidate: ResolvedCollaboratorCandidate;
	existing: ClientParticipantStatus | undefined;
	spec: DriverSpec;
	plan: ManagedAgentPlan;
	current: () => boolean;
}

interface WorktreeEnsureParams extends RegistrationAuth {
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	protocol: string;
	participantId: string;
	repo?: string;
}

/** What `herdr agent start` produced for one launch, before Runtime binds it. */
interface StartedCollaborator {
	tab: CollaboratorTab;
	cwd: string;
	agentSession: ManagedAgentSession;
	messagingConfigured: boolean;
}

/** Turns one confirmed candidate into a running, bound collaborator: worktree, tab, agent start, bind and record. */
export class CollaboratorLauncher {
	private readonly session: RuntimeSession;
	private readonly native: NativeAgentService;

	constructor(session: RuntimeSession, native: NativeAgentService) {
		this.session = session;
		this.native = native;
	}

	private get pi(): ExtensionAPI {
		return this.session.pi;
	}

	private get client(): HostedRuntimeClient {
		return this.session.client;
	}

	async launch(
		start: CollaboratorStart,
		candidate: ResolvedCollaboratorCandidate,
		existing: ClientParticipantStatus | undefined,
	): Promise<string> {
		const spec = DRIVERS[candidate.driver];
		const plan = this.native.plan(start.protocol, candidate.participantId, start.projectRoot);
		const current = this.session.scope(start.ctx, start.registration);
		this.native.beginLaunch(plan.targetKey);
		try {
			return await this.launchAgent({ start, candidate, existing, spec, plan, current });
		} finally {
			this.native.finishLaunch(plan.targetKey);
		}
	}

	/** Worktree, tab, `herdr agent start`, bind, record — and a best-effort stop of whatever started when one step fails. */
	private async launchAgent(request: CollaboratorLaunchRequest): Promise<string> {
		const { start, candidate, existing, spec, plan } = request;
		throwIfAborted(start.signal);
		const worktreePath = isWriter(candidate.profile)
			? await this.ensureWorktree(start, candidate)
			: undefined;
		const launchCwd = worktreePath ?? candidate.repoRoot ?? start.projectRoot;
		if (spec.kind === "claude" && worktreePath) inheritClaudeTrust(worktreePath, candidate.repoRoot ?? start.projectRoot);
		if (standingDown(existing)) await this.replaceStoodDown(existing, start.registration);
		const tab = await createCollaboratorTab(this.pi, launchCwd, candidate.participantId, tabEnvironment(spec, start, candidate));
		let sessionFile: string | undefined;
		try {
			if (launchCwd !== start.projectRoot) await waitForHerdrPaneCwd(this.pi, tab, launchCwd, start.signal);
			this.session.requireCurrentScope(request.current);
			const mcp = spec.bind ? await this.native.messagingConfiguration(plan, candidate.persona?.prompt) : undefined;
			if (mcp) notifyNativePrompt(start.ctx, tab.paneId);
			if (!spec.bind) sessionFile = this.createCollaboratorSession(start.projectRoot, launchCwd, candidate);
			const input = { profile: candidate.profile, cwd: launchCwd, sessionFile, model: candidate.model, persona: candidate.persona, mcp };
			const argv = driverLaunchArgv({ driver: candidate.driver, agentName: plan.agentName, paneId: tab.paneId, input });
			const agent = await this.native.startAgent({ agentName: plan.agentName, spec, tab, argv });
			this.session.requireCurrentScope(request.current);
			await this.bindLaunched(request, { tab, cwd: launchCwd, agentSession: agent.agentSession, messagingConfigured: mcp !== undefined });
			start.ctx.ui.notify(`Collaborator ${start.protocol}/${candidate.participantId} started in ${tab.paneId}.`, "info");
			return tab.paneId;
		} catch (error) {
			await this.stopStarted(tab, sessionFile);
			throw error;
		}
	}

	private async bindLaunched(request: CollaboratorLaunchRequest, started: StartedCollaborator): Promise<void> {
		const { start, candidate, existing, spec, plan } = request;
		const driver = spec.bind;
		if (!driver) return;
		if (!candidate.profile) throw new HostedRuntimeClientError("conflict", "Native collaborator launch requires a resolved profile.");
		await this.native.bindLaunched({
			ctx: start.ctx,
			registration: start.registration,
			plan,
			driver,
			profile: candidate.profile,
			protocol: start.protocol,
			participantId: candidate.participantId,
			projectRoot: start.projectRoot,
			cwd: started.cwd,
			tab: started.tab,
			agentSession: started.agentSession,
			callerParticipantKey: start.caller.participantKey,
			expectedCallerGeneration: start.caller.generation,
			expectedParticipantGeneration: existing?.generation,
			repo: candidate.repo,
			messagingConfigured: started.messagingConfigured,
		});
	}

	/** Best effort: a failed launch leaves no tab, no prepared session and no persisted authority behind. */
	private async stopStarted(tab: CollaboratorTab, sessionFile: string | undefined): Promise<void> {
		try {
			await this.pi.exec("herdr", ["tab", "close", tab.tabId], { timeout: 5_000 });
			if (sessionFile) rmSync(sessionFile, { force: true });
		} catch {}
	}

	private async ensureWorktree(start: CollaboratorStart, candidate: ResolvedCollaboratorCandidate): Promise<string> {
		const params: WorktreeEnsureParams = {
			...auth(start.registration),
			callerParticipantKey: start.caller.participantKey,
			expectedCallerGeneration: start.caller.generation,
			protocol: start.protocol,
			participantId: candidate.participantId,
		};
		if (candidate.repo !== undefined) params.repo = candidate.repo;
		return text(strictObject(await this.client.call("worktree.ensure", params), "Collaborator worktree").path);
	}

	private createCollaboratorSession(projectRoot: string, cwd: string, candidate: ResolvedCollaboratorCandidate): string {
		const sessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const sessionCwd = realpathSync(cwd);
		const directory = join(this.session.root, "collaborator-sessions");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const sessionFile = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		const record: HostedSessionRecord = { version: 3, launch: piCollaboratorLaunch(candidate) };
		if (sessionCwd !== projectRoot) {
			record.worktree = { projectRoot };
			if (candidate.repo !== undefined) record.worktree.repo = candidate.repo;
			if (sessionCwd !== candidate.repoRoot) record.worktree.worktreePath = sessionCwd;
		}
		const entries: Array<SessionHeader | CustomEntry<HostedSessionRecord>> = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: sessionCwd },
			{ type: "custom", customType: HOSTED_SESSION_ENTRY, data: record, id: randomUUID(), parentId: null, timestamp },
		];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
		return sessionFile;
	}

	private async replaceStoodDown(existing: ClientParticipantStatus, registration: LiveClientRegistration): Promise<void> {
		const params = {
			...auth(registration),
			participantKey: existing.participantKey,
			expectedGeneration: existing.generation,
			confirmed: true,
		};
		const stopped = strictObject(await this.client.call("participant.stop_confirmed", params), "Stood-down collaborator replacement");
		if (stopped.outcome !== "stopped" && stopped.outcome !== "already_stopped") {
			throw new HostedRuntimeClientError("conflict", "The exact stood-down collaborator process could not be replaced safely.");
		}
	}
}

function piCollaboratorLaunch(candidate: ResolvedCollaboratorCandidate): CollaboratorLaunch {
	const launch: CollaboratorLaunch = { driver: "pi" };
	if (candidate.model) launch.model = candidate.model;
	if (candidate.profile) launch.profile = candidate.profile;
	if (candidate.persona) launch.persona = candidate.persona;
	return launch;
}

/** Self-registering drivers learn which collaborator identity to hold from their tab environment. */
function tabEnvironment(spec: DriverSpec, start: CollaboratorStart, candidate: ResolvedCollaboratorCandidate): string[] {
	if (spec.bind) return [];
	return [`${COLLABORATOR_ENV}=${start.protocol}:${candidate.participantId}`];
}

function notifyNativePrompt(ctx: ExtensionContext, paneId: string): void {
	const prompt = `Complete any native trust or permission prompt in ${paneId}.`
		+ " Runtime will not accept it for you; startup has a bounded timeout.";
	ctx.ui.notify(prompt, "info");
}

export function standingDown(participant: ClientParticipantStatus | undefined): participant is ClientParticipantStatus {
	if (!participant || !isVacant(participant.state)) return false;
	return participant.lastTransition.cause === "stand_down";
}
