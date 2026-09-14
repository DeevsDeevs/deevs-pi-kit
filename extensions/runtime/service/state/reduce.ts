import type { HostedRuntimeState, HostedStateOperation } from "../../hosted-types.ts";
import { pruneRetention } from "./inbox.ts";
import { sendMailboxMessage } from "./mailbox.ts";
import { expireMessagingGrant, issueMessagingGrant, markMessagingEventRead, publishMessagingEvent } from "./messaging.ts";
import {
	acquireParticipant,
	clearParticipantWorktree,
	releaseParticipant,
	standDownParticipant,
	takeoverParticipant,
} from "./participants.ts";
import { bindAgentTarget, ensureTarget } from "./targets.ts";

type HostedOperationByType = { [Type in HostedStateOperation["type"]]: Extract<HostedStateOperation, { type: Type }> };

type HostedStateReducers = {
	[Type in HostedStateOperation["type"]]: (state: HostedRuntimeState, operation: HostedOperationByType[Type]) => HostedRuntimeState;
};

const reducers: HostedStateReducers = {
	"messaging.issue": issueMessagingGrant,
	"messaging.expire": expireMessagingGrant,
	"messaging.send": publishMessagingEvent,
	"messaging.read": markMessagingEventRead,
	"target.ensure": ensureTarget,
	"agent.bind": bindAgentTarget,
	"participant.acquire": acquireParticipant,
	"participant.stand_down": standDownParticipant,
	"participant.release": releaseParticipant,
	"participant.worktree.clear": clearParticipantWorktree,
	"participant.takeover": takeoverParticipant,
	"mailbox.send": sendMailboxMessage,
	"retention.prune": pruneRetention,
};

export function reduceHostedState(state: HostedRuntimeState, operation: HostedStateOperation): HostedRuntimeState {
	return applyReducer(state, operation.type, operation);
}

function applyReducer<Type extends HostedStateOperation["type"]>(
	state: HostedRuntimeState,
	type: Type,
	operation: HostedOperationByType[Type],
): HostedRuntimeState {
	return reducers[type](state, operation);
}
