import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	parseSessionEntries,
	type CustomEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type FileEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { seedClaude } from "./claude-trust.ts";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";
import type { ResolvedCollaboratorCandidate } from "./collaborator-policy.ts";
import { DRIVERS, driverLaunchArgv, type DriverSpec } from "./drivers.ts";
import { createCollaboratorTab, throwIfAborted, waitForHerdrPaneCwd, type CollaboratorTab } from "./herdr.ts";
import type { JsonObject } from "./schemas/json.ts";
import { isVacant, isWriter } from "./schemas/state.ts";
import type { ManagedAgentPlan, NativeAgentService } from "./native-agents.ts";
import { asRecord, auth, confirmed, strictObject, text, type ClientParticipantStatus, type LiveClientRegistration, type RegistrationAuth } from "./responses.ts";
import type { RuntimeSession } from "./runtime-session.ts";
import type { CollaboratorLaunch, ManagedAgentSession } from "./schemas/session.ts";
import { projectScope } from "./service/state/keys.ts";
import { COLLABORATOR_ENV, HOSTED_SESSION_ENTRY, type HostedSessionRecord } from "./session-record.ts";

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
	): Promise<CollaboratorTab> {
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
	private async launchAgent(request: CollaboratorLaunchRequest): Promise<CollaboratorTab> {
		const { start, candidate, existing, spec, plan } = request;
		throwIfAborted(start.signal);
		const worktreePath = isWriter(candidate.profile)
			? await this.ensureWorktree(start, candidate)
			: undefined;
		const launchCwd = worktreePath ?? candidate.repoRoot ?? start.projectRoot;
		if (spec.kind === "claude") seedClaude(launchCwd, candidate.repoRoot ?? start.projectRoot);
		if (standingDown(existing)) await this.replaceStoodDown(existing, start.registration);
		const tab = await createCollaboratorTab(this.pi, launchCwd, candidate.participantId, tabEnvironment(spec, start, candidate));
		let sessionFile: string | undefined;
		let created = false;
		try {
			if (launchCwd !== start.projectRoot) await waitForHerdrPaneCwd(this.pi, tab, launchCwd, start.signal);
			this.session.requireCurrentScope(request.current);
			const mcp = spec.bind ? await this.native.messagingConfiguration(plan, candidate.persona?.prompt) : undefined;
			if (!spec.bind) {
				sessionFile = join(this.session.root, "collaborator-sessions", `${projectScope(start.projectRoot)}__${start.protocol}__${candidate.participantId}.jsonl`);
				created = prepareCollaboratorSession(sessionFile, launchCwd, start.projectRoot, candidate);
			}
			const input = { profile: candidate.profile, cwd: launchCwd, sessionFile, model: candidate.model, persona: candidate.persona, mcp, resume: candidate.resume };
			const argv = driverLaunchArgv({ driver: candidate.driver, agentName: plan.agentName, paneId: tab.paneId, input });
			const agent = await this.native.startAgent({ agentName: plan.agentName, spec, tab, argv });
			this.session.requireCurrentScope(request.current);
			await this.bindLaunched(request, { tab, cwd: launchCwd, agentSession: agent.agentSession, messagingConfigured: mcp !== undefined });
			start.ctx.ui.notify(`Collaborator ${start.protocol}/${candidate.participantId} started in ${tab.paneId}.`, "info");
			return tab;
		} catch (error) {
			await this.stopStarted(tab, created ? sessionFile : undefined);
			throw error;
		}
	}

	private async bindLaunched(request: CollaboratorLaunchRequest, started: StartedCollaborator): Promise<void> {
		const { start, candidate, existing, spec, plan } = request;
		const driver = spec.bind;
		if (!driver) return;
		await this.native.bindLaunched({
			ctx: start.ctx,
			registration: start.registration,
			plan,
			projectRoot: start.projectRoot,
			cwd: started.cwd,
			tab: started.tab,
			agentSession: started.agentSession,
			messagingConfigured: started.messagingConfigured,
			bind: {
				agentName: plan.agentName,
				driver,
				profile: candidate.profile,
				protocol: start.protocol,
				participantId: candidate.participantId,
				callerParticipantKey: start.caller.participantKey,
				expectedCallerGeneration: start.caller.generation,
				expectedParticipantGeneration: existing?.generation,
				repo: candidate.repo,
			},
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

	private async replaceStoodDown(existing: ClientParticipantStatus, registration: LiveClientRegistration): Promise<void> {
		const stopped = strictObject(await this.client.call("participant.stop_confirmed", confirmed(registration, existing)), "Stood-down collaborator replacement");
		if (stopped.outcome !== "stopped" && stopped.outcome !== "already_stopped") {
			throw new HostedRuntimeClientError("conflict", "The exact stood-down collaborator process could not be replaced safely.");
		}
	}
}

/**
 * Writes the one session file a Pi collaborator name has. A later start resumes its transcript and record, but runs where
 * and as that start says: the header's cwd and the launch and worktree records are always this start's. True when created.
 */
export function prepareCollaboratorSession(sessionFile: string, launchCwd: string, projectRoot: string, candidate: ResolvedCollaboratorCandidate): boolean {
	const cwd = realpathSync(launchCwd);
	const timestamp = new Date().toISOString();
	const fresh: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id: randomUUID(), timestamp, cwd };
	const parsed: FileEntry[] = existsSync(sessionFile) ? parseSessionEntries(readFileSync(sessionFile, "utf8")) : [];
	const created = parsed[0]?.type !== "session";
	const [header, ...entries] = created ? [fresh] : parsed;
	let previous: JsonObject | undefined;
	for (const entry of entries) if (entry.type === "custom" && entry.customType === HOSTED_SESSION_ENTRY) previous = asRecord(entry.data);
	const record: HostedSessionRecord = { ...previous, version: 3, launch: piCollaboratorLaunch(candidate), worktree: undefined };
	if (cwd !== projectRoot) {
		record.worktree = { projectRoot };
		if (candidate.repo !== undefined) record.worktree.repo = candidate.repo;
		if (cwd !== candidate.repoRoot) record.worktree.worktreePath = cwd;
	}
	const entry: CustomEntry<HostedSessionRecord> = { type: "custom", customType: HOSTED_SESSION_ENTRY, data: record, id: randomUUID(), parentId: entries.at(-1)?.id ?? null, timestamp };
	mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
	const pending = `${sessionFile}.${randomUUID()}.tmp`;
	writeFileSync(pending, `${[{ ...header, cwd }, ...entries, entry].map((line) => JSON.stringify(line)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
	renameSync(pending, sessionFile);
	return created;
}

function piCollaboratorLaunch(candidate: ResolvedCollaboratorCandidate): CollaboratorLaunch {
	const launch: CollaboratorLaunch = { driver: "pi", profile: candidate.profile };
	if (candidate.model) launch.model = candidate.model;
	if (candidate.persona) launch.persona = candidate.persona;
	return launch;
}

/** Self-registering drivers learn which collaborator identity to hold from their tab environment. */
function tabEnvironment(spec: DriverSpec, start: CollaboratorStart, candidate: ResolvedCollaboratorCandidate): string[] {
	if (spec.bind) return [];
	return [`${COLLABORATOR_ENV}=${start.protocol}:${candidate.participantId}`];
}

export function standingDown(participant: ClientParticipantStatus | undefined): participant is ClientParticipantStatus {
	if (!participant || !isVacant(participant.state)) return false;
	return participant.lastTransition.cause === "stand_down";
}
