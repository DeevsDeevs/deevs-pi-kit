import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	HOSTED_ACK_RETENTION_MS,
	HOSTED_AUTO_MAX_COLLABORATORS,
	HOSTED_BRIDGE_FORBIDDEN_METADATA_KEYS,
	HOSTED_BRIDGE_MAX_METADATA_ENTRIES,
	HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES,
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
	HOSTED_STATE_MAX_BYTES,
	type HostedAgentSessionIdentity,
	type HostedAutoCapacityReservation,
	type HostedBridgeLaunch,
	type HostedExternalTarget,
	type HostedClaim,
	type HostedEvent,
	type HostedEventDelivery,
	type HostedFileObservation,
	type HostedFilesystemCreatedEvent,
	type HostedMailboxMessageEvent,
	type HostedMailboxTaskEvent,
	type HostedMailboxTaskResultEvent,
	type HostedIntegration,
	type HostedMonitor,
	type HostedParticipant,
	type HostedParticipantTransition,
	type HostedRuntimeInstance,
	type HostedRuntimeState,
	type HostedStateOperation,
	type HostedTarget,
	type HostedTaskWorkspaceEvidence,
	type HostedWake,
	type HostedWorkspace,
} from "../hosted-types.ts";

const MAX_ID_BYTES = 200;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024;
const MAX_STATE_RECORDS = 10_000;
const HASH = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;
const FORBIDDEN_BRIDGE_METADATA = new Set<string>(HOSTED_BRIDGE_FORBIDDEN_METADATA_KEYS);
const WORKSPACE_BRANCH = /^refs\/heads\/runtime\/collab\/[A-Za-z0-9._-]+$/;
const INTEGRATION_BRANCH = /^refs\/heads\/runtime\/integrate\/[A-Za-z0-9._-]+$/;
const INSTANCE_MAX_BYTES = 4 * 1024;

export class HostedStateStorageError extends Error {
	readonly code = "storage_error" as const;
}

export class HostedStateConflictError extends Error {
	readonly code: "conflict" | "claim_conflict";

	constructor(code: "conflict" | "claim_conflict", message: string) {
		super(message);
		this.code = code;
	}
}

export function emptyHostedRuntimeState(): HostedRuntimeState {
	return { version: 8, targets: {}, autoCapacityReservations: {}, bridgeLaunches: {}, workspaces: {}, integrations: {}, monitors: {}, participants: {}, events: {}, dedupe: {}, claims: {}, wakes: {} };
}

export class HostedStateStore {
	readonly root: string;
	private state: HostedRuntimeState;

	constructor(root: string) {
		this.root = root;
		this.state = readHostedRuntimeState(root);
	}

	read(): HostedRuntimeState {
		return this.state;
	}

	apply(operation: HostedStateOperation): HostedRuntimeState {
		const next = reduceHostedState(this.state, operation);
		if (next === this.state) return this.state;
		writeHostedRuntimeState(this.root, next);
		this.state = next;
		return next;
	}
}

export function reduceHostedState(state: HostedRuntimeState, operation: HostedStateOperation): HostedRuntimeState {
	if (operation.type === "target.ensure") {
		const existing = state.targets[operation.target.targetKey];
		if (existing) {
			if (!sameTarget(existing, operation.target)) throw new HostedStateConflictError("conflict", "Target identity does not match its durable key.");
			return state;
		}
		return { ...state, targets: { ...state.targets, [operation.target.targetKey]: operation.target } };
	}

	if (operation.type === "auto_capacity.ensure") {
		const reservation = operation.reservation;
		assertStateId(reservation.operationId, "Auto capacity operation ID");
		assertStateId(reservation.callerTargetKey, "Auto capacity caller target key");
		assertStateId(reservation.callerParticipantKey, "Auto capacity caller participant key");
		for (const participantKey of reservation.participantKeys) assertStateId(participantKey, "Auto capacity participant key");
		assertStateTime(reservation.createdAt, "Auto capacity reservation time");
		if (reservation.version !== 1 || reservation.participantKeys.length < 1 || reservation.participantKeys.length > HOSTED_AUTO_MAX_COLLABORATORS || new Set(reservation.participantKeys).size !== reservation.participantKeys.length || reservation.participantKeys.includes(reservation.callerParticipantKey)) throw new HostedStateConflictError("conflict", "Auto capacity reservation is invalid.");
		const existing = state.autoCapacityReservations[reservation.operationId];
		if (existing) {
			if (!sameAutoCapacityReservation(existing, reservation)) throw new HostedStateConflictError("conflict", "Auto capacity operation ID was reused with different authority.");
			return state;
		}
		const target = state.targets[reservation.callerTargetKey];
		if (target?.kind !== "pi" || target.projectRoot !== reservation.projectRoot) throw new HostedStateConflictError("conflict", "Auto capacity caller target is invalid.");
		const caller = state.participants[reservation.callerParticipantKey];
		if (caller?.state === "held" ? caller.holderTargetKey !== reservation.callerTargetKey || caller.generation !== reservation.expectedCallerGeneration : caller?.state === "ended" || reservation.expectedCallerGeneration !== undefined || Object.values(state.participants).some((participant) => participant.state === "held" && participant.holderTargetKey === reservation.callerTargetKey)) throw new HostedStateConflictError("conflict", "Auto capacity caller authority changed.");
		if (Object.values(state.autoCapacityReservations).some((candidate) => candidate.participantKeys.some((key) => reservation.participantKeys.includes(key)))) throw new HostedStateConflictError("conflict", "Auto collaborator already has a capacity reservation.");
		assertAutoCapacity(state, reservation.projectRoot, reservation.callerParticipantKey, reservation.participantKeys);
		return { ...state, autoCapacityReservations: { ...state.autoCapacityReservations, [reservation.operationId]: reservation } };
	}

	if (operation.type === "auto_capacity.release") {
		const reservation = state.autoCapacityReservations[operation.operationId];
		if (!reservation) return state;
		if (reservation.callerTargetKey !== operation.callerTargetKey) throw new HostedStateConflictError("conflict", "Only the exact Auto capacity caller may release its reservation.");
		const reservations = { ...state.autoCapacityReservations };
		delete reservations[operation.operationId];
		return { ...state, autoCapacityReservations: reservations };
	}

	if (operation.type === "bridge.launch.ensure") {
		const launch = operation.launch;
		assertStateId(launch.launchId, "Bridge launch ID");
		assertStateId(launch.requestId, "Bridge launch request ID");
		assertStateTime(launch.createdAt, "Bridge launch creation time");
		if (launch.status !== "pending" || launch.expiresAt <= launch.createdAt || !HASH.test(launch.launchDigest) || !HASH.test(launch.reconnectDigest) || !HASH.test(launch.configurationHash)) throw new HostedStateConflictError("conflict", "Bridge launch authority is invalid.");
		const caller = state.participants[launch.callerParticipantKey];
		const callerTarget = state.targets[launch.callerTargetKey];
		if (!caller || caller.state !== "held" || caller.generation !== launch.callerGeneration || caller.holderTargetKey !== launch.callerTargetKey || callerTarget?.kind !== "pi" || caller.projectRoot !== launch.projectRoot) throw new HostedStateConflictError("conflict", "Bridge launch caller authority changed.");
		if (launch.participantKey !== deriveParticipantKey(launch.projectRoot, launch.protocol, launch.participantId) || launch.participantKey === launch.callerParticipantKey || state.targets[launch.targetKey]) throw new HostedStateConflictError("conflict", "Bridge launch participant or target identity is invalid.");
		const workspace = launch.workspaceId ? state.workspaces[launch.workspaceId] : undefined;
		if (launch.profile === "workspace-write" ? !workspace || workspace.ownerKind !== "bridge" || workspace.bridgeId !== launch.launchId || workspace.state !== "bound" || workspace.projectRoot !== launch.projectRoot || workspace.worktreePath !== launch.workspaceRoot || workspace.targetKey !== launch.targetKey || workspace.participantKey !== launch.participantKey || workspace.holderGeneration !== launch.holderGeneration || workspace.callerTargetKey !== launch.callerTargetKey || workspace.callerParticipantKey !== launch.callerParticipantKey || workspace.callerGeneration !== launch.callerGeneration || workspace.expectedParticipantGeneration !== launch.expectedParticipantGeneration || JSON.stringify(workspace.herdr) !== JSON.stringify(launch.herdr) : launch.workspaceId !== undefined || launch.workspaceRoot !== undefined) throw new HostedStateConflictError("conflict", "Bridge launch workspace authority is invalid.");
		const participant = state.participants[launch.participantKey];
		if (participant ? participant.state !== "vacant" || participant.generation !== launch.expectedParticipantGeneration : launch.expectedParticipantGeneration !== undefined) throw new HostedStateConflictError("conflict", "Bridge launch participant generation is unavailable.");
		const retry = Object.values(state.bridgeLaunches).find((candidate) => candidate.callerTargetKey === launch.callerTargetKey && candidate.requestId === launch.requestId);
		if (retry) {
			if (!sameBridgeLaunch(retry, launch)) throw new HostedStateConflictError("conflict", "Bridge launch request ID was reused with different authority.");
			return state;
		}
		if (Object.values(state.bridgeLaunches).some((candidate) => candidate.participantKey === launch.participantKey && candidate.status === "pending" && candidate.expiresAt > launch.createdAt) || Object.values(state.workspaces).some((candidate) => candidate.participantKey === launch.participantKey && ["provisioning", "ready", "bound", "active"].includes(candidate.state) && candidate.workspaceId !== launch.workspaceId)) throw new HostedStateConflictError("conflict", "Participant already has a pending collaborator reservation.");
		return { ...state, bridgeLaunches: { ...state.bridgeLaunches, [launch.launchId]: launch } };
	}

	if (operation.type === "bridge.launch.consume") {
		const launch = state.bridgeLaunches[operation.launchId];
		if (!launch || launch.launchDigest !== operation.launchDigest) throw new HostedStateConflictError("conflict", "Bridge launch capability is absent or does not match.");
		if (launch.status === "consumed") throw new HostedStateConflictError("conflict", "Bridge launch capability was already consumed.");
		if (launch.status !== "pending" || operation.at > launch.expiresAt || operation.at < launch.createdAt) throw new HostedStateConflictError("conflict", "Bridge launch capability is not consumable.");
		const caller = state.participants[launch.callerParticipantKey];
		if (!caller || caller.state !== "held" || caller.generation !== launch.callerGeneration || caller.holderTargetKey !== launch.callerTargetKey) throw new HostedStateConflictError("conflict", "Bridge launch caller authority changed before consumption.");
		const participant = state.participants[launch.participantKey];
		if (participant ? participant.state !== "vacant" || participant.generation !== launch.expectedParticipantGeneration : launch.expectedParticipantGeneration !== undefined) throw new HostedStateConflictError("conflict", "Bridge launch participant generation changed before consumption.");
		if (!bridgeTargetMatchesLaunch(operation.target, launch, operation.clientGeneration)) throw new HostedStateConflictError("conflict", "Bridge target does not match its launch authority.");
		const consumed: HostedBridgeLaunch = { ...launch, status: "consumed", consumedAt: operation.at, clientGeneration: operation.clientGeneration };
		let next: HostedRuntimeState = { ...state, bridgeLaunches: { ...state.bridgeLaunches, [launch.launchId]: consumed } };
		next = reduceHostedState(next, { type: "target.ensure", target: operation.target });
		if (launch.workspaceId) {
			const workspace = next.workspaces[launch.workspaceId];
			if (!workspace || workspace.ownerKind !== "bridge" || workspace.state !== "bound" || !workspaceTargetMatches(operation.target, workspace)) throw new HostedStateConflictError("conflict", "Bridge workspace changed before launch consumption.");
			next = reduceHostedState(next, { type: "workspace.replace", workspace: { ...workspace, state: "active", updatedAt: operation.at }, expectedState: "bound", expectedUpdatedAt: workspace.updatedAt });
		}
		next = reduceHostedState(next, { type: "participant.acquire", participantKey: launch.participantKey, projectRoot: launch.projectRoot, protocol: launch.protocol, participantId: launch.participantId, targetKey: launch.targetKey, generation: launch.holderGeneration, at: operation.at });
		return next;
	}

	if (operation.type === "bridge.launch.cancel" || operation.type === "bridge.launch.expire") {
		assertStateTime(operation.at, "Bridge launch settlement time");
		const launch = state.bridgeLaunches[operation.launchId];
		if (!launch || launch.status === "cancelled" || launch.status === "expired") return state;
		if (launch.status !== "pending") throw new HostedStateConflictError("conflict", "Consumed bridge launch authority cannot be revoked as pending.");
		if (operation.type === "bridge.launch.cancel") {
			if (launch.callerTargetKey !== operation.callerTargetKey || launch.callerParticipantKey !== operation.callerParticipantKey || launch.callerGeneration !== operation.callerGeneration) throw new HostedStateConflictError("conflict", "Only the exact launch caller may cancel bridge authority.");
		} else if (operation.at < launch.expiresAt) throw new HostedStateConflictError("conflict", "Bridge launch authority has not expired.");
		return { ...state, bridgeLaunches: { ...state.bridgeLaunches, [launch.launchId]: { ...launch, status: operation.type === "bridge.launch.cancel" ? "cancelled" : "expired" } } };
	}

	if (operation.type === "workspace.ensure") {
		const workspace = operation.workspace;
		if (workspace.state !== "provisioning" || workspace.profile !== "workspace-write" || workspace.headCommit !== workspace.baseCommit || workspace.herdr || workspace.commits || (workspace.ownerKind === "pi" ? !HASH.test(workspace.launchDigest) : workspace.targetKey !== deriveBridgeTargetKey(workspace.projectRoot, workspace.bridgeId))) throw new HostedStateConflictError("conflict", "Workspace launch reservation is invalid.");
		const caller = state.participants[workspace.callerParticipantKey];
		const callerTarget = state.targets[workspace.callerTargetKey];
		if (!caller || caller.state !== "held" || caller.generation !== workspace.callerGeneration || caller.holderTargetKey !== workspace.callerTargetKey || callerTarget?.kind !== "pi" || caller.projectRoot !== workspace.projectRoot) throw new HostedStateConflictError("conflict", "Workspace launch caller authority changed.");
		if (workspace.participantKey !== deriveParticipantKey(workspace.projectRoot, workspace.protocol, workspace.participantId) || workspace.participantKey === workspace.callerParticipantKey || state.targets[workspace.targetKey]) throw new HostedStateConflictError("conflict", "Workspace participant or target identity is invalid.");
		const participant = state.participants[workspace.participantKey];
		if (participant ? participant.state !== "vacant" || participant.generation !== workspace.expectedParticipantGeneration : workspace.expectedParticipantGeneration !== undefined) throw new HostedStateConflictError("conflict", "Workspace participant generation is unavailable.");
		const retry = Object.values(state.workspaces).find((candidate) => candidate.callerTargetKey === workspace.callerTargetKey && candidate.requestId === workspace.requestId);
		if (retry) {
			if (!sameWorkspace(retry, workspace)) throw new HostedStateConflictError("conflict", "Workspace request ID was reused with different authority.");
			return state;
		}
		if (state.workspaces[workspace.workspaceId] || Object.values(state.workspaces).some((candidate) => candidate.participantKey === workspace.participantKey && ["provisioning", "ready", "bound", "active"].includes(candidate.state)) || Object.values(state.bridgeLaunches).some((candidate) => candidate.participantKey === workspace.participantKey && candidate.status === "pending" && candidate.expiresAt > workspace.createdAt)) throw new HostedStateConflictError("conflict", "Participant already owns an active collaborator reservation.");
		return { ...state, workspaces: { ...state.workspaces, [workspace.workspaceId]: workspace } };
	}

	if (operation.type === "workspace.replace") {
		const current = state.workspaces[operation.workspace.workspaceId];
		if (!current || current.state !== operation.expectedState || current.updatedAt !== operation.expectedUpdatedAt || !sameWorkspaceIdentity(current, operation.workspace) || operation.workspace.updatedAt <= current.updatedAt || !workspaceTransitionAllowed(current.state, operation.workspace.state)) throw new HostedStateConflictError("conflict", "Workspace state changed before replacement.");
		return { ...state, workspaces: { ...state.workspaces, [current.workspaceId]: operation.workspace } };
	}

	if (operation.type === "workspace.bind") {
		const current = state.workspaces[operation.workspaceId];
		if (!current || current.state !== "ready" || current.callerTargetKey !== operation.callerTargetKey || current.callerParticipantKey !== operation.callerParticipantKey || current.callerGeneration !== operation.callerGeneration || current.updatedAt >= operation.at || operation.at > current.expiresAt) throw new HostedStateConflictError("conflict", "Workspace is not bindable by this caller generation.");
		const caller = state.participants[current.callerParticipantKey];
		if (!caller || caller.state !== "held" || caller.generation !== current.callerGeneration || caller.holderTargetKey !== current.callerTargetKey) throw new HostedStateConflictError("conflict", "Workspace caller authority changed before host binding.");
		return { ...state, workspaces: { ...state.workspaces, [current.workspaceId]: { ...current, herdr: operation.herdr, state: "bound", updatedAt: operation.at } } };
	}

	if (operation.type === "workspace.consume") {
		const workspace = state.workspaces[operation.workspaceId];
		if (!workspace || workspace.ownerKind !== "pi" || workspace.state !== "bound" || workspace.launchDigest !== operation.launchDigest || operation.at <= workspace.updatedAt || operation.at > workspace.expiresAt) throw new HostedStateConflictError("conflict", "Workspace Pi launch capability is not consumable.");
		const caller = state.participants[workspace.callerParticipantKey];
		if (!caller || caller.state !== "held" || caller.generation !== workspace.callerGeneration || caller.holderTargetKey !== workspace.callerTargetKey) throw new HostedStateConflictError("conflict", "Workspace caller authority changed before consumption.");
		const participant = state.participants[workspace.participantKey];
		if (participant ? participant.state !== "vacant" || participant.generation !== workspace.expectedParticipantGeneration : workspace.expectedParticipantGeneration !== undefined) throw new HostedStateConflictError("conflict", "Workspace participant generation changed before consumption.");
		if (!workspaceTargetMatches(operation.target, workspace)) throw new HostedStateConflictError("conflict", "Pi workspace target does not match its launch reservation.");
		let next: HostedRuntimeState = { ...state, workspaces: { ...state.workspaces, [workspace.workspaceId]: { ...workspace, state: "active", updatedAt: operation.at } } };
		next = reduceHostedState(next, { type: "target.ensure", target: operation.target });
		next = reduceHostedState(next, { type: "participant.acquire", participantKey: workspace.participantKey, projectRoot: workspace.projectRoot, protocol: workspace.protocol, participantId: workspace.participantId, targetKey: workspace.targetKey, generation: workspace.holderGeneration, at: operation.at });
		return next;
	}

	if (operation.type === "integration.ensure") {
		const integration = operation.integration;
		const active = Object.values(state.integrations).some((candidate) => candidate.workspaceId === integration.workspaceId && candidate.state !== "cleaned");
		if (integration.state !== "preparing" || state.integrations[integration.integrationId] || active || !state.workspaces[integration.workspaceId]) throw new HostedStateConflictError("conflict", "Integration reservation is invalid.");
		return { ...state, integrations: { ...state.integrations, [integration.integrationId]: integration } };
	}

	if (operation.type === "integration.replace") {
		const current = state.integrations[operation.integration.integrationId];
		if (!current || current.state !== operation.expectedState || current.updatedAt !== operation.expectedUpdatedAt || !sameIntegrationIdentity(current, operation.integration) || operation.integration.updatedAt <= current.updatedAt || !integrationTransitionAllowed(current.state, operation.integration.state)) throw new HostedStateConflictError("conflict", "Integration state changed before replacement.");
		return { ...state, integrations: { ...state.integrations, [current.integrationId]: operation.integration } };
	}

	if (operation.type === "monitor.create") {
		const monitor = operation.monitor;
		if (!state.targets[monitor.targetKey] || Object.keys(monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
		const existingId = state.monitors[monitor.monitorId];
		if (existingId && !sameMonitorIdentity(existingId, monitor)) throw new HostedStateConflictError("conflict", "Monitor ID already belongs to another monitor.");
		const existingTarget = Object.values(state.monitors).find((candidate) => candidate.targetKey === monitor.targetKey);
		if (existingTarget) {
			if (existingTarget.directory !== monitor.directory) throw new HostedStateConflictError("conflict", "Target already owns another monitor.");
			return state;
		}
		return { ...state, monitors: { ...state.monitors, [monitor.monitorId]: monitor } };
	}

	if (operation.type === "monitor.delete") {
		const monitor = state.monitors[operation.monitorId];
		if (!monitor || monitor.targetKey !== operation.targetKey) return state;
		const monitors = { ...state.monitors };
		delete monitors[operation.monitorId];
		return { ...state, monitors };
	}

	if (operation.type === "monitor.commit") {
		const current = state.monitors[operation.monitor.monitorId];
		if (!current || !sameMonitorIdentity(current, operation.monitor)) return state;
		if (operation.monitor.createdAt !== current.createdAt || operation.monitor.sequence < current.sequence || operation.monitor.updatedAt < current.updatedAt) return state;
		if (Object.keys(operation.monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
		if (operation.events.some((event) => !validMonitorEvent(operation.monitor, event) || event.source.sequence <= current.sequence || event.source.sequence > operation.monitor.sequence)) return state;
		let changed = current !== operation.monitor;
		const events = { ...state.events };
		const dedupe = { ...state.dedupe };
		for (const event of operation.events) {
			if (events[event.eventId] || dedupe[event.dedupeKey]) continue;
			events[event.eventId] = event;
			dedupe[event.dedupeKey] = event.eventId;
			changed = true;
		}
		if (!changed) return state;
		return {
			...state,
			monitors: { ...state.monitors, [operation.monitor.monitorId]: operation.monitor },
			events,
			dedupe,
		};
	}

	if (operation.type === "participant.acquire") {
		assertStateId(operation.generation, "Participant generation");
		assertStateTime(operation.at, "Participant acquisition time");
		const target = state.targets[operation.targetKey];
		if (!target || target.projectRoot !== operation.projectRoot || operation.participantKey !== deriveParticipantKey(operation.projectRoot, operation.protocol, operation.participantId)) {
			throw new HostedStateConflictError("conflict", "Participant identity does not match its target or durable key.");
		}
		assertParticipantName(operation.protocol, "protocol");
		assertParticipantName(operation.participantId, "participant ID");
		if (Object.values(state.bridgeLaunches).some((launch) => launch.participantKey === operation.participantKey && launch.status === "pending" && launch.expiresAt > operation.at)) throw new HostedStateConflictError("conflict", "Participant is reserved for a pending bridge launch.");
		if (Object.values(state.workspaces).some((workspace) => workspace.participantKey === operation.participantKey && ["provisioning", "ready", "bound"].includes(workspace.state))) throw new HostedStateConflictError("conflict", "Participant is reserved for a pending workspace launch.");
		const current = state.participants[operation.participantKey];
		if (current?.state === "held") {
			if (current.holderTargetKey === operation.targetKey) return state;
			throw new HostedStateConflictError("conflict", "Participant is held by another target.");
		}
		assertAutoCapacity(state, operation.projectRoot, undefined, [operation.participantKey]);
		assertTargetHasNoParticipant(state, operation.targetKey, operation.participantKey);
		if (!current) {
			const participant: HostedParticipant = {
				participantKey: operation.participantKey,
				projectRoot: operation.projectRoot,
				protocol: operation.protocol,
				participantId: operation.participantId,
				state: "held",
				generation: operation.generation,
				holderTargetKey: operation.targetKey,
				outSeq: {},
				transitions: [{ cause: "acquire", generation: operation.generation, holderTargetKey: operation.targetKey, at: operation.at }],
				createdAt: operation.at,
				updatedAt: operation.at,
			};
			return { ...state, participants: { ...state.participants, [participant.participantKey]: participant } };
		}
		if (current.projectRoot !== operation.projectRoot || current.protocol !== operation.protocol || current.participantId !== operation.participantId || current.generation === operation.generation || operation.at < current.updatedAt) {
			throw new HostedStateConflictError("conflict", "Participant acquire does not match its durable identity or generation.");
		}
		const cause = current.state === "vacant" ? "reacquire" : "revive";
		const acquired = replaceParticipant(state, transitionParticipant(current, {
			cause,
			generation: operation.generation,
			holderTargetKey: operation.targetKey,
			previousGeneration: current.generation,
			previousHolderTargetKey: latestHolderTargetKey(current),
			at: operation.at,
		}, "held", operation.targetKey));
		const workspace = target.kind === "pi" && target.workspaceId ? acquired.workspaces[target.workspaceId] : undefined;
		return workspace ? { ...acquired, workspaces: { ...acquired.workspaces, [workspace.workspaceId]: { ...workspace, holderGeneration: operation.generation, state: "active", updatedAt: Math.max(operation.at, workspace.updatedAt + 1) } } } : acquired;
	}

	if (operation.type === "participant.stand_down" || operation.type === "participant.release") {
		assertStateId(operation.generation, "Participant generation");
		assertStateTime(operation.at, "Participant transition time");
		const current = state.participants[operation.participantKey];
		const cause = operation.type === "participant.stand_down" ? "stand_down" : "release";
		const nextState = operation.type === "participant.stand_down" ? "vacant" : "ended";
		if (!current) throw new HostedStateConflictError("conflict", "Participant is absent.");
		if (operation.type === "participant.stand_down" && operation.expectedGeneration !== undefined && current.generation !== operation.expectedGeneration) {
			const latest = current.transitions.at(-1);
			if (current.state === "vacant" && latest?.cause === "stand_down" && latest.previousGeneration === operation.expectedGeneration && latest.previousHolderTargetKey === operation.targetKey) return state;
			throw new HostedStateConflictError("conflict", "Participant generation changed before stand-down.");
		}
		if (current.state !== "held" || current.holderTargetKey !== operation.targetKey) {
			const latest = current.transitions.at(-1);
			if (current.state === nextState && latest?.cause === cause && latest.previousHolderTargetKey === operation.targetKey) return state;
			throw new HostedStateConflictError("conflict", "Only the current participant holder may change its state.");
		}
		if (current.generation === operation.generation || operation.at < current.updatedAt) throw new HostedStateConflictError("conflict", "Participant transition generation or time does not advance.");
		return replaceParticipant(state, transitionParticipant(current, {
			cause,
			generation: operation.generation,
			previousGeneration: current.generation,
			previousHolderTargetKey: current.holderTargetKey,
			at: operation.at,
		}, nextState));
	}

	if (operation.type === "participant.takeover") {
		assertStateId(operation.generation, "Participant generation");
		assertStateTime(operation.at, "Participant takeover time");
		const current = state.participants[operation.participantKey];
		const target = state.targets[operation.targetKey];
		if (!current || current.state !== "held" || !target || target.projectRoot !== current.projectRoot) throw new HostedStateConflictError("conflict", "Participant is not eligible for takeover.");
		if (current.holderTargetKey === operation.targetKey) return state;
		if (current.generation === operation.generation || operation.at < current.updatedAt || hasActiveParticipantClaim(state, current.participantKey)) throw new HostedStateConflictError("conflict", "Participant takeover is blocked by its current generation, time, or active claims.");
		assertTargetHasNoParticipant(state, operation.targetKey, current.participantKey);
		return replaceParticipant(state, transitionParticipant(current, {
			cause: "takeover",
			generation: operation.generation,
			holderTargetKey: operation.targetKey,
			previousGeneration: current.generation,
			previousHolderTargetKey: current.holderTargetKey,
			at: operation.at,
		}, "held", operation.targetKey));
	}

	if (operation.type === "mailbox.send" || operation.type === "task.send") {
		assertStateId(operation.eventId, "Mailbox event ID");
		assertStateTime(operation.at, "Mailbox send time");
		const sender = state.participants[operation.senderParticipantKey];
		const recipient = state.participants[operation.recipientParticipantKey];
		if (!sender || sender.state !== "held" || sender.generation !== operation.expectedSenderGeneration || sender.holderTargetKey !== operation.senderTargetKey) throw new HostedStateConflictError("conflict", "Mailbox sender identity or generation changed before send.");
		if (!recipient || recipient.state === "ended") throw new HostedStateConflictError("conflict", "Mailbox recipient is unavailable.");
		if (sender.participantKey === recipient.participantKey || sender.projectRoot !== recipient.projectRoot || sender.protocol !== recipient.protocol) throw new HostedStateConflictError("conflict", "Mailbox participants must be distinct and share one project and protocol.");
		if (operation.at < sender.updatedAt) throw new HostedStateConflictError("conflict", "Mailbox send time precedes sender state.");
		if (!operation.body.trim() || Buffer.byteLength(operation.body) > HOSTED_MAILBOX_MAX_BODY_BYTES) throw new HostedStateConflictError("conflict", "Mailbox body is empty or exceeds its byte limit.");
		if (!operation.sendId.trim() || Buffer.byteLength(operation.sendId) > MAX_ID_BYTES) throw new HostedStateConflictError("conflict", "Mailbox send ID is invalid.");
		const dedupeKey = mailboxDedupeKey(sender.participantKey, operation.sendId);
		const eventType = operation.type === "task.send" ? "mailbox.task" as const : "mailbox.message" as const;
		const fingerprint = eventType === "mailbox.task" ? taskFingerprint(recipient.participantKey, operation.body) : mailboxFingerprint(recipient.participantKey, operation.body);
		const existingId = state.dedupe[dedupeKey];
		if (existingId) {
			const existing = state.events[existingId];
			if (existing?.type === eventType && existing.payload.senderParticipantKey === sender.participantKey && existing.payload.recipientParticipantKey === recipient.participantKey && existing.payload.sendId === operation.sendId && existing.payload.fingerprint === fingerprint) return state;
			throw new HostedStateConflictError("conflict", "Mailbox send ID was already used with different input.");
		}
		if (state.events[operation.eventId]) throw new HostedStateConflictError("conflict", "Mailbox event ID already exists.");
		const sequence = (sender.outSeq[recipient.participantKey] ?? 0) + 1;
		const event: HostedMailboxMessageEvent | HostedMailboxTaskEvent = {
			version: 1,
			eventId: operation.eventId,
			dedupeKey,
			source: { kind: "participant", id: sender.participantKey, generation: sender.generation, sequence },
			recipientParticipantKey: recipient.participantKey,
			type: eventType,
			createdAt: operation.at,
			summary: `${eventType === "mailbox.task" ? "bounded task" : "message"} from ${sender.participantId} to ${recipient.participantId}`,
			payload: {
				sendId: operation.sendId,
				senderParticipantKey: sender.participantKey,
				recipientParticipantKey: recipient.participantKey,
				body: operation.body,
				fingerprint,
			},
			delivery: { status: "pending" },
		};
		const nextSender = { ...sender, outSeq: { ...sender.outSeq, [recipient.participantKey]: sequence }, updatedAt: operation.at };
		return {
			...state,
			participants: { ...state.participants, [sender.participantKey]: nextSender },
			events: { ...state.events, [event.eventId]: event },
			dedupe: { ...state.dedupe, [dedupeKey]: event.eventId },
		};
	}

	if (operation.type === "task.result") {
		assertStateId(operation.eventId, "Task result event ID");
		assertStateId(operation.inReplyToEventId, "Task reply event ID");
		assertStateTime(operation.at, "Task result time");
		const task = state.events[operation.inReplyToEventId];
		if (!task || task.type !== "mailbox.task") throw new HostedStateConflictError("conflict", "Bounded task does not exist.");
		const sender = state.participants[operation.senderParticipantKey];
		const recipient = state.participants[task.payload.senderParticipantKey];
		if (!sender || sender.state !== "held" || sender.generation !== operation.expectedSenderGeneration || sender.holderTargetKey !== operation.senderTargetKey || sender.participantKey !== task.recipientParticipantKey) throw new HostedStateConflictError("conflict", "Task result sender identity or generation changed.");
		if (!recipient || recipient.state === "ended" || recipient.participantKey !== task.payload.senderParticipantKey || sender.projectRoot !== recipient.projectRoot || sender.protocol !== recipient.protocol) throw new HostedStateConflictError("conflict", "Task result recipient is unavailable.");
		if (!operation.sendId.trim() || Buffer.byteLength(operation.sendId) > MAX_ID_BYTES || !operation.body.trim() || Buffer.byteLength(operation.body) > HOSTED_MAILBOX_MAX_BODY_BYTES || !["completed", "failed", "cancelled"].includes(operation.status) || (operation.sessionAdvance !== "none" && operation.sessionAdvance !== "committed")) throw new HostedStateConflictError("conflict", "Task result payload is invalid.");
		const senderTarget = state.targets[operation.senderTargetKey];
		const targetWorkspace = senderTarget?.workspaceId ? state.workspaces[senderTarget.workspaceId] : undefined;
		if (targetWorkspace ? !operation.workspace || !sameTaskWorkspaceEvidence(operation.workspace, targetWorkspace) : operation.workspace !== undefined) throw new HostedStateConflictError("conflict", "Task workspace evidence does not match the result target.");
		const fingerprint = taskResultFingerprint(recipient.participantKey, operation);
		const dedupeKey = mailboxDedupeKey(sender.participantKey, operation.sendId);
		const existingId = state.dedupe[dedupeKey];
		if (existingId) {
			const existing = state.events[existingId];
			if (existing?.type === "mailbox.task_result" && existing.payload.inReplyToEventId === task.eventId && existing.payload.fingerprint === fingerprint) return state;
			throw new HostedStateConflictError("conflict", "Task result send ID was reused with different input.");
		}
		const prior = Object.values(state.events).find((event): event is HostedMailboxTaskResultEvent => event.type === "mailbox.task_result" && event.payload.inReplyToEventId === task.eventId);
		if (prior) throw new HostedStateConflictError("conflict", "Bounded task already has a result with another reply identity.");
		if (state.events[operation.eventId]) throw new HostedStateConflictError("conflict", "Task result event ID already exists.");
		const sequence = (sender.outSeq[recipient.participantKey] ?? 0) + 1;
		const event: HostedMailboxTaskResultEvent = { version: 1, eventId: operation.eventId, dedupeKey, source: { kind: "participant", id: sender.participantKey, generation: sender.generation, sequence }, recipientParticipantKey: recipient.participantKey, type: "mailbox.task_result", createdAt: operation.at, summary: `${operation.status} task result from ${sender.participantId} to ${recipient.participantId}`, payload: { sendId: operation.sendId, replyId: operation.sendId, senderParticipantKey: sender.participantKey, recipientParticipantKey: recipient.participantKey, body: operation.body, fingerprint, inReplyToEventId: task.eventId, status: operation.status, sessionAdvance: operation.sessionAdvance, ...(operation.workspace ? { workspace: operation.workspace } : {}) }, delivery: { status: "pending" } };
		const nextSender = { ...sender, outSeq: { ...sender.outSeq, [recipient.participantKey]: sequence }, updatedAt: operation.at };
		return { ...state, participants: { ...state.participants, [sender.participantKey]: nextSender }, events: { ...state.events, [event.eventId]: event }, dedupe: { ...state.dedupe, [dedupeKey]: event.eventId } };
	}

	if (operation.type === "inbox.claim") return claimEvents(state, operation.claim);

	if (operation.type === "inbox.ack") {
		const claim = state.claims[operation.claimId];
		if (!claim || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds)) return state;
		if (claim.status === "acked") return state;
		const claimEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (!claimEvents.every((event): event is HostedEvent => event !== undefined && eventClaimTargetMatches(state, event, claim.targetKey) && deliveryBelongsToClaim(event.delivery, claim.claimId))) return state;
		const events = { ...state.events };
		for (const event of claimEvents) {
			if (event.delivery.status !== "acked") events[event.eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
		}
		return pruneAcknowledged({
			...state,
			claims: { ...state.claims, [claim.claimId]: { ...claim, status: "acked", settledAt: operation.at } },
			events,
		}, Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
	}

	if (operation.type === "inbox.submit_begin") {
		const claim = state.claims[operation.claimId];
		const target = state.targets[operation.targetKey];
		if (!claim || claim.status !== "active" || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds) || target?.kind !== "agent" || target.capabilityTier !== "managed") throw new HostedStateConflictError("claim_conflict", "Managed submission claim or target is invalid.");
		const claimedEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (!claimedEvents.every((event): event is HostedEvent => event !== undefined && event.delivery.status === "claimed" && event.delivery.claimId === claim.claimId)) throw new HostedStateConflictError("claim_conflict", "Managed submission events are not held by the exact claim.");
		const events = { ...state.events };
		for (const event of claimedEvents) events[event.eventId] = { ...event, delivery: { status: "submitting", claimId: claim.claimId, attemptId: operation.attemptId, startedAt: operation.at } };
		return { ...state, events };
	}

	if (operation.type === "inbox.submit_settle") {
		const claim = state.claims[operation.claimId];
		if (!claim || claim.status !== "active" || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds)) throw new HostedStateConflictError("claim_conflict", "Managed submission settlement claim is invalid.");
		const submittingEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (!submittingEvents.every((event): event is HostedEvent => event !== undefined && event.delivery.status === "submitting" && event.delivery.claimId === claim.claimId && event.delivery.attemptId === operation.attemptId)) throw new HostedStateConflictError("claim_conflict", "Managed submission settlement does not match its exact attempt.");
		const events = { ...state.events };
		for (const event of submittingEvents) {
			const delivery: HostedEventDelivery = operation.outcome === "submitted" ? { status: "submitted", claimId: claim.claimId, attemptId: operation.attemptId, submittedAt: operation.at } : operation.outcome === "needs_attention" ? { status: "needs_attention", claimId: claim.claimId, attemptId: operation.attemptId, recordedAt: operation.at } : { status: "pending", latestClaimId: claim.claimId };
			events[event.eventId] = { ...event, delivery };
		}
		return { ...state, events, claims: { ...state.claims, [claim.claimId]: { ...claim, status: operation.outcome === "submitted" ? "acked" : "released", settledAt: operation.at } } };
	}

	if (operation.type === "inbox.reconcile_many") {
		if (operation.receipts.length > HOSTED_MAX_DELIVERY_BATCH || new Set(operation.receipts.map((receipt) => receipt.claimId)).size !== operation.receipts.length) throw new HostedStateConflictError("claim_conflict", "Admission reconciliation receipts are invalid.");
		let next = state;
		for (const receipt of operation.receipts) next = reduceHostedState(next, { type: "inbox.reconcile", targetKey: operation.targetKey, claimId: receipt.claimId, eventIds: receipt.eventIds, at: operation.at });
		return next;
	}

	if (operation.type === "inbox.reconcile") {
		const claim = state.claims[operation.claimId];
		if (!claim || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds) || claim.status === "acked") return state;
		const admittedEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (!admittedEvents.every((event): event is HostedEvent => event !== undefined && eventClaimTargetMatches(state, event, claim.targetKey))) return state;
		if (admittedEvents.some((event) => event.delivery.status === "acked" && event.delivery.claimId !== claim.claimId)) return state;
		let next = state;
		const competingClaims = new Set(admittedEvents.flatMap((event) => event?.delivery.status === "claimed" && event.delivery.claimId !== claim.claimId ? [event.delivery.claimId] : []));
		for (const competingClaimId of competingClaims) {
			const competing = next.claims[competingClaimId];
			if (competing?.status === "active") next = releaseClaim(next, competing.targetKey, competing.claimId, competing.eventIds, operation.at);
		}
		const events = { ...next.events };
		for (const event of admittedEvents) events[event.eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
		return pruneAcknowledged({
			...next,
			claims: { ...next.claims, [claim.claimId]: { ...claim, status: "acked", settledAt: operation.at } },
			events,
		}, Math.max(0, operation.at - HOSTED_ACK_RETENTION_MS));
	}

	if (operation.type === "inbox.release") return releaseClaim(state, operation.targetKey, operation.claimId, operation.eventIds, operation.at);

	if (operation.type === "inbox.release_expired") {
		let next = state;
		for (const claim of Object.values(state.claims)) {
			if (claim.status === "active" && claim.leaseUntil <= operation.at) next = releaseClaim(next, claim.targetKey, claim.claimId, claim.eventIds, operation.at);
		}
		return next;
	}

	if (operation.type === "retention.prune") return pruneAcknowledged(state, operation.before);

	if (operation.type === "wake.set") {
		if (!state.targets[operation.wake.targetKey]) return state;
		const existing = state.wakes[operation.wake.targetKey];
		if (existing) {
			if (!sameWake(existing, operation.wake)) throw new HostedStateConflictError("conflict", "Target already has another outstanding wake.");
			return state;
		}
		return { ...state, wakes: { ...state.wakes, [operation.wake.targetKey]: operation.wake } };
	}

	if (operation.type === "wake.accept") {
		const wake = state.wakes[operation.claim.targetKey];
		const existingClaim = state.claims[operation.claim.claimId];
		if (!wake) {
			if (existingClaim && sameClaim(existingClaim, operation.claim)) return state;
			throw new HostedStateConflictError("claim_conflict", "Wake is absent or no longer current.");
		}
		if (wake.wakeId !== operation.wakeId || wake.registrationId !== operation.claim.registrationId) throw new HostedStateConflictError("claim_conflict", "Wake does not match this claim owner.");
		const expected = pendingHostedEvents(state, wake.targetKey).slice(0, HOSTED_MAX_DELIVERY_BATCH).map((event) => event.eventId);
		if (expected.length === 0 || !sameOrderedIds(expected, operation.claim.eventIds)) throw new HostedStateConflictError("claim_conflict", "Wake claim is not the current first delivery batch.");
		const claimed = claimEvents(state, operation.claim);
		const wakes = { ...claimed.wakes };
		delete wakes[wake.targetKey];
		return { ...claimed, wakes };
	}

	if (operation.type === "wake.clear") {
		const wake = state.wakes[operation.targetKey];
		if (!wake || wake.wakeId !== operation.wakeId) return state;
		const wakes = { ...state.wakes };
		delete wakes[operation.targetKey];
		return { ...state, wakes };
	}

	return state;
}

export function pendingHostedEvents(state: HostedRuntimeState, targetKey: string): HostedEvent[] {
	return Object.values(state.events)
		.filter((event) => event.delivery.status === "pending" && hostedEventRoutesToTarget(state, event, targetKey))
		.sort((a, b) => a.createdAt - b.createdAt || a.source.kind.localeCompare(b.source.kind) || a.source.id.localeCompare(b.source.id) || a.source.generation.localeCompare(b.source.generation) || a.source.sequence - b.source.sequence || a.eventId.localeCompare(b.eventId));
}

export function deriveParticipantKey(projectRoot: string, protocol: string, participantId: string): string {
	return `participant_${createHash("sha256").update(projectRoot).update("\0").update(protocol).update("\0").update(participantId).digest("hex")}`;
}

export function deriveBridgeTargetKey(projectRoot: string, bridgeId: string): string {
	return `bridge_${createHash("sha256").update(projectRoot).update("\0").update(bridgeId).digest("hex")}`;
}

export function runtimeStatePaths(root: string) {
	return { instance: join(root, "instance.json"), state: join(root, "state.v1.json") };
}

export function loadOrCreateRuntimeInstance(root: string, createId: () => string = () => `rt_${randomUUID()}`): HostedRuntimeInstance {
	prepareRoot(root);
	const path = runtimeStatePaths(root).instance;
	const existing = readJson(path, INSTANCE_MAX_BYTES);
	if (existing !== undefined) return validateInstance(existing);
	const instance: HostedRuntimeInstance = { version: 1, runtimeId: createId() };
	writeAtomicJson(root, path, instance, INSTANCE_MAX_BYTES);
	return instance;
}

export function readHostedRuntimeState(root: string): HostedRuntimeState {
	prepareRoot(root);
	const path = runtimeStatePaths(root).state;
	const value = readJson(path, HOSTED_STATE_MAX_BYTES);
	if (value === undefined) return emptyHostedRuntimeState();
	if (!value || typeof value !== "object" || Array.isArray(value)) return validateHostedRuntimeState(value);
	// SAFETY: The preceding runtime check excludes null, primitives, and arrays before reading the version discriminator.
	const version = (value as Record<string, unknown>).version;
	if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7) return validateHostedRuntimeState(value);
	const migrated = version === 1 ? migrateHostedRuntimeStateV1(value) : version === 2 ? migrateHostedRuntimeStateV2(value) : version === 3 ? migrateHostedRuntimeStateV3(value) : version === 4 ? migrateHostedRuntimeStateV4(value) : version === 5 ? migrateHostedRuntimeStateV5(value) : version === 6 ? migrateHostedRuntimeStateV6(value) : migrateHostedRuntimeStateV7(value);
	writeAtomicJson(root, path, migrated, HOSTED_STATE_MAX_BYTES);
	return migrated;
}

export function writeHostedRuntimeState(root: string, state: HostedRuntimeState): void {
	prepareRoot(root);
	writeAtomicJson(root, runtimeStatePaths(root).state, validateHostedRuntimeState(state), HOSTED_STATE_MAX_BYTES);
}

export function validateHostedRuntimeState(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state", ["version", "targets", "autoCapacityReservations", "bridgeLaunches", "workspaces", "integrations", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 8) throw new Error("unsupported runtime state version");
		const result: HostedRuntimeState = {
			version: 8,
			targets: mapValues(state.targets, "targets", validateTarget),
			autoCapacityReservations: mapValues(state.autoCapacityReservations, "Auto capacity reservations", validateAutoCapacityReservation),
			bridgeLaunches: mapValues(state.bridgeLaunches, "bridge launches", validateBridgeLaunch),
			workspaces: mapValues(state.workspaces, "workspaces", validateWorkspace),
			integrations: mapValues(state.integrations, "integrations", validateIntegration),
			monitors: mapValues(state.monitors, "monitors", validateMonitor),
			participants: mapValues(state.participants, "participants", validateParticipant),
			events: mapValues(state.events, "events", validateEvent),
			dedupe: mapStrings(state.dedupe, "dedupe"),
			claims: mapValues(state.claims, "claims", validateClaim),
			wakes: mapValues(state.wakes, "wakes", validateWake),
		};
		validateReferences(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state is malformed", error);
	}
}

function migrateHostedRuntimeStateV1(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v1", ["version", "targets", "monitors", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 1) throw new Error("unsupported source runtime state version");
		const result: HostedRuntimeState = {
			version: 8,
			targets: mapValues(state.targets, "targets", validateLegacyPiTarget),
			autoCapacityReservations: {},
			bridgeLaunches: {},
			workspaces: {},
			integrations: {},
			monitors: mapValues(state.monitors, "monitors", validateMonitor),
			participants: {},
			events: mapValues(state.events, "events", validateFilesystemEvent),
			dedupe: mapStrings(state.dedupe, "dedupe"),
			claims: mapValues(state.claims, "claims", validateClaim),
			wakes: mapValues(state.wakes, "wakes", validateWake),
		};
		validateReferences(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state v1 migration failed", error);
	}
}

function migrateHostedRuntimeStateV2(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v2", ["version", "targets", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 2) throw new Error("unsupported source runtime state version");
		const result: HostedRuntimeState = {
			version: 8,
			targets: mapValues(state.targets, "targets", validateLegacyPiTarget),
			autoCapacityReservations: {},
			bridgeLaunches: {},
			workspaces: {},
			integrations: {},
			monitors: mapValues(state.monitors, "monitors", validateMonitor),
			participants: mapValues(state.participants, "participants", validateParticipant),
			events: mapValues(state.events, "events", validateEvent),
			dedupe: mapStrings(state.dedupe, "dedupe"),
			claims: mapValues(state.claims, "claims", validateClaim),
			wakes: mapValues(state.wakes, "wakes", validateWake),
		};
		validateReferences(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state v2 migration failed", error);
	}
}

function migrateHostedRuntimeStateV3(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v3", ["version", "targets", "bridgeLaunches", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 3) throw new Error("unsupported source runtime state version");
		const result: HostedRuntimeState = {
			version: 8,
			targets: mapValues(state.targets, "targets", (item, key) => validateTarget(item, key, true)),
			autoCapacityReservations: {},
			bridgeLaunches: mapValues(state.bridgeLaunches, "bridge launches", (item, key) => validateBridgeLaunch(item, key, true)),
			workspaces: {},
			integrations: {},
			monitors: mapValues(state.monitors, "monitors", validateMonitor),
			participants: mapValues(state.participants, "participants", validateParticipant),
			events: mapValues(state.events, "events", validateEvent),
			dedupe: mapStrings(state.dedupe, "dedupe"),
			claims: mapValues(state.claims, "claims", validateClaim),
			wakes: mapValues(state.wakes, "wakes", validateWake),
		};
		validateReferences(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state v3 migration failed", error);
	}
}

function migrateHostedRuntimeStateV4(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v4", ["version", "targets", "bridgeLaunches", "workspaces", "integrations", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 4) throw new Error("unsupported source runtime state version");
		const result: HostedRuntimeState = {
			version: 8,
			targets: mapValues(state.targets, "targets", (item, key) => validateTarget(item, key, true)),
			autoCapacityReservations: {},
			bridgeLaunches: mapValues(state.bridgeLaunches, "bridge launches", (item, key) => validateBridgeLaunch(item, key, true)),
			workspaces: mapValues(state.workspaces, "workspaces", validateWorkspaceV4),
			integrations: mapValues(state.integrations, "integrations", validateIntegration),
			monitors: mapValues(state.monitors, "monitors", validateMonitor),
			participants: mapValues(state.participants, "participants", validateParticipant),
			events: mapValues(state.events, "events", validateEvent),
			dedupe: mapStrings(state.dedupe, "dedupe"),
			claims: mapValues(state.claims, "claims", validateClaim),
			wakes: mapValues(state.wakes, "wakes", validateWake),
		};
		validateReferences(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state v4 migration failed", error);
	}
}

function migrateHostedRuntimeStateV5(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v5", ["version", "targets", "bridgeLaunches", "workspaces", "integrations", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 5) throw new Error("unsupported source runtime state version");
		return validateHostedRuntimeState({ ...state, version: 8, autoCapacityReservations: {} });
	} catch (error) {
		throw storageError("Runtime state v5 migration failed", error);
	}
}

function migrateHostedRuntimeStateV6(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v6", ["version", "targets", "bridgeLaunches", "workspaces", "integrations", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 6) throw new Error("unsupported source runtime state version");
		return validateHostedRuntimeState({ ...state, version: 8, autoCapacityReservations: {} });
	} catch (error) {
		throw storageError("Runtime state v6 migration failed", error);
	}
}

function migrateHostedRuntimeStateV7(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state v7", ["version", "targets", "autoCapacityReservations", "bridgeLaunches", "workspaces", "integrations", "monitors", "participants", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 7) throw new Error("unsupported source runtime state version");
		return validateHostedRuntimeState({ ...state, version: 8 });
	} catch (error) {
		throw storageError("Runtime state v7 migration failed", error);
	}
}

function claimEvents(state: HostedRuntimeState, claim: HostedClaim): HostedRuntimeState {
	const existing = state.claims[claim.claimId];
	if (existing) {
		if (!sameClaim(existing, claim)) throw new HostedStateConflictError("claim_conflict", "Claim ID does not match its durable receipt.");
		return state;
	}
	if (claim.status !== "active" || claim.eventIds.length < 1 || claim.eventIds.length > HOSTED_MAX_DELIVERY_BATCH) return state;
	if (Object.values(state.claims).some((candidate) => candidate.status === "active" && candidate.targetKey === claim.targetKey)) throw new HostedStateConflictError("claim_conflict", "Target already has an active delivery claim.");
	if (new Set(claim.eventIds).size !== claim.eventIds.length || claim.leaseUntil <= claim.createdAt) return state;
	const claimedEvents = claim.eventIds.map((eventId) => state.events[eventId]);
	if (!claimedEvents.every((event): event is HostedEvent => event !== undefined && hostedEventRoutesToTarget(state, event, claim.targetKey) && event.delivery.status === "pending")) return state;
	const events = { ...state.events };
	for (const event of claimedEvents) events[event.eventId] = { ...event, delivery: { status: "claimed", claimId: claim.claimId } };
	return { ...state, claims: { ...state.claims, [claim.claimId]: claim }, events };
}

function releaseClaim(state: HostedRuntimeState, targetKey: string, claimId: string, eventIds: string[], at: number): HostedRuntimeState {
	const claim = state.claims[claimId];
	if (!claim || claim.targetKey !== targetKey || !sameIds(claim.eventIds, eventIds) || claim.status !== "active") return state;
	const events = { ...state.events };
	for (const eventId of claim.eventIds) {
		const event = events[eventId];
		if (event?.delivery.status === "claimed" && event.delivery.claimId === claimId) events[eventId] = { ...event, delivery: { status: "pending", latestClaimId: claimId } };
		else if (event?.delivery.status === "submitting" && event.delivery.claimId === claimId) events[eventId] = { ...event, delivery: { status: "needs_attention", claimId, attemptId: event.delivery.attemptId, recordedAt: at } };
	}
	return {
		...state,
		claims: { ...state.claims, [claimId]: { ...claim, status: "released", settledAt: at } },
		events,
	};
}

function pruneAcknowledged(state: HostedRuntimeState, before: number): HostedRuntimeState {
	const removable = new Set(Object.values(state.events)
		.filter((event) => event.delivery.status === "acked" && event.delivery.ackedAt < before)
		.map((event) => event.eventId));
	let changed = true;
	while (changed) {
		changed = false;
		for (const claim of Object.values(state.claims)) {
			const count = claim.eventIds.filter((eventId) => removable.has(eventId)).length;
			if (count === 0 || (count === claim.eventIds.length && claim.status !== "active")) continue;
			for (const eventId of claim.eventIds) if (removable.delete(eventId)) changed = true;
		}
		for (const event of Object.values(state.events)) if (event.type === "mailbox.task_result") {
			const resultRemovable = removable.has(event.eventId);
			const taskRemovable = removable.has(event.payload.inReplyToEventId);
			if (resultRemovable !== taskRemovable) {
				if (removable.delete(event.eventId)) changed = true;
				if (removable.delete(event.payload.inReplyToEventId)) changed = true;
			}
		}
	}
	if (removable.size === 0) return state;
	const events = { ...state.events };
	const dedupe = { ...state.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	const claims = { ...state.claims };
	for (const claim of Object.values(state.claims)) if (claim.eventIds.every((eventId) => removable.has(eventId))) delete claims[claim.claimId];
	return { ...state, events, dedupe, claims };
}

function validMonitorEvent(monitor: HostedMonitor, event: HostedFilesystemCreatedEvent): boolean {
	return event.version === 1
		&& event.targetKey === monitor.targetKey
		&& event.source.kind === "monitor"
		&& event.source.id === monitor.monitorId
		&& event.source.generation === monitor.generation
		&& event.delivery.status === "pending";
}

function prepareRoot(root: string): void {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const info = lstatSync(root);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("runtime root is not a real directory");
		chmodSync(root, 0o700);
	} catch (error) {
		throw storageError(`Cannot prepare runtime directory: ${root}`, error);
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- State readers immediately pass this bounded raw JSON to validateState or validateInstance.
function readJson(path: string, maxBytes: number): unknown | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error("state path is not a regular file");
		if (info.size > maxBytes) throw new Error(`state exceeds ${maxBytes} bytes`);
		return JSON.parse(readFileSync(fd, "utf8"));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw storageError(`Cannot read runtime state: ${path}`, error);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeAtomicJson(root: string, path: string, value: unknown, maxBytes: number): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content) > maxBytes) throw new HostedStateStorageError(`Runtime state exceeds ${maxBytes} bytes.`);
	const temporary = join(root, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { fsyncSync(directory); } finally { closeSync(directory); }
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch {}
		throw storageError(`Cannot persist runtime state: ${path}`, error);
	}
}

function validateInstance(value: unknown): HostedRuntimeInstance {
	try {
		const instance = strictObject(value, "runtime instance", ["version", "runtimeId"]);
		if (instance.version !== 1) throw new Error("unsupported runtime instance version");
		return { version: 1, runtimeId: text(instance.runtimeId, "runtime id", MAX_ID_BYTES) };
	} catch (error) {
		throw storageError("Runtime instance is malformed", error);
	}
}

function validateTarget(value: unknown, key: string, legacyBridge = false): HostedTarget {
	const candidate = strictObject(value, "target");
	if (candidate.kind === "pi") {
		const target = strictObject(value, "Pi target", ["kind", "targetKey", "projectRoot", "piSessionId", "piSessionFile", "workspaceId", "workspaceRoot", "createdAt"]);
		if ((target.workspaceId === undefined) !== (target.workspaceRoot === undefined)) throw new Error("Pi target workspace identity is incomplete");
		const result: HostedTarget = { kind: "pi", targetKey: text(target.targetKey, "target key", MAX_ID_BYTES), projectRoot: text(target.projectRoot, "project root", MAX_PATH_BYTES), piSessionId: text(target.piSessionId, "Pi session id", MAX_ID_BYTES), piSessionFile: text(target.piSessionFile, "Pi session file", MAX_PATH_BYTES), ...(target.workspaceId === undefined ? {} : { workspaceId: text(target.workspaceId, "workspace ID", MAX_ID_BYTES), workspaceRoot: text(target.workspaceRoot, "workspace root", MAX_PATH_BYTES) }), createdAt: nonNegativeNumber(target.createdAt, "target creation time") };
		if (result.targetKey !== key) throw new Error("target key does not match map key");
		return result;
	}
	if (candidate.kind === "bridge" || candidate.kind === "agent") {
		const target = strictObject(value, `${candidate.kind} target`, ["kind", "targetKey", "projectRoot", "bridgeId", "driver", "agentSession", "capabilityTier", "participantKey", "holderGeneration", "profile", "configurationHash", "clientGeneration", "reconnectDigest", "herdr", "workspaceId", "workspaceRoot", "metadata", "createdAt"]);
		const interactive = candidate.kind === "agent";
		if ((target.profile !== "read-only" && target.profile !== "workspace-write") || (target.workspaceId === undefined) !== (target.workspaceRoot === undefined) || (legacyBridge ? target.profile !== "read-only" || target.workspaceId !== undefined : (target.profile === "workspace-write") !== (target.workspaceId !== undefined)) || (interactive ? target.driver === undefined || target.agentSession === undefined || target.capabilityTier === undefined : target.driver !== undefined || target.agentSession !== undefined || target.capabilityTier !== undefined)) throw new Error("invalid external target profile, workspace, or interactive-agent authority");
		const shared = {
			targetKey: text(target.targetKey, "target key", MAX_ID_BYTES), projectRoot: text(target.projectRoot, "project root", MAX_PATH_BYTES), bridgeId: text(target.bridgeId, "launch ID", MAX_ID_BYTES), participantKey: text(target.participantKey, "participant key", MAX_ID_BYTES), holderGeneration: text(target.holderGeneration, "holder generation", MAX_ID_BYTES), profile: target.profile === "read-only" ? "read-only" as const : "workspace-write" as const, configurationHash: hash(target.configurationHash, "configuration hash"), clientGeneration: text(target.clientGeneration, "client generation", MAX_ID_BYTES), reconnectDigest: hash(target.reconnectDigest, "reconnect digest"), herdr: validateBridgeHerdr(target.herdr), ...(target.workspaceId === undefined ? {} : { workspaceId: text(target.workspaceId, "workspace ID", MAX_ID_BYTES), workspaceRoot: text(target.workspaceRoot, "workspace root", MAX_PATH_BYTES) }), metadata: legacyBridge ? migrateBridgeMetadata(target.metadata) : validateBridgeMetadata(target.metadata), createdAt: nonNegativeNumber(target.createdAt, "target creation time"),
		};
		const result: HostedExternalTarget = interactive ? { kind: "agent", ...shared, driver: nativeDriver(target.driver), agentSession: validateAgentSession(target.agentSession), capabilityTier: managedTier(target.capabilityTier) } : { kind: "bridge", ...shared };
		if (result.targetKey !== key) throw new Error("target key does not match map key");
		return result;
	}
	throw new Error("invalid target kind");
}

function validateLegacyPiTarget(value: unknown, key: string): HostedTarget {
	const target = strictObject(value, "legacy Pi target", ["targetKey", "projectRoot", "piSessionId", "piSessionFile", "createdAt"]);
	return validateTarget({ kind: "pi", ...target }, key);
}

function validateBridgeLaunch(value: unknown, key: string, legacyBridge = false): HostedBridgeLaunch {
	const launch = strictObject(value, "bridge launch", ["version", "launchId", "requestId", "launchDigest", "reconnectDigest", "callerParticipantKey", "callerGeneration", "callerTargetKey", "participantKey", "protocol", "participantId", "expectedParticipantGeneration", "holderGeneration", "targetKey", "projectRoot", "profile", "configurationHash", "driver", "herdr", "workspaceId", "workspaceRoot", "metadata", "createdAt", "expiresAt", "status", "consumedAt", "clientGeneration"]);
	const status = enumValue(launch.status, ["pending", "consumed", "cancelled", "expired"], "invalid bridge launch status");
	if (launch.version !== 1 || (launch.profile !== "read-only" && launch.profile !== "workspace-write") || (launch.workspaceId === undefined) !== (launch.workspaceRoot === undefined) || (legacyBridge ? launch.profile !== "read-only" || launch.workspaceId !== undefined : (launch.profile === "workspace-write") !== (launch.workspaceId !== undefined))) throw new Error("invalid bridge launch version, status, profile, or workspace authority");
	const result: HostedBridgeLaunch = {
		version: 1,
		launchId: text(launch.launchId, "bridge launch ID", MAX_ID_BYTES),
		requestId: text(launch.requestId, "bridge request ID", MAX_ID_BYTES),
		launchDigest: hash(launch.launchDigest, "bridge launch digest"),
		reconnectDigest: hash(launch.reconnectDigest, "bridge reconnect digest"),
		callerParticipantKey: text(launch.callerParticipantKey, "bridge caller participant key", MAX_ID_BYTES),
		callerGeneration: text(launch.callerGeneration, "bridge caller generation", MAX_ID_BYTES),
		callerTargetKey: text(launch.callerTargetKey, "bridge caller target key", MAX_ID_BYTES),
		participantKey: text(launch.participantKey, "bridge participant key", MAX_ID_BYTES),
		protocol: participantName(launch.protocol, "bridge protocol"),
		participantId: participantName(launch.participantId, "bridge participant ID"),
		...(launch.expectedParticipantGeneration === undefined ? {} : { expectedParticipantGeneration: text(launch.expectedParticipantGeneration, "expected bridge participant generation", MAX_ID_BYTES) }),
		holderGeneration: text(launch.holderGeneration, "bridge holder generation", MAX_ID_BYTES),
		targetKey: text(launch.targetKey, "bridge target key", MAX_ID_BYTES),
		projectRoot: text(launch.projectRoot, "bridge project root", MAX_PATH_BYTES),
		profile: launch.profile,
		configurationHash: hash(launch.configurationHash, "bridge configuration hash"),
		...(launch.driver === undefined ? {} : { driver: nativeDriver(launch.driver) }),
		herdr: validateBridgeHerdr(launch.herdr),
		...(launch.workspaceId === undefined ? {} : { workspaceId: text(launch.workspaceId, "bridge workspace ID", MAX_ID_BYTES), workspaceRoot: text(launch.workspaceRoot, "bridge workspace root", MAX_PATH_BYTES) }),
		metadata: legacyBridge ? migrateBridgeMetadata(launch.metadata) : validateBridgeMetadata(launch.metadata),
		createdAt: nonNegativeNumber(launch.createdAt, "bridge launch creation time"),
		expiresAt: nonNegativeNumber(launch.expiresAt, "bridge launch expiry"),
		status,
		...(launch.consumedAt === undefined ? {} : { consumedAt: nonNegativeNumber(launch.consumedAt, "bridge consumption time") }),
		...(launch.clientGeneration === undefined ? {} : { clientGeneration: text(launch.clientGeneration, "bridge client generation", MAX_ID_BYTES) }),
	};
	if (result.launchId !== key || result.expiresAt <= result.createdAt || result.participantKey !== deriveParticipantKey(result.projectRoot, result.protocol, result.participantId)) throw new Error("bridge launch identity or time is invalid");
	if (result.status === "consumed" ? result.consumedAt === undefined || result.clientGeneration === undefined : result.consumedAt !== undefined || result.clientGeneration !== undefined) throw new Error("bridge launch settlement is inconsistent");
	return result;
}

function validateWorkspace(value: unknown, key: string): HostedWorkspace { return validateWorkspaceRecord(value, key, false); }
function validateWorkspaceV4(value: unknown, key: string): HostedWorkspace { return validateWorkspaceRecord(value, key, true); }
function validateWorkspaceRecord(value: unknown, key: string, legacyPi: boolean): HostedWorkspace {
	const item = strictObject(value, "workspace", ["version", "workspaceId", "requestId", "projectRoot", "gitCommonDir", "worktreePath", "branchRef", "participantKey", "protocol", "participantId", "expectedParticipantGeneration", "holderGeneration", "targetKey", "ownerKind", "piSessionId", "bridgeId", "profile", "launchDigest", "callerParticipantKey", "callerGeneration", "callerTargetKey", "baseCommit", "headCommit", "herdr", "state", "taskStatus", "commits", "changedFiles", "additions", "deletions", "integratedHead", "createdAt", "expiresAt", "updatedAt"]);
	const ownerKind = legacyPi ? "pi" : item.ownerKind;
	const state = enumValue(item.state, ["provisioning", "ready", "bound", "active", "ready_handoff", "partial", "retained", "needs_attention", "integrated", "cleaned"], "invalid workspace state");
	if (item.version !== 1 || item.profile !== "workspace-write" || (ownerKind !== "pi" && ownerKind !== "bridge")) throw new Error("invalid workspace version, owner, profile, or state");
	if (ownerKind === "pi" ? typeof item.piSessionId !== "string" || typeof item.launchDigest !== "string" || item.bridgeId !== undefined : typeof item.bridgeId !== "string" || item.piSessionId !== undefined || item.launchDigest !== undefined) throw new Error("workspace owner authority is inconsistent");
	const taskStatus = item.taskStatus === undefined ? undefined : enumValue(item.taskStatus, ["completed", "failed", "cancelled"], "invalid workspace task status");
	const protocol = participantName(item.protocol, "workspace protocol");
	const participantId = participantName(item.participantId, "workspace participant ID");
	const projectRoot = text(item.projectRoot, "workspace project root", MAX_PATH_BYTES);
	const commits = item.commits === undefined ? undefined : stringArray(item.commits, "workspace commits", 1_000).map((value) => gitOid(value, "workspace commit"));
	const common = {
		version: 1 as const,
		workspaceId: text(item.workspaceId, "workspace ID", MAX_ID_BYTES),
		requestId: text(item.requestId, "workspace request ID", MAX_ID_BYTES),
		projectRoot,
		gitCommonDir: text(item.gitCommonDir, "workspace Git common directory", MAX_PATH_BYTES),
		worktreePath: text(item.worktreePath, "workspace path", MAX_PATH_BYTES),
		branchRef: text(item.branchRef, "workspace branch", MAX_PATH_BYTES),
		participantKey: text(item.participantKey, "workspace participant key", MAX_ID_BYTES),
		protocol,
		participantId,
		...(item.expectedParticipantGeneration === undefined ? {} : { expectedParticipantGeneration: text(item.expectedParticipantGeneration, "expected participant generation", MAX_ID_BYTES) }),
		holderGeneration: text(item.holderGeneration, "workspace holder generation", MAX_ID_BYTES),
		targetKey: text(item.targetKey, "workspace target key", MAX_ID_BYTES),
		profile: "workspace-write" as const,
		callerParticipantKey: text(item.callerParticipantKey, "workspace caller participant key", MAX_ID_BYTES),
		callerGeneration: text(item.callerGeneration, "workspace caller generation", MAX_ID_BYTES),
		callerTargetKey: text(item.callerTargetKey, "workspace caller target key", MAX_ID_BYTES),
		baseCommit: gitOid(item.baseCommit, "workspace base commit"),
		headCommit: gitOid(item.headCommit, "workspace head commit"),
		...(item.herdr === undefined ? {} : { herdr: validateBridgeHerdr(item.herdr) }),
		state,
		...(taskStatus === undefined ? {} : { taskStatus }),
		...(commits ? { commits } : {}),
		...(item.changedFiles === undefined ? {} : { changedFiles: integer(item.changedFiles, "workspace changed files") }),
		...(item.additions === undefined ? {} : { additions: integer(item.additions, "workspace additions") }),
		...(item.deletions === undefined ? {} : { deletions: integer(item.deletions, "workspace deletions") }),
		...(item.integratedHead === undefined ? {} : { integratedHead: gitOid(item.integratedHead, "workspace integrated head") }),
		createdAt: nonNegativeNumber(item.createdAt, "workspace creation time"),
		expiresAt: nonNegativeNumber(item.expiresAt, "workspace launch expiry"),
		updatedAt: nonNegativeNumber(item.updatedAt, "workspace update time"),
	};
	const result: HostedWorkspace = ownerKind === "pi" ? { ...common, ownerKind: "pi", piSessionId: text(item.piSessionId, "workspace Pi session ID", MAX_ID_BYTES), launchDigest: hash(item.launchDigest, "workspace launch digest") } : { ...common, ownerKind: "bridge", bridgeId: text(item.bridgeId, "workspace bridge ID", MAX_ID_BYTES) };
	if (result.workspaceId !== key || result.participantKey !== deriveParticipantKey(projectRoot, protocol, participantId) || !WORKSPACE_BRANCH.test(result.branchRef) || result.expiresAt <= result.createdAt || result.updatedAt < result.createdAt) throw new Error("workspace identity, branch, or time is invalid");
	if (["bound", "active", "ready_handoff", "partial", "retained", "integrated"].includes(result.state) && !result.herdr || ["provisioning", "ready"].includes(result.state) && result.herdr) throw new Error("workspace Herdr binding is inconsistent");
	if (result.commits && result.commits.length > 0 && (!result.changedFiles || result.headCommit === result.baseCommit)) throw new Error("workspace handoff fields are inconsistent");
	return result;
}

function validateIntegration(value: unknown, key: string): HostedIntegration {
	const item = strictObject(value, "integration", ["version", "integrationId", "workspaceId", "projectRoot", "gitCommonDir", "worktreePath", "branchRef", "mainBranchRef", "mainHead", "sourceHead", "sourceCommits", "state", "preparedHead", "conflictPaths", "createdAt", "updatedAt", "finalizedAt"]);
	const state = enumValue(item.state, ["preparing", "prepared", "conflicted", "needs_attention", "finalized", "cleaned"], "invalid integration state");
	if (item.version !== 1) throw new Error("invalid integration version or state");
	const sourceCommits = stringArray(item.sourceCommits, "integration source commits", 1_000).map((value) => gitOid(value, "integration source commit"));
	if (sourceCommits.length < 1) throw new Error("integration requires source commits");
	const result: HostedIntegration = {
		version: 1,
		integrationId: text(item.integrationId, "integration ID", MAX_ID_BYTES),
		workspaceId: text(item.workspaceId, "integration workspace ID", MAX_ID_BYTES),
		projectRoot: text(item.projectRoot, "integration project root", MAX_PATH_BYTES),
		gitCommonDir: text(item.gitCommonDir, "integration Git common directory", MAX_PATH_BYTES),
		worktreePath: text(item.worktreePath, "integration worktree path", MAX_PATH_BYTES),
		branchRef: text(item.branchRef, "integration branch", MAX_PATH_BYTES),
		mainBranchRef: text(item.mainBranchRef, "main branch", MAX_PATH_BYTES),
		mainHead: gitOid(item.mainHead, "integration main head"),
		sourceHead: gitOid(item.sourceHead, "integration source head"),
		sourceCommits,
		state,
		...(item.preparedHead === undefined ? {} : { preparedHead: gitOid(item.preparedHead, "prepared integration head") }),
		...(item.conflictPaths === undefined ? {} : { conflictPaths: stringArray(item.conflictPaths, "integration conflict paths", 10_000) }),
		createdAt: nonNegativeNumber(item.createdAt, "integration creation time"),
		updatedAt: nonNegativeNumber(item.updatedAt, "integration update time"),
		...(item.finalizedAt === undefined ? {} : { finalizedAt: nonNegativeNumber(item.finalizedAt, "integration finalized time") }),
	};
	const requiresPreparedHead = result.state === "prepared" || result.state === "conflicted" || result.state === "finalized" || result.state === "cleaned";
	const finalizedTimeInvalid = result.state === "finalized" ? !result.finalizedAt : result.state !== "cleaned" && result.finalizedAt !== undefined;
	if (result.integrationId !== key || !INTEGRATION_BRANCH.test(result.branchRef) || result.updatedAt < result.createdAt || requiresPreparedHead !== Boolean(result.preparedHead) || finalizedTimeInvalid) throw new Error("integration identity, branch, state, or time is inconsistent");
	return result;
}

function validateBridgeHerdr(value: unknown): HostedBridgeLaunch["herdr"] {
	const herdr = strictObject(value, "bridge Herdr identity", ["paneId", "terminalId", "tabId", "workspaceId"]);
	return { paneId: text(herdr.paneId, "Herdr pane ID", MAX_ID_BYTES), terminalId: text(herdr.terminalId, "Herdr terminal ID", MAX_ID_BYTES), tabId: text(herdr.tabId, "Herdr tab ID", MAX_ID_BYTES), workspaceId: text(herdr.workspaceId, "Herdr workspace ID", MAX_ID_BYTES) };
}

function nativeDriver(value: unknown): "claude-code" | "codex" {
	if (value !== "claude-code" && value !== "codex") throw new Error("interactive bridge driver is invalid");
	return value;
}

function managedTier(value: unknown): "managed" {
	if (value !== "managed") throw new Error("interactive bridge capability tier is invalid");
	return value;
}

function validateAgentSession(value: unknown): HostedAgentSessionIdentity {
	const session = strictObject(value, "interactive agent session", ["source", "agent", "kind", "value"]);
	if (session.kind !== "id" && session.kind !== "path") throw new Error("interactive agent session kind is invalid");
	return { source: text(session.source, "agent session source", MAX_ID_BYTES), agent: text(session.agent, "agent session kind", 64), kind: session.kind, value: text(session.value, "agent session value", MAX_PATH_BYTES) };
}

function migrateBridgeMetadata(value: unknown): Record<string, string> {
	const metadata = strictObject(value, "legacy bridge metadata");
	if (Object.keys(metadata).length > HOSTED_BRIDGE_MAX_METADATA_ENTRIES) throw new Error("bridge metadata exceeds its entry limit");
	const parsed = Object.fromEntries(Object.entries(metadata).map(([key, item]) => {
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || FORBIDDEN_BRIDGE_METADATA.has(key)) throw new Error("legacy bridge metadata key is invalid or reserved");
		return [key, stringValue(item, "bridge metadata value", HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES)];
	}));
	return parsed.adapter ? { adapter: parsed.adapter } : parsed.format ? { adapter: parsed.format } : {};
}

function validateBridgeMetadata(value: unknown): Record<string, string> {
	const metadata = strictObject(value, "bridge metadata");
	if (Object.keys(metadata).length > HOSTED_BRIDGE_MAX_METADATA_ENTRIES) throw new Error("bridge metadata exceeds its entry limit");
	return Object.fromEntries(Object.entries(metadata).map(([key, item]) => {
		if (key !== "adapter") throw new Error("bridge metadata key is not allowlisted");
		return [key, stringValue(item, "bridge metadata value", HOSTED_BRIDGE_MAX_METADATA_VALUE_BYTES)];
	}));
}

function validateMonitor(value: unknown, key: string): HostedMonitor {
	const monitor = strictObject(value, "monitor", ["monitorId", "targetKey", "generation", "directory", "settleMs", "status", "sequence", "entries", "createdAt", "updatedAt"]);
	const status = monitor.status;
	if (status !== "watching" && status !== "degraded") throw new Error("invalid monitor status");
	const result: HostedMonitor = {
		monitorId: text(monitor.monitorId, "monitor id", MAX_ID_BYTES),
		targetKey: text(monitor.targetKey, "target key", MAX_ID_BYTES),
		generation: text(monitor.generation, "monitor generation", MAX_ID_BYTES),
		directory: text(monitor.directory, "monitor directory", MAX_PATH_BYTES),
		settleMs: integer(monitor.settleMs, "settle milliseconds"),
		status,
		sequence: integer(monitor.sequence, "monitor sequence"),
		entries: mapValues(monitor.entries, "monitor entries", validateObservation, HOSTED_MONITOR_MAX_ENTRIES),
		createdAt: nonNegativeNumber(monitor.createdAt, "monitor creation time"),
		updatedAt: nonNegativeNumber(monitor.updatedAt, "monitor update time"),
	};
	if (result.monitorId !== key) throw new Error("monitor id does not match map key");
	return result;
}

function validateObservation(value: unknown, key: string): HostedFileObservation {
	const entry = strictObject(value, "file observation", ["relativePath", "size", "mtimeMs", "stableSince", "present", "emitted"]);
	const result: HostedFileObservation = {
		relativePath: text(entry.relativePath, "relative path", MAX_PATH_BYTES),
		size: integer(entry.size, "file size"),
		mtimeMs: nonNegativeNumber(entry.mtimeMs, "file modification time"),
		stableSince: nonNegativeNumber(entry.stableSince, "stable since"),
		present: boolean(entry.present, "present"),
		emitted: boolean(entry.emitted, "emitted"),
	};
	if (result.relativePath !== key) throw new Error("relative path does not match map key");
	return result;
}

function validateParticipant(value: unknown, key: string): HostedParticipant {
	const participant = strictObject(value, "participant", ["participantKey", "projectRoot", "protocol", "participantId", "state", "generation", "holderTargetKey", "outSeq", "transitions", "createdAt", "updatedAt"]);
	if (participant.state !== "held" && participant.state !== "vacant" && participant.state !== "ended") throw new Error("invalid participant state");
	const protocol = participantName(participant.protocol, "participant protocol");
	const participantId = participantName(participant.participantId, "participant ID");
	const projectRoot = text(participant.projectRoot, "participant project root", MAX_PATH_BYTES);
	const outSeqRecord = strictObject(participant.outSeq, "participant output sequences");
	if (Object.keys(outSeqRecord).length > MAX_STATE_RECORDS) throw new Error("participant output sequences exceed their limit");
	const outSeq = Object.fromEntries(Object.entries(outSeqRecord).map(([recipient, sequence]) => [text(recipient, "recipient participant key", MAX_ID_BYTES), integer(sequence, "participant output sequence")]));
	if (!Array.isArray(participant.transitions) || participant.transitions.length < 1 || participant.transitions.length > HOSTED_PARTICIPANT_TRANSITION_LIMIT) throw new Error("participant transition history is invalid");
	const transitions = participant.transitions.map(validateParticipantTransition);
	const result: HostedParticipant = {
		participantKey: text(participant.participantKey, "participant key", MAX_ID_BYTES),
		projectRoot,
		protocol,
		participantId,
		state: participant.state,
		generation: text(participant.generation, "participant generation", MAX_ID_BYTES),
		...(participant.holderTargetKey === undefined ? {} : { holderTargetKey: text(participant.holderTargetKey, "participant holder target key", MAX_ID_BYTES) }),
		outSeq,
		transitions,
		createdAt: nonNegativeNumber(participant.createdAt, "participant creation time"),
		updatedAt: nonNegativeNumber(participant.updatedAt, "participant update time"),
	};
	if (result.participantKey !== key || result.participantKey !== deriveParticipantKey(projectRoot, protocol, participantId)) throw new Error("participant key does not match its identity");
	const latest = result.transitions.at(-1)!;
	if ((result.state === "held") !== Boolean(result.holderTargetKey) || latest.generation !== result.generation || result.updatedAt < latest.at || latest.at < result.createdAt) throw new Error("participant state, holder, generation, or time is inconsistent");
	if (result.state === "held" ? latest.holderTargetKey !== result.holderTargetKey : latest.holderTargetKey !== undefined) throw new Error("participant transition holder is inconsistent");
	if (result.state === "vacant" ? latest.cause !== "stand_down" : result.state === "ended" ? latest.cause !== "release" : latest.cause === "stand_down" || latest.cause === "release") throw new Error("participant transition cause is inconsistent with state");
	for (let index = 0; index < result.transitions.length; index++) {
		const transition = result.transitions[index]!;
		if (index > 0) {
			const previous = result.transitions[index - 1]!;
			if (transition.at < previous.at || transition.previousGeneration !== previous.generation) throw new Error("participant transition order is invalid");
		}
	}
	if (new Set(result.transitions.map((transition) => transition.generation)).size !== result.transitions.length || Object.values(result.outSeq).some((sequence) => sequence < 1)) throw new Error("participant generations or output sequences are invalid");
	return result;
}

function validateParticipantTransition(value: unknown): HostedParticipantTransition {
	const transition = strictObject(value, "participant transition", ["cause", "generation", "holderTargetKey", "previousGeneration", "previousHolderTargetKey", "at"]);
	if (transition.cause !== "acquire" && transition.cause !== "reacquire" && transition.cause !== "stand_down" && transition.cause !== "release" && transition.cause !== "takeover" && transition.cause !== "revive") throw new Error("invalid participant transition cause");
	return {
		cause: transition.cause,
		generation: text(transition.generation, "transition generation", MAX_ID_BYTES),
		...(transition.holderTargetKey === undefined ? {} : { holderTargetKey: text(transition.holderTargetKey, "transition holder target key", MAX_ID_BYTES) }),
		...(transition.previousGeneration === undefined ? {} : { previousGeneration: text(transition.previousGeneration, "previous transition generation", MAX_ID_BYTES) }),
		...(transition.previousHolderTargetKey === undefined ? {} : { previousHolderTargetKey: text(transition.previousHolderTargetKey, "previous holder target key", MAX_ID_BYTES) }),
		at: nonNegativeNumber(transition.at, "participant transition time"),
	};
}

function validateEvent(value: unknown, key: string): HostedEvent {
	const candidate = strictObject(value, "hosted event");
	if (candidate.type === "filesystem.created") return validateFilesystemEvent(value, key);
	if (candidate.type === "mailbox.message" || candidate.type === "mailbox.task") return validateMailboxEvent(value, key);
	if (candidate.type === "mailbox.task_result") return validateTaskResultEvent(value, key);
	throw new Error("invalid hosted event type");
}

function validateFilesystemEvent(value: unknown, key: string): HostedFilesystemCreatedEvent {
	const event = strictObject(value, "hosted filesystem event", ["version", "eventId", "dedupeKey", "source", "targetKey", "type", "createdAt", "summary", "payload", "delivery"]);
	if (event.version !== 1 || event.type !== "filesystem.created") throw new Error("invalid hosted filesystem event version or type");
	const source = strictObject(event.source, "event source", ["kind", "id", "generation", "sequence"]);
	if (source.kind !== "monitor") throw new Error("invalid event source kind");
	const payload = strictObject(event.payload, "event payload", ["relativePath", "path", "fileType", "size", "mtimeMs"]);
	if (payload.fileType !== "regular") throw new Error("invalid event file type");
	const result: HostedFilesystemCreatedEvent = {
		version: 1,
		eventId: text(event.eventId, "event id", MAX_ID_BYTES),
		dedupeKey: text(event.dedupeKey, "event dedupe key", MAX_PATH_BYTES),
		source: {
			kind: "monitor",
			id: text(source.id, "source id", MAX_ID_BYTES),
			generation: text(source.generation, "source generation", MAX_ID_BYTES),
			sequence: integer(source.sequence, "source sequence"),
		},
		targetKey: text(event.targetKey, "target key", MAX_ID_BYTES),
		type: "filesystem.created",
		createdAt: nonNegativeNumber(event.createdAt, "event creation time"),
		summary: stringValue(event.summary, "event summary", MAX_SUMMARY_BYTES),
		payload: {
			relativePath: text(payload.relativePath, "payload relative path", MAX_PATH_BYTES),
			path: text(payload.path, "payload path", MAX_PATH_BYTES),
			fileType: "regular",
			size: integer(payload.size, "payload size"),
			mtimeMs: nonNegativeNumber(payload.mtimeMs, "payload modification time"),
		},
		delivery: validateDelivery(event.delivery),
	};
	if (result.eventId !== key) throw new Error("event id does not match map key");
	return result;
}

function validateMailboxEvent(value: unknown, key: string): HostedMailboxMessageEvent | HostedMailboxTaskEvent {
	const event = strictObject(value, "hosted mailbox event", ["version", "eventId", "dedupeKey", "source", "recipientParticipantKey", "type", "createdAt", "summary", "payload", "delivery"]);
	if (event.version !== 1 || (event.type !== "mailbox.message" && event.type !== "mailbox.task")) throw new Error("invalid hosted mailbox event version or type");
	const source = strictObject(event.source, "mailbox source", ["kind", "id", "generation", "sequence"]);
	if (source.kind !== "participant") throw new Error("invalid mailbox source kind");
	const payload = strictObject(event.payload, "mailbox payload", ["sendId", "senderParticipantKey", "recipientParticipantKey", "body", "fingerprint"]);
	const body = text(payload.body, "mailbox body", HOSTED_MAILBOX_MAX_BODY_BYTES);
	const recipientParticipantKey = text(event.recipientParticipantKey, "recipient participant key", MAX_ID_BYTES);
	const eventType = event.type;
	const result: HostedMailboxMessageEvent | HostedMailboxTaskEvent = {
		version: 1,
		eventId: text(event.eventId, "event id", MAX_ID_BYTES),
		dedupeKey: text(event.dedupeKey, "event dedupe key", MAX_PATH_BYTES),
		source: {
			kind: "participant",
			id: text(source.id, "source participant key", MAX_ID_BYTES),
			generation: text(source.generation, "source generation", MAX_ID_BYTES),
			sequence: integer(source.sequence, "source sequence"),
		},
		recipientParticipantKey,
		type: eventType,
		createdAt: nonNegativeNumber(event.createdAt, "event creation time"),
		summary: stringValue(event.summary, "event summary", MAX_SUMMARY_BYTES),
		payload: {
			sendId: text(payload.sendId, "mailbox send id", MAX_ID_BYTES),
			senderParticipantKey: text(payload.senderParticipantKey, "sender participant key", MAX_ID_BYTES),
			recipientParticipantKey: text(payload.recipientParticipantKey, "recipient participant key", MAX_ID_BYTES),
			body,
			fingerprint: text(payload.fingerprint, "mailbox fingerprint", MAX_ID_BYTES),
		},
		delivery: validateDelivery(event.delivery),
	};
	if (result.eventId !== key || result.source.id !== result.payload.senderParticipantKey || recipientParticipantKey !== result.payload.recipientParticipantKey) throw new Error("mailbox event identity is inconsistent");
	const expectedFingerprint = eventType === "mailbox.task" ? taskFingerprint(recipientParticipantKey, body) : mailboxFingerprint(recipientParticipantKey, body);
	if (result.dedupeKey !== mailboxDedupeKey(result.source.id, result.payload.sendId) || result.payload.fingerprint !== expectedFingerprint) throw new Error("mailbox event dedupe or fingerprint is invalid");
	return result;
}

function validateTaskResultEvent(value: unknown, key: string): HostedMailboxTaskResultEvent {
	const event = strictObject(value, "hosted task result event", ["version", "eventId", "dedupeKey", "source", "recipientParticipantKey", "type", "createdAt", "summary", "payload", "delivery"]);
	if (event.version !== 1 || event.type !== "mailbox.task_result") throw new Error("invalid hosted task result version or type");
	const source = strictObject(event.source, "task result source", ["kind", "id", "generation", "sequence"]);
	if (source.kind !== "participant") throw new Error("invalid task result source kind");
	const payload = strictObject(event.payload, "task result payload", ["sendId", "replyId", "senderParticipantKey", "recipientParticipantKey", "body", "fingerprint", "inReplyToEventId", "status", "sessionAdvance", "workspace"]);
	const status = enumValue(payload.status, ["completed", "failed", "cancelled"], "invalid task result status");
	const sessionAdvance = enumValue(payload.sessionAdvance, ["none", "committed"], "invalid task result session advancement");
	const body = text(payload.body, "task result body", HOSTED_MAILBOX_MAX_BODY_BYTES);
	const recipientParticipantKey = text(event.recipientParticipantKey, "task result recipient key", MAX_ID_BYTES);
	const workspace = payload.workspace === undefined ? undefined : validateTaskWorkspaceEvidence(payload.workspace);
	const operation: Extract<HostedStateOperation, { type: "task.result" }> = { type: "task.result",  senderParticipantKey: text(payload.senderParticipantKey, "task result sender key", MAX_ID_BYTES), expectedSenderGeneration: text(source.generation, "task result source generation", MAX_ID_BYTES), senderTargetKey: "validation", sendId: text(payload.sendId, "task result send ID", MAX_ID_BYTES), eventId: text(event.eventId, "task result event ID", MAX_ID_BYTES), inReplyToEventId: text(payload.inReplyToEventId, "task result reply event ID", MAX_ID_BYTES), status, body, sessionAdvance, ...(workspace ? { workspace } : {}), at: nonNegativeNumber(event.createdAt, "task result creation time") };
	const result: HostedMailboxTaskResultEvent = { version: 1, eventId: operation.eventId, dedupeKey: text(event.dedupeKey, "task result dedupe key", MAX_PATH_BYTES), source: { kind: "participant", id: operation.senderParticipantKey, generation: operation.expectedSenderGeneration, sequence: integer(source.sequence, "task result source sequence") }, recipientParticipantKey, type: "mailbox.task_result", createdAt: operation.at, summary: stringValue(event.summary, "task result summary", MAX_SUMMARY_BYTES), payload: { sendId: operation.sendId, replyId: text(payload.replyId, "task result reply ID", MAX_ID_BYTES), senderParticipantKey: operation.senderParticipantKey, recipientParticipantKey: text(payload.recipientParticipantKey, "task result payload recipient", MAX_ID_BYTES), body, fingerprint: text(payload.fingerprint, "task result fingerprint", MAX_ID_BYTES), inReplyToEventId: operation.inReplyToEventId, status: operation.status, sessionAdvance: operation.sessionAdvance, ...(workspace ? { workspace } : {}) }, delivery: validateDelivery(event.delivery) };
	if (result.eventId !== key || result.source.id !== result.payload.senderParticipantKey || result.recipientParticipantKey !== result.payload.recipientParticipantKey || result.payload.replyId !== result.payload.sendId || result.dedupeKey !== mailboxDedupeKey(result.source.id, result.payload.sendId) || result.payload.fingerprint !== taskResultFingerprint(recipientParticipantKey, operation)) throw new Error("task result identity, dedupe, or fingerprint is invalid");
	return result;
}

function validateTaskWorkspaceEvidence(value: unknown): HostedTaskWorkspaceEvidence {
	const item = strictObject(value, "task workspace evidence", ["workspaceId", "baseCommit", "headCommit", "branchRef", "state", "dirty", "artifactRef", "capturedAt"]);
	const state = enumValue(item.state, ["provisioning", "ready", "bound", "active", "ready_handoff", "partial", "retained", "needs_attention", "integrated", "cleaned"], "task workspace evidence state is invalid");
	if (typeof item.dirty !== "boolean") throw new Error("task workspace evidence state is invalid");
	const branchRef = text(item.branchRef, "task workspace branch", MAX_PATH_BYTES);
	const result: HostedTaskWorkspaceEvidence = { workspaceId: text(item.workspaceId, "task workspace ID", MAX_ID_BYTES), baseCommit: gitOid(item.baseCommit, "task workspace base"), headCommit: gitOid(item.headCommit, "task workspace head"), branchRef, state, dirty: item.dirty, artifactRef: text(item.artifactRef, "task workspace artifact", MAX_PATH_BYTES), capturedAt: nonNegativeNumber(item.capturedAt, "task workspace capture time") };
	if (result.artifactRef !== branchRef) throw new Error("task workspace artifact does not match its branch");
	return result;
}

function validateDelivery(value: unknown): HostedEventDelivery {
	const candidate = strictObject(value, "event delivery");
	if (candidate.status === "pending") {
		const delivery = strictObject(value, "pending delivery", ["status", "latestClaimId"]);
		return delivery.latestClaimId === undefined
			? { status: "pending" }
			: { status: "pending", latestClaimId: text(delivery.latestClaimId, "latest claim id", MAX_ID_BYTES) };
	}
	if (candidate.status === "claimed") {
		const delivery = strictObject(value, "claimed delivery", ["status", "claimId"]);
		return { status: "claimed", claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES) };
	}
	if (candidate.status === "submitting" || candidate.status === "submitted" || candidate.status === "needs_attention") {
		const timeKey = candidate.status === "submitting" ? "startedAt" : candidate.status === "submitted" ? "submittedAt" : "recordedAt";
		const delivery = strictObject(value, `${candidate.status} delivery`, ["status", "claimId", "attemptId", timeKey]);
		const shared = { claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES), attemptId: text(delivery.attemptId, "submission attempt id", MAX_ID_BYTES) };
		if (candidate.status === "submitting") return { status: "submitting", ...shared, startedAt: nonNegativeNumber(delivery.startedAt, "submission start time") };
		if (candidate.status === "submitted") return { status: "submitted", ...shared, submittedAt: nonNegativeNumber(delivery.submittedAt, "submission time") };
		return { status: "needs_attention", ...shared, recordedAt: nonNegativeNumber(delivery.recordedAt, "attention time") };
	}
	if (candidate.status === "acked") {
		const delivery = strictObject(value, "acknowledged delivery", ["status", "claimId", "ackedAt"]);
		return { status: "acked", claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES), ackedAt: nonNegativeNumber(delivery.ackedAt, "acknowledgement time") };
	}
	throw new Error("invalid delivery status");
}

function validateAutoCapacityReservation(value: unknown, key: string): HostedAutoCapacityReservation {
	const item = strictObject(value, "Auto capacity reservation", ["version", "operationId", "projectRoot", "callerTargetKey", "callerParticipantKey", "expectedCallerGeneration", "participantKeys", "createdAt"]);
	const participantKeys = stringArray(item.participantKeys, "Auto capacity participant keys", HOSTED_AUTO_MAX_COLLABORATORS).map((participantKey) => text(participantKey, "Auto capacity participant key", MAX_ID_BYTES));
	const result: HostedAutoCapacityReservation = {
		version: 1,
		operationId: text(item.operationId, "Auto capacity operation ID", MAX_ID_BYTES),
		projectRoot: text(item.projectRoot, "Auto capacity project root", MAX_PATH_BYTES),
		callerTargetKey: text(item.callerTargetKey, "Auto capacity caller target key", MAX_ID_BYTES),
		callerParticipantKey: text(item.callerParticipantKey, "Auto capacity caller participant key", MAX_ID_BYTES),
		...(item.expectedCallerGeneration === undefined ? {} : { expectedCallerGeneration: text(item.expectedCallerGeneration, "Auto capacity caller generation", MAX_ID_BYTES) }),
		participantKeys,
		createdAt: nonNegativeNumber(item.createdAt, "Auto capacity reservation time"),
	};
	if (item.version !== 1 || result.operationId !== key || participantKeys.length < 1 || new Set(participantKeys).size !== participantKeys.length || participantKeys.includes(result.callerParticipantKey)) throw new Error("invalid Auto capacity reservation");
	return result;
}

function validateClaim(value: unknown, key: string): HostedClaim {
	const claim = strictObject(value, "claim", ["claimId", "targetKey", "registrationId", "clientGeneration", "eventIds", "createdAt", "leaseUntil", "status", "settledAt"]);
	if (claim.status !== "active" && claim.status !== "released" && claim.status !== "acked") throw new Error("invalid claim status");
	const eventIds = stringArray(claim.eventIds, "claim event ids", HOSTED_MAX_DELIVERY_BATCH);
	if (eventIds.length < 1 || new Set(eventIds).size !== eventIds.length) throw new Error("invalid claim event ids");
	const result: HostedClaim = {
		claimId: text(claim.claimId, "claim id", MAX_ID_BYTES),
		targetKey: text(claim.targetKey, "target key", MAX_ID_BYTES),
		registrationId: text(claim.registrationId, "registration id", MAX_ID_BYTES),
		clientGeneration: text(claim.clientGeneration, "client generation", MAX_ID_BYTES),
		eventIds,
		createdAt: nonNegativeNumber(claim.createdAt, "claim creation time"),
		leaseUntil: nonNegativeNumber(claim.leaseUntil, "claim lease"),
		status: claim.status,
		...(claim.settledAt === undefined ? {} : { settledAt: nonNegativeNumber(claim.settledAt, "claim settled time") }),
	};
	if (result.claimId !== key || result.leaseUntil <= result.createdAt) throw new Error("invalid claim identity or lease");
	if (result.status === "active" ? result.settledAt !== undefined : result.settledAt === undefined) throw new Error("invalid claim settlement");
	return result;
}

function validateWake(value: unknown, key: string): HostedWake {
	const wake = strictObject(value, "wake", ["wakeId", "targetKey", "registrationId", "createdAt"]);
	const result: HostedWake = {
		wakeId: text(wake.wakeId, "wake id", MAX_ID_BYTES),
		targetKey: text(wake.targetKey, "target key", MAX_ID_BYTES),
		registrationId: text(wake.registrationId, "registration id", MAX_ID_BYTES),
		createdAt: nonNegativeNumber(wake.createdAt, "wake creation time"),
	};
	if (result.targetKey !== key) throw new Error("wake target does not match map key");
	return result;
}

function validateReferences(state: HostedRuntimeState): void {
	for (const reservation of Object.values(state.autoCapacityReservations)) {
		const target = state.targets[reservation.callerTargetKey];
		if (target?.kind !== "pi" || target.projectRoot !== reservation.projectRoot) throw new Error("Auto capacity caller target is missing or invalid");
	}
	for (const launch of Object.values(state.bridgeLaunches)) {
		const callerTarget = state.targets[launch.callerTargetKey];
		if (callerTarget?.kind !== "pi" || callerTarget.projectRoot !== launch.projectRoot) throw new Error("bridge launch caller target is missing or invalid");
		const target = state.targets[launch.targetKey];
		if (launch.status === "consumed" ? !target || (target.kind !== "bridge" && target.kind !== "agent") || !bridgeTargetMatchesLaunch(target, launch, launch.clientGeneration!) : target !== undefined) throw new Error("bridge launch target settlement is inconsistent");
	}
	for (const target of Object.values(state.targets)) {
		if (target.kind === "bridge" || target.kind === "agent") {
			const launch = state.bridgeLaunches[target.bridgeId];
			if (!launch || launch.status !== "consumed" || !bridgeTargetMatchesLaunch(target, launch, target.clientGeneration)) throw new Error("bridge target authority is inconsistent");
		} else if (target.workspaceId) {
			const workspace = state.workspaces[target.workspaceId];
			if (!workspace || !workspaceTargetMatches(target, workspace)) throw new Error("Pi workspace target authority is inconsistent");
		}
	}
	for (const workspace of Object.values(state.workspaces)) {
		const callerTarget = state.targets[workspace.callerTargetKey];
		const target = state.targets[workspace.targetKey];
		if (callerTarget?.kind !== "pi" || callerTarget.projectRoot !== workspace.projectRoot) throw new Error("workspace caller target is missing or invalid");
		if (["active", "ready_handoff", "partial", "retained", "integrated"].includes(workspace.state) ? !target || !workspaceTargetMatches(target, workspace) : ["provisioning", "ready", "bound"].includes(workspace.state) && target !== undefined) throw new Error("workspace target settlement is inconsistent");
	}
	const activeIntegrationWorkspaces = new Set<string>();
	for (const integration of Object.values(state.integrations)) {
		const workspace = state.workspaces[integration.workspaceId];
		if (!workspace || workspace.projectRoot !== integration.projectRoot || workspace.gitCommonDir !== integration.gitCommonDir) throw new Error("integration workspace reference is invalid");
		if (integration.state !== "cleaned") {
			if (activeIntegrationWorkspaces.has(integration.workspaceId)) throw new Error("workspace has multiple non-cleaned integrations");
			activeIntegrationWorkspaces.add(integration.workspaceId);
		}
	}
	for (const monitor of Object.values(state.monitors)) if (!state.targets[monitor.targetKey]) throw new Error("monitor target is missing");
	const heldTargets = new Set<string>();
	for (const participant of Object.values(state.participants)) {
		if (participant.state === "held") {
			const target = state.targets[participant.holderTargetKey!];
			if (!target || target.projectRoot !== participant.projectRoot || heldTargets.has(target.targetKey)) throw new Error("participant holder is missing, outside its project, or already holds another identity");
			heldTargets.add(target.targetKey);
		}
		for (const recipientKey of Object.keys(participant.outSeq)) {
			const recipient = state.participants[recipientKey];
			if (!recipient || recipient.projectRoot !== participant.projectRoot || recipient.protocol !== participant.protocol) throw new Error("participant output sequence recipient is invalid");
		}
	}
	for (const [dedupeKey, eventId] of Object.entries(state.dedupe)) {
		const event = state.events[eventId];
		if (!event || event.dedupeKey !== dedupeKey) throw new Error("event dedupe reference is invalid");
	}
	const settledTasks = new Set<string>();
	for (const event of Object.values(state.events)) {
		if (state.dedupe[event.dedupeKey] !== event.eventId) throw new Error("event dedupe reference is invalid");
		if (event.type === "filesystem.created") {
			if (!state.targets[event.targetKey]) throw new Error("event target is missing");
		} else {
			const sender = state.participants[event.payload.senderParticipantKey];
			const recipient = state.participants[event.recipientParticipantKey];
			if (!sender || !recipient || sender.projectRoot !== recipient.projectRoot || sender.protocol !== recipient.protocol) throw new Error("mailbox event participant reference is invalid");
			if (event.type === "mailbox.task_result") {
				const task = state.events[event.payload.inReplyToEventId];
				if (!task || task.type !== "mailbox.task" || task.recipientParticipantKey !== sender.participantKey || task.payload.senderParticipantKey !== recipient.participantKey || settledTasks.has(task.eventId)) throw new Error("task result reference is invalid or duplicated");
				settledTasks.add(task.eventId);
			}
		}
		const claimId = event.delivery.status === "pending" ? event.delivery.latestClaimId : event.delivery.claimId;
		const claim = claimId ? state.claims[claimId] : undefined;
		if (claimId && (!claim || !eventClaimTargetMatches(state, event, claim.targetKey) || !claim.eventIds.includes(event.eventId))) throw new Error("event claim reference is invalid");
	}
	for (const claim of Object.values(state.claims)) {
		if (!state.targets[claim.targetKey]) throw new Error("claim target is missing");
		for (const eventId of claim.eventIds) {
			const event = state.events[eventId];
			if (!event || !eventClaimTargetMatches(state, event, claim.targetKey)) throw new Error("claim event reference is invalid");
		}
	}
	for (const wake of Object.values(state.wakes)) if (!state.targets[wake.targetKey]) throw new Error("wake target is missing");
}

function mapValues<T>(value: unknown, name: string, validate: (item: unknown, key: string) => T, max = MAX_STATE_RECORDS): Record<string, T> {
	const record = strictObject(value, name);
	const entries = Object.entries(record);
	if (entries.length > max) throw new Error(`${name} exceeds ${max} entries`);
	return Object.fromEntries(entries.map(([key, item]) => [key, validate(item, key)]));
}

function mapStrings(value: unknown, name: string): Record<string, string> {
	const record = strictObject(value, name);
	if (Object.keys(record).length > MAX_STATE_RECORDS) throw new Error(`${name} exceeds ${MAX_STATE_RECORDS} entries`);
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [text(key, `${name} key`, MAX_PATH_BYTES), text(item, `${name} value`, MAX_ID_BYTES)]));
}

function strictObject(value: unknown, name: string, allowed?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	// SAFETY: The preceding runtime check excludes null, primitives, and arrays before schema validation and key access.
	const record = value as Record<string, unknown>;
	if (allowed) for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`);
	return record;
}

function enumValue<const Value extends string>(value: unknown, allowed: readonly Value[], message: string): Value {
	if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) throw new Error(message);
	// SAFETY: Runtime equality against the complete literal allowlist proves membership in its inferred union.
	return value as Value;
}

function stringArray(value: unknown, name: string, max: number): string[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must contain at most ${max} values`);
	return value.map((item) => text(item, name, MAX_ID_BYTES));
}

function text(value: unknown, name: string, maxBytes: number): string {
	const result = stringValue(value, name, maxBytes);
	if (!result.trim()) throw new Error(`${name} must not be empty`);
	return result;
}

function stringValue(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a string of at most ${maxBytes} bytes`);
	return value;
}

function gitOid(value: unknown, name: string): string {
	const result = text(value, name, 64);
	if (!GIT_OID.test(result)) throw new Error(`${name} must be a Git object ID`);
	return result;
}

function hash(value: unknown, name: string): string {
	const result = text(value, name, 64);
	if (!HASH.test(result)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
	return result;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
	return value;
}

function boolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function replaceParticipant(state: HostedRuntimeState, participant: HostedParticipant): HostedRuntimeState {
	return { ...state, participants: { ...state.participants, [participant.participantKey]: participant } };
}

function transitionParticipant(
	participant: HostedParticipant,
	transition: HostedParticipantTransition,
	state: HostedParticipant["state"],
	holderTargetKey?: string,
): HostedParticipant {
	return {
		...participant,
		state,
		generation: transition.generation,
		...(holderTargetKey ? { holderTargetKey } : {}),
		...(!holderTargetKey && participant.holderTargetKey ? { holderTargetKey: undefined } : {}),
		transitions: [...participant.transitions, transition].slice(-HOSTED_PARTICIPANT_TRANSITION_LIMIT),
		updatedAt: transition.at,
	};
}

function latestHolderTargetKey(participant: HostedParticipant): string | undefined {
	for (let index = participant.transitions.length - 1; index >= 0; index--) {
		const transition = participant.transitions[index]!;
		if (transition.holderTargetKey) return transition.holderTargetKey;
		if (transition.previousHolderTargetKey) return transition.previousHolderTargetKey;
	}
	return undefined;
}

function assertTargetHasNoParticipant(state: HostedRuntimeState, targetKey: string, exceptParticipantKey: string): void {
	if (Object.values(state.participants).some((participant) => participant.participantKey !== exceptParticipantKey && participant.state === "held" && participant.holderTargetKey === targetKey)) {
		throw new HostedStateConflictError("conflict", "Target already holds another participant identity.");
	}
}

function hasActiveParticipantClaim(state: HostedRuntimeState, participantKey: string): boolean {
	return Object.values(state.claims).some((claim) => claim.status === "active" && claim.eventIds.some((eventId) => {
		const event = state.events[eventId];
		return event !== undefined && event.type !== "filesystem.created" && event.recipientParticipantKey === participantKey;
	}));
}

export function hostedEventRoutesToTarget(state: HostedRuntimeState, event: HostedEvent, targetKey: string): boolean {
	if (event.type === "filesystem.created") return event.targetKey === targetKey;
	const participant = state.participants[event.recipientParticipantKey];
	return participant?.state === "held" && participant.holderTargetKey === targetKey;
}

function deliveryBelongsToClaim(delivery: HostedEventDelivery, claimId: string): boolean {
	if (delivery.status !== "pending") return delivery.claimId === claimId;
	return delivery.latestClaimId === claimId;
}

function eventClaimTargetMatches(state: HostedRuntimeState, event: HostedEvent, targetKey: string): boolean {
	if (event.type === "filesystem.created") return event.targetKey === targetKey;
	const participant = state.participants[event.recipientParticipantKey];
	const target = state.targets[targetKey];
	return Boolean(participant && target && participant.projectRoot === target.projectRoot);
}

function mailboxDedupeKey(senderParticipantKey: string, sendId: string): string {
	return `mailbox:${senderParticipantKey}:${sendId}`;
}

function mailboxFingerprint(recipientParticipantKey: string, body: string): string {
	return createHash("sha256").update(recipientParticipantKey).update("\0").update(body).digest("hex");
}

function taskFingerprint(recipientParticipantKey: string, body: string): string {
	return createHash("sha256").update("task\0").update(recipientParticipantKey).update("\0").update(body).digest("hex");
}

function taskResultFingerprint(recipientParticipantKey: string, operation: Extract<HostedStateOperation, { type: "task.result" }>): string {
	return createHash("sha256").update("task-result\0").update(recipientParticipantKey).update("\0").update(operation.inReplyToEventId).update("\0").update(operation.status).update("\0").update(operation.sessionAdvance).update("\0").update(operation.body).update("\0").update(JSON.stringify(operation.workspace ?? null)).digest("hex");
}

function sameTaskWorkspaceEvidence(evidence: HostedTaskWorkspaceEvidence, workspace: HostedWorkspace): boolean {
	return evidence.workspaceId === workspace.workspaceId && evidence.baseCommit === workspace.baseCommit && evidence.headCommit === workspace.headCommit && evidence.branchRef === workspace.branchRef && evidence.state === workspace.state && evidence.artifactRef === workspace.branchRef && typeof evidence.dirty === "boolean" && Number.isFinite(evidence.capturedAt) && evidence.capturedAt >= 0;
}

function assertParticipantName(value: string, name: string): void {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new HostedStateConflictError("conflict", `${name} has invalid syntax.`);
}

function assertStateId(value: string, name: string): void {
	if (!value.trim() || Buffer.byteLength(value) > MAX_ID_BYTES) throw new HostedStateConflictError("conflict", `${name} is invalid.`);
}

function assertStateTime(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new HostedStateConflictError("conflict", `${name} is invalid.`);
}

function participantName(value: unknown, name: string): string {
	const result = text(value, name, 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${name} has invalid syntax`);
	return result;
}

function assertAutoCapacity(state: HostedRuntimeState, projectRoot: string, callerParticipantKey: string | undefined, requestedParticipantKeys: string[]): void {
	const reservations = Object.values(state.autoCapacityReservations).filter((reservation) => reservation.projectRoot === projectRoot);
	if (reservations.length === 0 && callerParticipantKey === undefined) return;
	const callers = new Set(reservations.map((reservation) => reservation.callerParticipantKey));
	if (callerParticipantKey) callers.add(callerParticipantKey);
	const occupied = new Set(Object.values(state.participants).filter((participant) => participant.projectRoot === projectRoot && participant.state === "held" && !callers.has(participant.participantKey)).map((participant) => participant.participantKey));
	for (const reservation of reservations) for (const participantKey of reservation.participantKeys) occupied.add(participantKey);
	for (const participantKey of requestedParticipantKeys) if (!callers.has(participantKey)) occupied.add(participantKey);
	if (occupied.size > HOSTED_AUTO_MAX_COLLABORATORS) throw new HostedStateConflictError("conflict", `Runtime Auto mode permits at most ${HOSTED_AUTO_MAX_COLLABORATORS} held or reserved collaborators.`);
}

function sameAutoCapacityReservation(left: HostedAutoCapacityReservation, right: HostedAutoCapacityReservation): boolean {
	return left.version === right.version && left.operationId === right.operationId && left.projectRoot === right.projectRoot && left.callerTargetKey === right.callerTargetKey && left.callerParticipantKey === right.callerParticipantKey && left.expectedCallerGeneration === right.expectedCallerGeneration && sameOrderedIds(left.participantKeys, right.participantKeys);
}

function sameTarget(left: HostedTarget, right: HostedTarget): boolean {
	if (left.kind !== right.kind || left.targetKey !== right.targetKey || left.projectRoot !== right.projectRoot) return false;
	if (left.kind === "pi" && right.kind === "pi") return left.piSessionId === right.piSessionId && left.piSessionFile === right.piSessionFile && left.workspaceId === right.workspaceId && left.workspaceRoot === right.workspaceRoot;
	if ((left.kind === "bridge" || left.kind === "agent") && (right.kind === "bridge" || right.kind === "agent")) return left.kind === right.kind && left.bridgeId === right.bridgeId && (left.kind !== "agent" || right.kind !== "agent" || left.driver === right.driver && JSON.stringify(left.agentSession) === JSON.stringify(right.agentSession) && left.capabilityTier === right.capabilityTier) && left.participantKey === right.participantKey && left.holderGeneration === right.holderGeneration && left.profile === right.profile && left.configurationHash === right.configurationHash && left.clientGeneration === right.clientGeneration && left.reconnectDigest === right.reconnectDigest && left.workspaceId === right.workspaceId && left.workspaceRoot === right.workspaceRoot && JSON.stringify(left.herdr) === JSON.stringify(right.herdr) && JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
	return false;
}

function sameWorkspace(left: HostedWorkspace, right: HostedWorkspace): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function sameWorkspaceIdentity(left: HostedWorkspace, right: HostedWorkspace): boolean {
	return left.workspaceId === right.workspaceId && left.requestId === right.requestId && left.projectRoot === right.projectRoot && left.gitCommonDir === right.gitCommonDir && left.worktreePath === right.worktreePath && left.branchRef === right.branchRef && left.participantKey === right.participantKey && left.holderGeneration === right.holderGeneration && left.targetKey === right.targetKey && left.ownerKind === right.ownerKind && left.piSessionId === right.piSessionId && left.bridgeId === right.bridgeId && left.baseCommit === right.baseCommit && left.launchDigest === right.launchDigest && left.expiresAt === right.expiresAt;
}

function workspaceTargetMatches(target: HostedTarget, workspace: HostedWorkspace): boolean {
	if (workspace.ownerKind === "pi") return target.kind === "pi" && target.targetKey === workspace.targetKey && target.projectRoot === workspace.projectRoot && target.piSessionId === workspace.piSessionId && target.workspaceId === workspace.workspaceId && target.workspaceRoot === workspace.worktreePath;
	return (target.kind === "bridge" || target.kind === "agent") && target.targetKey === workspace.targetKey && target.projectRoot === workspace.projectRoot && target.bridgeId === workspace.bridgeId && target.workspaceId === workspace.workspaceId && target.workspaceRoot === workspace.worktreePath && target.profile === "workspace-write" && target.participantKey === workspace.participantKey && target.holderGeneration === workspace.holderGeneration && JSON.stringify(target.herdr) === JSON.stringify(workspace.herdr);
}

function workspaceTransitionAllowed(from: HostedWorkspace["state"], to: HostedWorkspace["state"]): boolean {
	const transitions = {
		provisioning: ["ready", "cleaned", "needs_attention"], ready: ["bound", "retained", "needs_attention", "cleaned"], bound: ["active", "retained", "needs_attention", "cleaned"], active: ["ready_handoff", "partial", "retained", "needs_attention"], ready_handoff: ["ready_handoff", "partial", "retained", "integrated", "cleaned", "needs_attention"], partial: ["ready_handoff", "partial", "retained", "integrated", "cleaned", "needs_attention"], retained: ["ready_handoff", "partial", "integrated", "cleaned", "needs_attention"], needs_attention: ["needs_attention", "retained", "cleaned"], integrated: ["cleaned", "needs_attention"], cleaned: [],
	} satisfies Record<HostedWorkspace["state"], readonly HostedWorkspace["state"][]>;
	const allowed: readonly HostedWorkspace["state"][] = transitions[from];
	return allowed.includes(to);
}

function sameIntegrationIdentity(left: HostedIntegration, right: HostedIntegration): boolean {
	return left.integrationId === right.integrationId && left.workspaceId === right.workspaceId && left.projectRoot === right.projectRoot && left.gitCommonDir === right.gitCommonDir && left.worktreePath === right.worktreePath && left.branchRef === right.branchRef && left.mainBranchRef === right.mainBranchRef && left.mainHead === right.mainHead && left.sourceHead === right.sourceHead && sameOrderedIds(left.sourceCommits, right.sourceCommits);
}

function integrationTransitionAllowed(from: HostedIntegration["state"], to: HostedIntegration["state"]): boolean {
	const transitions = { preparing: ["prepared", "conflicted", "needs_attention"], prepared: ["finalized", "needs_attention", "cleaned"], conflicted: ["conflicted", "cleaned", "needs_attention"], needs_attention: ["needs_attention", "cleaned"], finalized: ["cleaned", "needs_attention"], cleaned: [] } satisfies Record<HostedIntegration["state"], readonly HostedIntegration["state"][]>;
	const allowed: readonly HostedIntegration["state"][] = transitions[from];
	return allowed.includes(to);
}

function sameBridgeLaunch(left: HostedBridgeLaunch, right: HostedBridgeLaunch): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function bridgeTargetMatchesLaunch(target: HostedExternalTarget, launch: HostedBridgeLaunch, clientGeneration: string): boolean {
	return target.kind === (launch.driver ? "agent" : "bridge") && target.targetKey === launch.targetKey && target.projectRoot === launch.projectRoot && target.bridgeId === launch.launchId && (target.kind !== "agent" || target.driver === launch.driver) && target.participantKey === launch.participantKey && target.holderGeneration === launch.holderGeneration && target.profile === launch.profile && target.configurationHash === launch.configurationHash && target.clientGeneration === clientGeneration && target.reconnectDigest === launch.reconnectDigest && target.workspaceId === launch.workspaceId && target.workspaceRoot === launch.workspaceRoot && JSON.stringify(target.herdr) === JSON.stringify(launch.herdr) && JSON.stringify(target.metadata) === JSON.stringify(launch.metadata);
}

function sameMonitorIdentity(left: HostedMonitor, right: HostedMonitor): boolean {
	return left.monitorId === right.monitorId
		&& left.targetKey === right.targetKey
		&& left.generation === right.generation
		&& left.directory === right.directory
		&& left.settleMs === right.settleMs;
}

function sameClaim(left: HostedClaim, right: HostedClaim): boolean {
	return left.claimId === right.claimId && left.targetKey === right.targetKey && left.registrationId === right.registrationId && left.clientGeneration === right.clientGeneration && sameIds(left.eventIds, right.eventIds);
}

function sameWake(left: HostedWake, right: HostedWake): boolean {
	return left.wakeId === right.wakeId && left.targetKey === right.targetKey && left.registrationId === right.registrationId && left.createdAt === right.createdAt;
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const leftSorted = [...left].sort();
	const rightSorted = [...right].sort();
	return leftSorted.every((value, index) => value === rightSorted[index]);
}

function storageError(message: string, cause: unknown): HostedStateStorageError {
	if (cause instanceof HostedStateStorageError) return cause;
	return new HostedStateStorageError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
