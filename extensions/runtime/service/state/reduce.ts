import type { HostedRuntimeState, HostedStateOperation } from "../../hosted-types.ts";
import {
	ackClaim,
	acceptWake,
	claimInboxEvents,
	clearWake,
	pruneRetention,
	reconcileClaim,
	reconcileClaims,
	releaseExpiredClaims,
	releaseInboxClaim,
	setWake,
} from "./inbox.ts";
import { sendMailboxMessage } from "./mailbox.ts";
import {
	expireMessagingGrant,
	issueMessagingGrant,
	markMessagingEventRead,
	publishMessagingEvent,
} from "./messaging.ts";
import { commitMonitor, createMonitor, deleteMonitor } from "./monitors.ts";
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
	"monitor.create": createMonitor,
	"monitor.delete": deleteMonitor,
	"monitor.commit": commitMonitor,
	"participant.acquire": acquireParticipant,
	"participant.stand_down": standDownParticipant,
	"participant.release": releaseParticipant,
	"participant.worktree.clear": clearParticipantWorktree,
	"participant.takeover": takeoverParticipant,
	"mailbox.send": sendMailboxMessage,
	"inbox.claim": claimInboxEvents,
	"inbox.ack": ackClaim,
	"inbox.reconcile": reconcileClaim,
	"inbox.reconcile_many": reconcileClaims,
	"inbox.release": releaseInboxClaim,
	"inbox.release_expired": releaseExpiredClaims,
	"retention.prune": pruneRetention,
	"wake.set": setWake,
	"wake.accept": acceptWake,
	"wake.clear": clearWake,
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
