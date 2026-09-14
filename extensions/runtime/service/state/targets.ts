import { RuntimeError } from "../../errors.ts";
import { type HostedParticipant, type HostedRuntimeState, isHeld, isPiTarget, isVacant, isWriter } from "../../schemas/state.ts";
import type { HostedAgentBind, HostedStateOperation } from "./operations.ts";
import { sameTarget } from "./compare.ts";
import { assertParticipantName, assertStateId, assertStateTime } from "./guards.ts";
import { deriveAgentTargetKey, deriveParticipantKey } from "./keys.ts";
import { acquireParticipant } from "./participants.ts";

type EnsureTargetOperation = Extract<HostedStateOperation, { type: "target.ensure" }>;
type BindAgentOperation = Extract<HostedStateOperation, { type: "agent.bind" }>;

export function ensureTarget(state: HostedRuntimeState, operation: EnsureTargetOperation): HostedRuntimeState {
	const existing = state.targets[operation.target.targetKey];
	if (existing) {
		if (!sameTarget(existing, operation.target)) {
			throw new RuntimeError("conflict", "Target identity does not match its durable key.");
		}
		return state;
	}
	return { ...state, targets: { ...state.targets, [operation.target.targetKey]: operation.target } };
}

export function bindAgentTarget(state: HostedRuntimeState, operation: BindAgentOperation): HostedRuntimeState {
	const bind = operation.bind;
	const target = bind.target;
	assertStateTime(bind.at, "Agent bind time");
	assertStateId(target.agentName, "Herdr agent name");
	assertParticipantName(bind.protocol, "protocol");
	assertParticipantName(bind.participantId, "participant ID");
	assertAgentBindCaller(state, bind);
	assertAgentBindIdentity(bind);
	const participant = state.participants[target.participantKey];
	const alreadyBound = isHeld(participant?.state)
		&& participant.holderTargetKey === target.targetKey
		&& participant.generation === target.holderGeneration;
	if (!alreadyBound && !reservedForBind(participant, bind.expectedParticipantGeneration)) {
		throw new RuntimeError("conflict", "Agent bind participant generation is unavailable.");
	}
	const next = ensureTarget(state, { type: "target.ensure", target });
	if (alreadyBound) return next;
	return acquireParticipant(next, {
		type: "participant.acquire",
		participantKey: target.participantKey,
		projectRoot: target.projectRoot,
		protocol: bind.protocol,
		participantId: bind.participantId,
		targetKey: target.targetKey,
		generation: target.holderGeneration,
		at: bind.at,
	});
}

function assertAgentBindIdentity(bind: HostedAgentBind): void {
	const target = bind.target;
	if (target.targetKey !== deriveAgentTargetKey(target.projectRoot, target.agentName)) {
		throw new RuntimeError("conflict", "Agent target key does not match its Herdr agent name.");
	}
	if (target.participantKey !== deriveParticipantKey(target.projectRoot, bind.protocol, bind.participantId)) {
		throw new RuntimeError("conflict", "Agent bind participant key does not match its durable identity.");
	}
	if (target.participantKey === bind.callerParticipantKey) {
		throw new RuntimeError("conflict", "An agent target may not hold its caller's participant identity.");
	}
	if (!isWriter(target.profile) && target.worktreePath !== undefined) {
		throw new RuntimeError("conflict", "Read-only agent targets never carry a worktree.");
	}
}

function assertAgentBindCaller(state: HostedRuntimeState, bind: HostedAgentBind): void {
	const caller = state.participants[bind.callerParticipantKey];
	const callerTarget = state.targets[bind.callerTargetKey];
	const held = isHeld(caller?.state)
		&& caller.generation === bind.callerGeneration
		&& caller.holderTargetKey === bind.callerTargetKey;
	if (!held) throw new RuntimeError("conflict", "Agent bind caller authority changed.");
	if (!isPiTarget(callerTarget) || caller.projectRoot !== bind.target.projectRoot) {
		throw new RuntimeError("conflict", "Agent bind caller is outside its Pi project.");
	}
}

function reservedForBind(participant: HostedParticipant | undefined, expectedGeneration: string | undefined): boolean {
	if (!participant) return expectedGeneration === undefined;
	return isVacant(participant.state) && participant.generation === expectedGeneration;
}
