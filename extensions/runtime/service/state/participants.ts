import { RuntimeError } from "../../errors.ts";
import { type HostedParticipant, type HostedParticipantTransition, type HostedRuntimeState, type HostedTarget, isHeld, isVacant } from "../../schemas/state.ts";
import type { HostedStateOperation } from "./operations.ts";
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
		throw new RuntimeError("conflict", "Participant identity does not match its target or durable key.");
	}
	assertParticipantName(operation.protocol, "protocol");
	assertParticipantName(operation.participantId, "participant ID");
	const current = state.participants[operation.participantKey];
	if (isHeld(current?.state)) {
		if (current.holderTargetKey === operation.targetKey) return state;
		throw new RuntimeError("conflict", "Participant is held by another target.");
	}
	assertTargetHasNoParticipant(state, operation.targetKey, operation.participantKey);
	if (!current) return replaceParticipant(state, newParticipant(operation, target));
	assertReacquirable(current, operation);
	const transition: HostedParticipantTransition = {
		cause: isVacant(current.state) ? "reacquire" : "revive",
		previousGeneration: current.generation,
		at: operation.at,
	};
	const held = transitionParticipant(current, transition, "held", operation.generation, operation.targetKey);
	return replaceParticipant(state, withTargetWorktree(held, target));
}

export function standDownParticipant(state: HostedRuntimeState, operation: StandDownOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant transition time");
	const current = state.participants[operation.participantKey];
	if (!current) throw new RuntimeError("conflict", "Participant is absent.");
	if (operation.expectedGeneration !== undefined && current.generation !== operation.expectedGeneration) {
		if (standDownAlreadyApplied(current, operation)) return state;
		throw new RuntimeError("conflict", "Participant generation changed before stand-down.");
	}
	return applyParticipantTransition(state, current, operation, "stand_down", "vacant");
}

export function releaseParticipant(state: HostedRuntimeState, operation: ReleaseOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant transition time");
	const current = state.participants[operation.participantKey];
	if (!current) throw new RuntimeError("conflict", "Participant is absent.");
	return applyParticipantTransition(state, current, operation, "release", "ended");
}

export function takeoverParticipant(state: HostedRuntimeState, operation: TakeoverOperation): HostedRuntimeState {
	assertStateId(operation.generation, "Participant generation");
	assertStateTime(operation.at, "Participant takeover time");
	const current = state.participants[operation.participantKey];
	const target = state.targets[operation.targetKey];
	if (!current || !target) throw new RuntimeError("conflict", "Participant or takeover target is absent.");
	if (!isHeld(current.state) || target.projectRoot !== current.projectRoot) {
		throw new RuntimeError("conflict", "Participant is not eligible for takeover.");
	}
	if (current.holderTargetKey === operation.targetKey) return state;
	if (!takeoverAdvances(current, operation)) {
		throw new RuntimeError("conflict", "Participant takeover is blocked by its current generation or time.");
	}
	assertTargetHasNoParticipant(state, operation.targetKey, current.participantKey);
	const transition: HostedParticipantTransition = { cause: "takeover", previousGeneration: current.generation, at: operation.at };
	return replaceParticipant(state, transitionParticipant(current, transition, "held", operation.generation, operation.targetKey));
}

export function clearParticipantWorktree(state: HostedRuntimeState, operation: ClearWorktreeOperation): HostedRuntimeState {
	const current = state.participants[operation.participantKey];
	if (!current) throw new RuntimeError("conflict", "Participant is absent.");
	if (isHeld(current.state)) {
		throw new RuntimeError("conflict", "A held participant keeps its worktree until it stands down.");
	}
	if (!current.worktreePath) return state;
	const { worktreePath: _cleared, ...participant } = current;
	return replaceParticipant(state, participant);
}

function replaceParticipant(state: HostedRuntimeState, participant: HostedParticipant): HostedRuntimeState {
	return { ...state, participants: { ...state.participants, [participant.participantKey]: participant } };
}

function assertTargetHasNoParticipant(state: HostedRuntimeState, targetKey: string, exceptParticipantKey: string): void {
	const conflicting = Object.values(state.participants).some((participant) => participant.participantKey !== exceptParticipantKey
		&& isHeld(participant.state)
		&& participant.holderTargetKey === targetKey);
	if (conflicting) throw new RuntimeError("conflict", "Target already holds another participant identity.");
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
		transition: { cause: "acquire", at: operation.at },
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
	if (!matches) throw new RuntimeError("conflict", "Participant acquire does not match its durable identity or generation.");
}

function standDownAlreadyApplied(current: HostedParticipant, operation: StandDownOperation): boolean {
	return isVacant(current.state)
		&& current.transition.cause === "stand_down"
		&& current.transition.previousGeneration === operation.expectedGeneration
		&& current.transition.previousHolderTargetKey === operation.targetKey;
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
	if (!isHeld(current.state) || current.holderTargetKey !== operation.targetKey) {
		if (transitionAlreadyApplied(current, operation, cause, nextState)) return state;
		throw new RuntimeError("conflict", "Only the current participant holder may change its state.");
	}
	if (current.generation === operation.generation || operation.at < current.updatedAt) {
		throw new RuntimeError("conflict", "Participant transition generation or time does not advance.");
	}
	const transition: HostedParticipantTransition = {
		cause,
		previousGeneration: current.generation,
		previousHolderTargetKey: operation.targetKey,
		at: operation.at,
	};
	return replaceParticipant(state, transitionParticipant(current, transition, nextState, operation.generation));
}

function transitionAlreadyApplied(
	current: HostedParticipant,
	operation: ParticipantTransitionRequest,
	cause: HostedParticipantTransition["cause"],
	nextState: HostedParticipant["state"],
): boolean {
	return current.state === nextState
		&& current.transition.cause === cause
		&& current.transition.previousHolderTargetKey === operation.targetKey;
}

function transitionParticipant(
	participant: HostedParticipant,
	transition: HostedParticipantTransition,
	state: HostedParticipant["state"],
	generation: string,
	holderTargetKey?: string,
): HostedParticipant {
	const result: HostedParticipant = { ...participant, state, generation, transition, updatedAt: transition.at };
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
