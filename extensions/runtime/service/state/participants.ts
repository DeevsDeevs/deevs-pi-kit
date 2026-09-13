import {
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
	type HostedParticipant,
	type HostedParticipantTransition,
	type HostedRuntimeState,
	type HostedStateOperation,
	type HostedTarget,
} from "../../hosted-types.ts";
import { HostedStateConflictError } from "./errors.ts";
import { assertParticipantName, assertStateId, assertStateTime } from "./guards.ts";
import { deriveParticipantKey } from "./keys.ts";

type AcquireOperation = Extract<HostedStateOperation, { type: "participant.acquire" }>;
type StandDownOperation = Extract<HostedStateOperation, { type: "participant.stand_down" }>;
type ReleaseOperation = Extract<HostedStateOperation, { type: "participant.release" }>;
type TakeoverOperation = Extract<HostedStateOperation, { type: "participant.takeover" }>;
type ClearWorktreeOperation = Extract<HostedStateOperation, { type: "participant.worktree.clear" }>;

interface ParticipantTransitionRequest {
	participantKey: string;
	targetKey: string;
	generation: string;
	at: number;
}

export function acquireParticipant(state: HostedRuntimeState, operation: AcquireOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant acquisition time");
	const target = state.targets[operation.targetKey];
	if (!target || !acquireMatchesTarget(target, operation)) {
		throw new HostedStateConflictError("conflict", "Participant identity does not match its target or durable key.");
	}
	assertParticipantName(operation.protocol, "protocol");
	assertParticipantName(operation.participantId, "participant ID");
	const current = state.participants[operation.participantKey];
	if (current?.state === "held") {
		if (current.holderTargetKey === operation.targetKey) return state;
		throw new HostedStateConflictError("conflict", "Participant is held by another target.");
	}
	assertTargetHasNoParticipant(state, operation.targetKey, operation.participantKey);
	if (!current) return replaceParticipant(state, newParticipant(operation, target));
	assertReacquirable(current, operation);
	const transition: HostedParticipantTransition = {
		cause: current.state === "vacant" ? "reacquire" : "revive",
		generation: operation.generation,
		holderTargetKey: operation.targetKey,
		previousGeneration: current.generation,
		at: operation.at,
	};
	const previousHolderTargetKey = latestHolderTargetKey(current);
	if (previousHolderTargetKey !== undefined) transition.previousHolderTargetKey = previousHolderTargetKey;
	const held = transitionParticipant(current, transition, "held", operation.targetKey);
	return replaceParticipant(state, withTargetWorktree(held, target));
}

export function standDownParticipant(state: HostedRuntimeState, operation: StandDownOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant transition time");
	const current = state.participants[operation.participantKey];
	if (!current) throw new HostedStateConflictError("conflict", "Participant is absent.");
	if (operation.expectedGeneration !== undefined && current.generation !== operation.expectedGeneration) {
		if (standDownAlreadyApplied(current, operation)) return state;
		throw new HostedStateConflictError("conflict", "Participant generation changed before stand-down.");
	}
	return applyParticipantTransition(state, current, operation, "stand_down", "vacant");
}

export function releaseParticipant(state: HostedRuntimeState, operation: ReleaseOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant transition time");
	const current = state.participants[operation.participantKey];
	if (!current) throw new HostedStateConflictError("conflict", "Participant is absent.");
	return applyParticipantTransition(state, current, operation, "release", "ended");
}

export function takeoverParticipant(state: HostedRuntimeState, operation: TakeoverOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant takeover time");
	const current = state.participants[operation.participantKey];
	const target = state.targets[operation.targetKey];
	if (!current || current.state !== "held" || !target || target.projectRoot !== current.projectRoot) {
		throw new HostedStateConflictError("conflict", "Participant is not eligible for takeover.");
	}
	if (current.holderTargetKey === operation.targetKey) return state;
	if (!takeoverAdvances(current, operation) || hasActiveParticipantClaim(state, current.participantKey)) {
		throw new HostedStateConflictError("conflict", "Participant takeover is blocked by its current generation, time, or active claims.");
	}
	assertTargetHasNoParticipant(state, operation.targetKey, current.participantKey);
	const transition: HostedParticipantTransition = {
		cause: "takeover",
		generation: operation.generation,
		holderTargetKey: operation.targetKey,
		previousGeneration: current.generation,
		at: operation.at,
	};
	if (current.holderTargetKey !== undefined) transition.previousHolderTargetKey = current.holderTargetKey;
	return replaceParticipant(state, transitionParticipant(current, transition, "held", operation.targetKey));
}

export function clearParticipantWorktree(state: HostedRuntimeState, operation: ClearWorktreeOperation): HostedRuntimeState {
	const current = state.participants[operation.participantKey];
	if (!current) throw new HostedStateConflictError("conflict", "Participant is absent.");
	if (current.state === "held") {
		throw new HostedStateConflictError("conflict", "A held participant keeps its worktree until it stands down.");
	}
	if (!current.worktreePath) return state;
	const { worktreePath: _cleared, ...participant } = current;
	return replaceParticipant(state, participant);
}

export function replaceParticipant(state: HostedRuntimeState, participant: HostedParticipant): HostedRuntimeState {
	return { ...state, participants: { ...state.participants, [participant.participantKey]: participant } };
}

export function assertTargetHasNoParticipant(state: HostedRuntimeState, targetKey: string, exceptParticipantKey: string): void {
	const conflicting = Object.values(state.participants).some((participant) => participant.participantKey !== exceptParticipantKey
		&& participant.state === "held"
		&& participant.holderTargetKey === targetKey);
	if (conflicting) throw new HostedStateConflictError("conflict", "Target already holds another participant identity.");
}

function acquireMatchesTarget(target: HostedTarget, operation: AcquireOperation): boolean {
	if (target.projectRoot !== operation.projectRoot) return false;
	return operation.participantKey === deriveParticipantKey(operation.projectRoot, operation.protocol, operation.participantId);
}

function newParticipant(operation: AcquireOperation, target: HostedTarget): HostedParticipant {
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
	if (target.worktreePath) participant.worktreePath = target.worktreePath;
	return participant;
}

function assertReacquirable(current: HostedParticipant, operation: AcquireOperation): void {
	const matches = current.projectRoot === operation.projectRoot
		&& current.protocol === operation.protocol
		&& current.participantId === operation.participantId
		&& current.generation !== operation.generation
		&& operation.at >= current.updatedAt;
	if (!matches) throw new HostedStateConflictError("conflict", "Participant acquire does not match its durable identity or generation.");
}

function standDownAlreadyApplied(current: HostedParticipant, operation: StandDownOperation): boolean {
	const latest = current.transitions.at(-1);
	return current.state === "vacant"
		&& latest?.cause === "stand_down"
		&& latest.previousGeneration === operation.expectedGeneration
		&& latest.previousHolderTargetKey === operation.targetKey;
}

function takeoverAdvances(current: HostedParticipant, operation: TakeoverOperation): boolean {
	return current.generation !== operation.generation && operation.at >= current.updatedAt;
}

function applyParticipantTransition(
	state: HostedRuntimeState,
	current: HostedParticipant,
	operation: ParticipantTransitionRequest,
	cause: HostedParticipantTransition["cause"],
	nextState: HostedParticipant["state"],
): HostedRuntimeState {
	if (current.state !== "held" || current.holderTargetKey !== operation.targetKey) {
		const latest = current.transitions.at(-1);
		if (current.state === nextState && latest?.cause === cause && latest.previousHolderTargetKey === operation.targetKey) return state;
		throw new HostedStateConflictError("conflict", "Only the current participant holder may change its state.");
	}
	if (current.generation === operation.generation || operation.at < current.updatedAt) {
		throw new HostedStateConflictError("conflict", "Participant transition generation or time does not advance.");
	}
	const transition: HostedParticipantTransition = {
		cause,
		generation: operation.generation,
		previousGeneration: current.generation,
		previousHolderTargetKey: current.holderTargetKey,
		at: operation.at,
	};
	return replaceParticipant(state, transitionParticipant(current, transition, nextState));
}

function transitionParticipant(
	participant: HostedParticipant,
	transition: HostedParticipantTransition,
	state: HostedParticipant["state"],
	holderTargetKey?: string,
): HostedParticipant {
	const result: HostedParticipant = {
		...participant,
		state,
		generation: transition.generation,
		transitions: [...participant.transitions, transition].slice(-HOSTED_PARTICIPANT_TRANSITION_LIMIT),
		updatedAt: transition.at,
	};
	if (holderTargetKey) result.holderTargetKey = holderTargetKey;
	else if (participant.holderTargetKey) result.holderTargetKey = undefined;
	return result;
}

function withTargetWorktree(participant: HostedParticipant, target: HostedTarget): HostedParticipant {
	if (participant.worktreePath === target.worktreePath) return participant;
	if (!target.worktreePath) {
		const { worktreePath: _cleared, ...cleared } = participant;
		return cleared;
	}
	return { ...participant, worktreePath: target.worktreePath };
}

function latestHolderTargetKey(participant: HostedParticipant): string | undefined {
	for (const transition of [...participant.transitions].reverse()) {
		if (transition.holderTargetKey) return transition.holderTargetKey;
		if (transition.previousHolderTargetKey) return transition.previousHolderTargetKey;
	}
	return undefined;
}

function hasActiveParticipantClaim(state: HostedRuntimeState, participantKey: string): boolean {
	return Object.values(state.claims).some((claim) => claim.status === "active" && claim.eventIds.some((eventId) => {
		const event = state.events[eventId];
		return event !== undefined && event.type !== "filesystem.created" && event.recipientParticipantKey === participantKey;
	}));
}
