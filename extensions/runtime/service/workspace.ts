import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HostedIntegration, HostedPiTarget, HostedTaskWorkspaceEvidence, HostedWorkspace } from "../hosted-types.ts";
import { RuntimeGit, RuntimeGitError, type RuntimeWorktreeIdentity } from "./git.ts";
import { deriveTargetKey, RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveRegistration, type RegisterWorkspacePiInput } from "./registration.ts";
import { deriveBridgeTargetKey, deriveParticipantKey, HostedStateStore } from "./state.ts";

const TOKEN = /^workspace_launch_([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export class HostedWorkspaceError extends Error {
	readonly code: "invalid_request" | "not_found" | "conflict" | "capability_unavailable" | "identity_mismatch" | "git_error";
	constructor(code: HostedWorkspaceError["code"], message: string) { super(message); this.code = code; }
}

export interface CreateWorkspaceInput {
	requestId: string;
	callerParticipantKey: string;
	expectedCallerGeneration: string;
	protocol: string;
	participantId: string;
	expectedParticipantGeneration?: string;
	piSessionId: string;
}

export interface CreateBridgeWorkspaceInput extends Omit<CreateWorkspaceInput, "piSessionId"> {
	bridgeId: string;
}

export interface WorkspaceAuthority {
	callerParticipantKey: string;
	expectedCallerGeneration: string;
}

export interface WorkspaceCoordinatorOptions {
	now?: () => number;
	launchLeaseMs?: number;
	createId?: (kind: "workspace" | "integration") => string;
	createGeneration?: () => string;
	createSecret?: () => string;
	git?: RuntimeGit;
}

export class RuntimeWorkspaceCoordinator {
	private readonly root: string;
	private readonly store: HostedStateStore;
	private readonly registrations: RuntimeRegistrationManager;
	private readonly host: HostedHostVerifier;
	private readonly options: WorkspaceCoordinatorOptions;
	private readonly git: RuntimeGit;
	private readonly locks = new Set<string>();

	constructor(root: string, store: HostedStateStore, registrations: RuntimeRegistrationManager, host: HostedHostVerifier, options: WorkspaceCoordinatorOptions = {}) {
		this.root = root;
		this.store = store;
		this.registrations = registrations;
		this.host = host;
		this.options = options;
		this.git = options.git ?? new RuntimeGit();
	}

	async create(caller: HostedLiveRegistration, input: CreateWorkspaceInput): Promise<{ workspace: HostedWorkspace; launchToken?: string; recoveryRequired?: true }> {
		return this.createOwned(caller, input, { kind: "pi", id: bounded(input.piSessionId, "Pi session ID", 200) });
	}

	async createBridge(caller: HostedLiveRegistration, input: CreateBridgeWorkspaceInput): Promise<{ workspace: HostedWorkspace; recoveryRequired?: true }> {
		const bridgeId = bounded(input.bridgeId, "bridge ID", 200);
		if (!/^[A-Za-z0-9_-]{1,200}$/.test(bridgeId)) throw new HostedWorkspaceError("invalid_request", "Bridge ID has invalid syntax.");
		return this.createOwned(caller, input, { kind: "bridge", id: bridgeId });
	}

	private async createOwned(caller: HostedLiveRegistration, input: Omit<CreateWorkspaceInput, "piSessionId">, owner: { kind: "pi" | "bridge"; id: string }): Promise<{ workspace: HostedWorkspace; launchToken?: string; recoveryRequired?: true }> {
		const target = this.requirePiCaller(caller, input);
		const requestId = bounded(input.requestId, "request ID", 200);
		const callerParticipantKey = bounded(input.callerParticipantKey, "caller participant key", 200);
		const callerGeneration = bounded(input.expectedCallerGeneration, "caller generation", 200);
		const protocol = participantName(input.protocol, "protocol");
		const participantId = participantName(input.participantId, "participant ID");
		const expectedParticipantGeneration = input.expectedParticipantGeneration === undefined ? undefined : bounded(input.expectedParticipantGeneration, "expected participant generation", 200);
		const prior = Object.values(this.store.read().workspaces).find((candidate) => candidate.callerTargetKey === caller.targetKey && candidate.requestId === requestId);
		if (prior) {
			const sameOwner = prior.ownerKind === owner.kind && (owner.kind === "pi" ? prior.piSessionId === owner.id : prior.bridgeId === owner.id);
			if (!["provisioning", "ready", "bound"].includes(prior.state) || !sameOwner || prior.callerParticipantKey !== callerParticipantKey || prior.callerGeneration !== callerGeneration || prior.protocol !== protocol || prior.participantId !== participantId || prior.expectedParticipantGeneration !== expectedParticipantGeneration) throw new HostedWorkspaceError("conflict", "Workspace request ID was reused with different or settled authority.");
			return { workspace: prior, recoveryRequired: true };
		}
		const repository = await this.git.discover(target.projectRoot);
		const workspaceId = this.id("workspace");
		const holderGeneration = this.options.createGeneration?.() ?? `lease_${randomUUID()}`;
		const launchToken = owner.kind === "pi" ? `workspace_launch_${workspaceId}.${secret(this.options.createSecret?.() ?? randomBytes(32).toString("base64url"))}` : undefined;
		const workspacesRoot = join(this.root, "workspaces");
		mkdirSync(workspacesRoot, { recursive: true, mode: 0o700 });
		const worktreePath = join(realpathSync(workspacesRoot), workspaceId);
		const now = this.now();
		const common = {
			version: 1 as const, workspaceId, requestId, projectRoot: repository.root, gitCommonDir: repository.commonDir, worktreePath, branchRef: `refs/heads/runtime/collab/${workspaceId}`, participantKey: deriveParticipantKey(repository.root, protocol, participantId), protocol, participantId, ...(expectedParticipantGeneration === undefined ? {} : { expectedParticipantGeneration }), holderGeneration, targetKey: owner.kind === "pi" ? deriveTargetKey(repository.root, owner.id) : deriveBridgeTargetKey(repository.root, owner.id), profile: "workspace-write" as const, callerParticipantKey, callerGeneration, callerTargetKey: caller.targetKey, baseCommit: repository.headCommit, headCommit: repository.headCommit, state: "provisioning" as const, createdAt: now, expiresAt: now + (this.options.launchLeaseMs ?? 5 * 60_000), updatedAt: now,
		};
		const workspace: HostedWorkspace = owner.kind === "pi" ? { ...common, ownerKind: "pi", piSessionId: owner.id, launchDigest: sha256(launchToken!) } : { ...common, ownerKind: "bridge", bridgeId: owner.id };
		this.store.apply({ type: "workspace.ensure", workspace });
		return this.withRepository(repository.commonDir, async () => {
			try {
				await this.git.createWorktree(repository, workspace.worktreePath, workspace.branchRef, workspace.baseCommit);
				const ready = { ...workspace, state: "ready" as const, updatedAt: this.tick(workspace.updatedAt) };
				this.store.apply({ type: "workspace.replace", workspace: ready, expectedState: "provisioning", expectedUpdatedAt: workspace.updatedAt });
				return { workspace: ready, ...(launchToken ? { launchToken } : {}) };
			} catch (error) {
				this.attention(workspace, "provisioning");
				throw workspaceError(error);
			}
		});
	}

	async recoverLaunch(caller: HostedLiveRegistration, input: WorkspaceAuthority & { requestId: string }): Promise<HostedWorkspace> {
		const workspace = Object.values(this.store.read().workspaces).find((candidate) => candidate.callerTargetKey === caller.targetKey && candidate.requestId === input.requestId);
		if (!workspace) throw new HostedWorkspaceError("not_found", "Workspace launch request does not exist.");
		this.assertCaller(caller, workspace.projectRoot, input);
		if (!['provisioning', 'ready', 'bound'].includes(workspace.state)) throw new HostedWorkspaceError("conflict", "Workspace launch is no longer recoverable as an unconsumed reservation.");
		const repository = await this.git.discover(workspace.projectRoot);
		return this.withRepository(repository.commonDir, async () => {
			const current = this.workspace(workspace.workspaceId);
			this.assertCaller(caller, current.projectRoot, input);
			if (!["provisioning", "ready", "bound"].includes(current.state)) throw new HostedWorkspaceError("conflict", "Workspace launch is no longer recoverable as an unconsumed reservation.");
			try {
				await this.git.discardWorktree(repository, worktree(current));
				const cleaned = { ...current, state: "cleaned" as const, updatedAt: this.tick(current.updatedAt) };
				this.store.apply({ type: "workspace.replace", workspace: cleaned, expectedState: current.state, expectedUpdatedAt: current.updatedAt });
				return cleaned;
			} catch (error) {
				this.attention(current, current.state);
				throw workspaceError(error);
			}
		});
	}

	async bind(caller: HostedLiveRegistration, input: WorkspaceAuthority & { workspaceId: string; herdr: { paneId: string; terminalId: string } }): Promise<HostedWorkspace> {
		const workspace = this.workspace(input.workspaceId);
		this.assertCaller(caller, workspace.projectRoot, input);
		if (!this.host.getPaneIdentity) throw new HostedWorkspaceError("capability_unavailable", "Herdr pane identity verification is unavailable.");
		const pane = await this.host.getPaneIdentity(input.herdr.paneId);
		let cwd: string;
		try { cwd = realpathSync(pane.cwd); } catch { throw new HostedWorkspaceError("identity_mismatch", "Workspace pane cwd is unavailable."); }
		if (pane.paneId !== input.herdr.paneId || pane.terminalId !== input.herdr.terminalId || pane.paneCount !== 1 || pane.agent !== undefined || cwd !== workspace.worktreePath) throw new HostedWorkspaceError("identity_mismatch", "Workspace launch pane is not the exact empty single-pane worktree target.");
		const at = this.tick(workspace.updatedAt);
		this.store.apply({ type: "workspace.bind", workspaceId: workspace.workspaceId, callerTargetKey: caller.targetKey, callerParticipantKey: input.callerParticipantKey, callerGeneration: input.expectedCallerGeneration, herdr: { paneId: pane.paneId, terminalId: pane.terminalId, tabId: pane.tabId, workspaceId: pane.workspaceId }, at });
		return this.workspace(workspace.workspaceId);
	}

	async register(input: RegisterWorkspacePiInput & { launchToken: string }): Promise<WorkspaceRegistrationResult> {
		const parsed = parseToken(input.launchToken);
		const workspace = this.workspace(parsed.workspaceId);
		if (workspace.ownerKind !== "pi" || workspace.state !== "bound" || !equalDigest(sha256(input.launchToken), workspace.launchDigest) || !workspace.herdr) throw new HostedWorkspaceError("conflict", "Workspace Pi launch capability is absent, consumed, or does not match.");
		const target = workspaceTarget(workspace, input.piSessionFile);
		const registration = await this.registrations.registerWorkspacePi(input, target, () => this.store.apply({ type: "workspace.consume", workspaceId: workspace.workspaceId, launchDigest: workspace.launchDigest, target, at: this.tick(workspace.updatedAt) }));
		return this.registrationResult(registration, this.workspace(workspace.workspaceId));
	}

	async reconnect(input: RegisterWorkspacePiInput & { workspaceId: string }): Promise<WorkspaceRegistrationResult> {
		const workspace = this.workspace(input.workspaceId);
		const target = this.store.read().targets[workspace.targetKey];
		const participant = this.store.read().participants[workspace.participantKey];
		const latest = participant?.transitions.at(-1);
		const held = participant?.state === "held" && participant.holderTargetKey === target?.targetKey && participant.generation === workspace.holderGeneration;
		const stoodDown = participant?.state === "vacant" && latest?.cause === "stand_down" && latest.previousHolderTargetKey === target?.targetKey && latest.previousGeneration === workspace.holderGeneration;
		if (!target || target.kind !== "pi" || !target.workspaceId || (!held && !stoodDown)) throw new HostedWorkspaceError("conflict", "Workspace Pi participant succession is no longer authorized.");
		const registration = await this.registrations.registerWorkspacePi(input, target);
		return this.registrationResult(registration, workspace);
	}

	async taskEvidence(targetKey: string): Promise<HostedTaskWorkspaceEvidence | undefined> { return this.withTaskEvidence(targetKey, (evidence) => evidence); }

	async withTaskEvidence<T>(targetKey: string, publish: (evidence?: HostedTaskWorkspaceEvidence) => T): Promise<T> {
		const target = this.store.read().targets[targetKey];
		if (!target?.workspaceId) return publish();
		const workspace = this.workspace(target.workspaceId);
		if (workspace.targetKey !== targetKey || target.workspaceRoot !== workspace.worktreePath) throw new HostedWorkspaceError("conflict", "Task result workspace target does not match Runtime ownership.");
		const repository = await this.git.discover(workspace.projectRoot);
		return this.withRepository(repository.commonDir, async () => {
			await this.git.verifyWorktree(repository, workspace.worktreePath, workspace.branchRef, workspace.headCommit);
			const status = await this.git.status(workspace.worktreePath);
			return publish({ workspaceId: workspace.workspaceId, baseCommit: workspace.baseCommit, headCommit: workspace.headCommit, branchRef: workspace.branchRef, state: workspace.state, dirty: !status.clean, artifactRef: workspace.branchRef, capturedAt: this.now() });
		});
	}

	inspect(caller: HostedLiveRegistration, workspaceId: string): HostedWorkspace {
		const workspace = this.workspace(workspaceId);
		this.assertProject(caller, workspace.projectRoot);
		return workspace;
	}

	inspectIntegration(caller: HostedLiveRegistration, integrationId: string): HostedIntegration {
		const integration = this.integration(integrationId);
		this.assertProject(caller, integration.projectRoot);
		return integration;
	}

	retain(caller: HostedLiveRegistration, input: WorkspaceAuthority & { workspaceId: string }): HostedWorkspace {
		const workspace = this.workspace(input.workspaceId);
		this.assertCaller(caller, workspace.projectRoot, input);
		if (!["ready", "bound", "active", "ready_handoff", "partial", "retained"].includes(workspace.state)) throw new HostedWorkspaceError("conflict", "Workspace is not retainable from its current state.");
		if (workspace.state === "retained") return workspace;
		const retained = { ...workspace, state: "retained" as const, updatedAt: this.tick(workspace.updatedAt) };
		this.store.apply({ type: "workspace.replace", workspace: retained, expectedState: workspace.state, expectedUpdatedAt: workspace.updatedAt });
		return retained;
	}

	async retainTarget(targetKey: string, holderGeneration: string): Promise<void> {
		const workspace = Object.values(this.store.read().workspaces).find((candidate) => candidate.targetKey === targetKey && candidate.holderGeneration === holderGeneration);
		if (!workspace || workspace.state !== "active") return;
		const next = { ...workspace, state: "retained" as const, updatedAt: this.tick(workspace.updatedAt) };
		this.store.apply({ type: "workspace.replace", workspace: next, expectedState: workspace.state, expectedUpdatedAt: workspace.updatedAt });
	}

	async reconcile(caller: HostedLiveRegistration, input: WorkspaceAuthority & { workspaceId: string }): Promise<HostedWorkspace> {
		const workspace = this.workspace(input.workspaceId);
		this.assertCaller(caller, workspace.projectRoot, input);
		if (workspace.state !== "provisioning") return workspace;
		const repository = await this.git.discover(workspace.projectRoot);
		try {
			await this.git.verifyWorktree(repository, workspace.worktreePath, workspace.branchRef, workspace.baseCommit);
			const ready = { ...workspace, state: "ready" as const, updatedAt: this.tick(workspace.updatedAt) };
			this.store.apply({ type: "workspace.replace", workspace: ready, expectedState: workspace.state, expectedUpdatedAt: workspace.updatedAt });
			return ready;
		} catch (error) {
			this.attention(workspace, workspace.state);
			throw workspaceError(error);
		}
	}

	async checkpoint(caller: HostedLiveRegistration, input: WorkspaceAuthority & { workspaceId: string; taskStatus?: "completed" | "failed" | "cancelled" }): Promise<HostedWorkspace> {
		const workspace = this.workspace(input.workspaceId);
		this.assertCaller(caller, workspace.projectRoot, input);
		if (!['retained', 'ready_handoff', 'partial'].includes(workspace.state)) throw new HostedWorkspaceError("conflict", "Workspace must be stopped/retained before checkpointing.");
		return this.checkpointWorkspace(workspace, input.taskStatus);
	}

	async prepareIntegration(caller: HostedLiveRegistration, input: WorkspaceAuthority & { workspaceId: string }): Promise<HostedIntegration> {
		const workspace = this.workspace(input.workspaceId);
		this.assertCaller(caller, workspace.projectRoot, input);
		const pending = Object.values(this.store.read().integrations).find((candidate) => candidate.workspaceId === workspace.workspaceId && candidate.state === "preparing");
		if (pending) return this.reconcileIntegration(caller, { ...input, integrationId: pending.integrationId });
		if (!['ready_handoff', 'retained', 'partial'].includes(workspace.state) || !workspace.commits?.length) throw new HostedWorkspaceError("conflict", "Workspace has no checkpointed handoff to integrate.");
		const repository = await this.git.discover(workspace.projectRoot);
		if (repository.commonDir !== workspace.gitCommonDir) throw new HostedWorkspaceError("identity_mismatch", "Workspace repository identity changed.");
		const integrationId = this.id("integration");
		const integrationsRoot = join(this.root, "integrations");
		mkdirSync(integrationsRoot, { recursive: true, mode: 0o700 });
		const now = this.now();
		const integration: HostedIntegration = { version: 1, integrationId, workspaceId: workspace.workspaceId, projectRoot: workspace.projectRoot, gitCommonDir: workspace.gitCommonDir, worktreePath: join(realpathSync(integrationsRoot), integrationId), branchRef: `refs/heads/runtime/integrate/${integrationId}`, mainBranchRef: repository.branchRef, mainHead: repository.headCommit, sourceHead: workspace.headCommit, sourceCommits: workspace.commits, state: "preparing", createdAt: now, updatedAt: now };
		this.store.apply({ type: "integration.ensure", integration });
		try {
			const result = await this.withRepository(repository.commonDir, async () => {
				const worktree = await this.git.createIntegrationWorktree(repository, integration.worktreePath, integration.branchRef, integration.mainHead);
				return { worktree, picked: await this.git.cherryPick(worktree.path, integration.sourceCommits) };
			});
			const next: HostedIntegration = result.picked.status === "prepared" ? { ...integration, state: "prepared", preparedHead: result.picked.headCommit, updatedAt: this.tick(integration.updatedAt) } : { ...integration, state: "conflicted", preparedHead: result.picked.headCommit, conflictPaths: result.picked.paths, updatedAt: this.tick(integration.updatedAt) };
			this.store.apply({ type: "integration.replace", integration: next, expectedState: "preparing", expectedUpdatedAt: integration.updatedAt });
			return next;
		} catch (error) {
			const next = { ...integration, state: "needs_attention" as const, updatedAt: this.tick(integration.updatedAt) };
			this.store.apply({ type: "integration.replace", integration: next, expectedState: "preparing", expectedUpdatedAt: integration.updatedAt });
			throw workspaceError(error);
		}
	}

	async reconcileIntegration(caller: HostedLiveRegistration, input: WorkspaceAuthority & { integrationId: string }): Promise<HostedIntegration> {
		const integration = this.integration(input.integrationId);
		this.assertCaller(caller, integration.projectRoot, input);
		if (integration.state !== "preparing") return integration;
		const repository = await this.git.discover(integration.projectRoot);
		try {
			const worktree = await this.git.verifyWorktree(repository, integration.worktreePath, integration.branchRef);
			const status = await this.git.status(worktree.path);
			let next: HostedIntegration;
			if (!status.clean) next = { ...integration, state: "conflicted", preparedHead: worktree.headCommit, conflictPaths: status.paths.slice(0, 10_000), updatedAt: this.tick(integration.updatedAt) };
			else if (worktree.headCommit === integration.mainHead) {
				const picked = await this.git.cherryPick(worktree.path, integration.sourceCommits);
				next = picked.status === "prepared" ? { ...integration, state: "prepared", preparedHead: picked.headCommit, updatedAt: this.tick(integration.updatedAt) } : { ...integration, state: "conflicted", preparedHead: picked.headCommit, conflictPaths: picked.paths, updatedAt: this.tick(integration.updatedAt) };
			} else {
				const recovered = await this.git.handoff(worktree.path, integration.mainHead, worktree.headCommit);
				if (recovered.commits.length !== integration.sourceCommits.length) throw new HostedWorkspaceError("conflict", "Prepared integration commit count does not match its source handoff.");
				next = { ...integration, state: "prepared", preparedHead: worktree.headCommit, updatedAt: this.tick(integration.updatedAt) };
			}
			this.store.apply({ type: "integration.replace", integration: next, expectedState: integration.state, expectedUpdatedAt: integration.updatedAt });
			return next;
		} catch (error) {
			this.attentionIntegration(integration);
			throw workspaceError(error);
		}
	}

	async finalizeIntegration(caller: HostedLiveRegistration, input: WorkspaceAuthority & { integrationId: string }): Promise<HostedIntegration> {
		const integration = this.integration(input.integrationId);
		this.assertCaller(caller, integration.projectRoot, input);
		if ((integration.state !== "prepared" && integration.state !== "finalized") || !integration.preparedHead) throw new HostedWorkspaceError("conflict", "Integration is not prepared/finalized for recovery.");
		const repository = await this.git.discover(integration.projectRoot);
		if (repository.commonDir !== integration.gitCommonDir || repository.branchRef !== integration.mainBranchRef) throw new HostedWorkspaceError("identity_mismatch", "Main repository identity changed.");
		await this.git.verifyWorktree(repository, integration.worktreePath, integration.branchRef, integration.preparedHead);
		await this.git.assertClean(integration.worktreePath);
		const finalizedHead = await this.withRepository(repository.commonDir, () => this.git.finalize(repository, integration.mainHead, integration.preparedHead!));
		const finalized: HostedIntegration = integration.state === "finalized" ? integration : { ...integration, state: "finalized", preparedHead: finalizedHead, updatedAt: this.tick(integration.updatedAt), finalizedAt: this.tick(integration.updatedAt) };
		if (integration.state === "prepared") this.store.apply({ type: "integration.replace", integration: finalized, expectedState: "prepared", expectedUpdatedAt: integration.updatedAt });
		const workspace = this.workspace(integration.workspaceId);
		if (workspace.state !== "integrated") {
			const integrated = { ...workspace, state: "integrated" as const, integratedHead: finalizedHead, updatedAt: this.tick(workspace.updatedAt) };
			this.store.apply({ type: "workspace.replace", workspace: integrated, expectedState: workspace.state, expectedUpdatedAt: workspace.updatedAt });
		} else if (workspace.integratedHead !== finalizedHead) throw new HostedWorkspaceError("conflict", "Workspace integration evidence does not match finalized main.");
		return finalized;
	}

	async cleanupWorkspace(caller: HostedLiveRegistration, input: WorkspaceAuthority & { workspaceId: string; discardConfirmed: boolean }): Promise<HostedWorkspace> {
		let workspace = this.workspace(input.workspaceId);
		this.assertCaller(caller, workspace.projectRoot, input);
		if (workspace.state !== "integrated") {
			if (!input.discardConfirmed || !["ready", "bound", "retained", "ready_handoff", "partial"].includes(workspace.state)) throw new HostedWorkspaceError("conflict", "Unintegrated workspace cleanup requires exact retained/provisioned state and explicit discard confirmation.");
			if (!["ready", "bound"].includes(workspace.state)) workspace = await this.checkpointWorkspace(workspace, "cancelled");
		}
		const repository = await this.git.discover(workspace.projectRoot);
		await this.withRepository(repository.commonDir, () => this.git.removeWorktree(repository, worktree(workspace)));
		const cleaned = { ...workspace, state: "cleaned" as const, updatedAt: this.tick(workspace.updatedAt) };
		this.store.apply({ type: "workspace.replace", workspace: cleaned, expectedState: workspace.state, expectedUpdatedAt: workspace.updatedAt });
		return cleaned;
	}

	async cleanupIntegration(caller: HostedLiveRegistration, input: WorkspaceAuthority & { integrationId: string; discardConfirmed: boolean }): Promise<HostedIntegration> {
		const integration = this.integration(input.integrationId);
		this.assertCaller(caller, integration.projectRoot, input);
		if (!integration.preparedHead || !["finalized", "prepared", "conflicted"].includes(integration.state)) throw new HostedWorkspaceError("conflict", "Integration is not safely identifiable for cleanup.");
		if (integration.state !== "finalized" && !input.discardConfirmed) throw new HostedWorkspaceError("conflict", "Unfinalized integration cleanup requires explicit discard confirmation.");
		const repository = await this.git.discover(integration.projectRoot);
		const worktree = { path: integration.worktreePath, branchRef: integration.branchRef, headCommit: integration.preparedHead };
		await this.withRepository(repository.commonDir, () => integration.state === "finalized" ? this.git.removeWorktree(repository, worktree) : this.git.discardWorktree(repository, worktree));
		const cleaned = { ...integration, state: "cleaned" as const, updatedAt: this.tick(integration.updatedAt) };
		this.store.apply({ type: "integration.replace", integration: cleaned, expectedState: integration.state, expectedUpdatedAt: integration.updatedAt });
		return cleaned;
	}

	private async checkpointWorkspace(workspace: HostedWorkspace, taskStatus?: HostedWorkspace["taskStatus"]): Promise<HostedWorkspace> {
		const repository = await this.git.discover(workspace.projectRoot);
		if (repository.commonDir !== workspace.gitCommonDir) throw new HostedWorkspaceError("identity_mismatch", "Workspace repository identity changed.");
		try {
			const handoff = await this.withRepository(repository.commonDir, () => this.git.checkpoint(repository, worktree(workspace), workspace.baseCommit, `Runtime checkpoint ${workspace.workspaceId}`));
			const state = taskStatus === "failed" || taskStatus === "cancelled" ? "partial" as const : "ready_handoff" as const;
			const next: HostedWorkspace = { ...workspace, ...handoff, state, ...(taskStatus ? { taskStatus } : {}), updatedAt: this.tick(workspace.updatedAt) };
			this.store.apply({ type: "workspace.replace", workspace: next, expectedState: workspace.state, expectedUpdatedAt: workspace.updatedAt });
			return next;
		} catch (error) {
			this.attention(workspace, workspace.state);
			throw workspaceError(error);
		}
	}

	private registrationResult(registration: HostedLiveRegistration, workspace: HostedWorkspace): WorkspaceRegistrationResult {
		const participant = this.store.read().participants[workspace.participantKey];
		if (!participant || (participant.state !== "held" && participant.state !== "vacant")) throw new HostedWorkspaceError("conflict", "Workspace participant state is unavailable for registration.");
		return { registration, workspace, participantKey: workspace.participantKey, holderGeneration: workspace.holderGeneration, participantGeneration: participant.generation, participantState: participant.state, protocol: workspace.protocol, participantId: workspace.participantId };
	}

	private requirePiCaller(caller: HostedLiveRegistration, input: WorkspaceAuthority): HostedPiTarget {
		const target = this.store.read().targets[caller.targetKey];
		this.assertCaller(caller, target?.projectRoot, input);
		if (!target || target.kind !== "pi" || target.workspaceId) throw new HostedWorkspaceError("conflict", "Only a main project Pi target may create collaborator workspaces.");
		return target;
	}

	private assertCaller(caller: HostedLiveRegistration, projectRoot: string | undefined, input: WorkspaceAuthority): void {
		this.assertProject(caller, projectRoot);
		const participant = this.store.read().participants[input.callerParticipantKey];
		if (!participant || participant.state !== "held" || participant.generation !== input.expectedCallerGeneration || participant.holderTargetKey !== caller.targetKey || participant.projectRoot !== projectRoot) throw new HostedWorkspaceError("conflict", "Workspace caller authority changed.");
	}

	private assertProject(caller: HostedLiveRegistration, projectRoot: string | undefined): void {
		const target = this.store.read().targets[caller.targetKey];
		if (!target || target.kind !== "pi" || !projectRoot || target.projectRoot !== projectRoot) throw new HostedWorkspaceError("conflict", "Workspace operation caller belongs to another project.");
	}

	private attentionIntegration(integration: HostedIntegration): void {
		try {
			const next = { ...integration, state: "needs_attention" as const, updatedAt: this.tick(integration.updatedAt) };
			this.store.apply({ type: "integration.replace", integration: next, expectedState: integration.state, expectedUpdatedAt: integration.updatedAt });
		} catch {}
	}

	private attention(workspace: HostedWorkspace, expectedState: HostedWorkspace["state"]): void {
		try {
			const next = { ...workspace, state: "needs_attention" as const, updatedAt: this.tick(workspace.updatedAt) };
			this.store.apply({ type: "workspace.replace", workspace: next, expectedState, expectedUpdatedAt: workspace.updatedAt });
		} catch {}
	}

	private workspace(id: string): HostedWorkspace { const value = this.store.read().workspaces[id]; if (!value) throw new HostedWorkspaceError("not_found", "Workspace does not exist."); return value; }
	private integration(id: string): HostedIntegration { const value = this.store.read().integrations[id]; if (!value) throw new HostedWorkspaceError("not_found", "Integration does not exist."); return value; }
	private id(kind: "workspace" | "integration"): string { const value = this.options.createId?.(kind) ?? `${kind}_${randomUUID()}`; if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new HostedWorkspaceError("invalid_request", `${kind} ID has invalid syntax.`); return value; }
	private now(): number { return this.options.now?.() ?? Date.now(); }
	private tick(previous: number): number { return Math.max(this.now(), previous + 1); }
	private async withRepository<T>(key: string, operation: () => Promise<T>): Promise<T> { if (this.locks.has(key)) throw new HostedWorkspaceError("conflict", "Another Runtime Git operation is active for this repository."); this.locks.add(key); try { return await operation(); } finally { this.locks.delete(key); } }
}

export interface WorkspaceRegistrationResult {
	registration: HostedLiveRegistration;
	workspace: HostedWorkspace;
	participantKey: string;
	holderGeneration: string;
	participantGeneration: string;
	participantState: "held" | "vacant";
	protocol: string;
	participantId: string;
}

function workspaceTarget(workspace: HostedWorkspace & { ownerKind: "pi" }, piSessionFile: string): HostedPiTarget {
	return { kind: "pi", targetKey: workspace.targetKey, projectRoot: workspace.projectRoot, piSessionId: workspace.piSessionId, piSessionFile: realpathSync(piSessionFile), workspaceId: workspace.workspaceId, workspaceRoot: workspace.worktreePath, createdAt: workspace.updatedAt + 1 };
}

function worktree(workspace: HostedWorkspace): RuntimeWorktreeIdentity { return { path: workspace.worktreePath, branchRef: workspace.branchRef, headCommit: workspace.headCommit }; }
function parseToken(value: string): { workspaceId: string } { const match = TOKEN.exec(value); if (!match) throw new HostedWorkspaceError("invalid_request", "Workspace launch token has invalid syntax."); return { workspaceId: match[1]! }; }
function participantName(value: string, name: string): string { if (!NAME.test(value)) throw new HostedWorkspaceError("invalid_request", `${name} has invalid syntax.`); return value; }
function bounded(value: string, name: string, max: number): string { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new HostedWorkspaceError("invalid_request", `${name} is invalid.`); return value; }
function secret(value: string): string { if (!SECRET.test(value)) throw new HostedWorkspaceError("invalid_request", "Workspace launch secret has invalid syntax."); return value; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equalDigest(left: string, right: string): boolean { if (!HASH.test(left) || !HASH.test(right)) return false; return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex")); }
function workspaceError(error: unknown): HostedWorkspaceError { return error instanceof HostedWorkspaceError ? error : error instanceof RuntimeGitError ? new HostedWorkspaceError("git_error", error.message) : new HostedWorkspaceError("git_error", error instanceof Error ? error.message : String(error)); }
