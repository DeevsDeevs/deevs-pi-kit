import type { HostedClaim, HostedMonitor, HostedTarget, HostedWake } from "../../hosted-types.ts";

export function sameTarget(left: HostedTarget, right: HostedTarget): boolean {
	if (left.kind !== right.kind || left.targetKey !== right.targetKey || left.projectRoot !== right.projectRoot) return false;
	if (left.kind === "pi" && right.kind === "pi") {
		return left.piSessionId === right.piSessionId
			&& left.piSessionFile === right.piSessionFile
			&& left.worktreePath === right.worktreePath;
	}
	if (left.kind === "agent" && right.kind === "agent") {
		return left.agentName === right.agentName
			&& left.driver === right.driver
			&& JSON.stringify(left.agentSession) === JSON.stringify(right.agentSession)
			&& left.participantKey === right.participantKey
			&& left.holderGeneration === right.holderGeneration
			&& left.profile === right.profile
			&& left.clientGeneration === right.clientGeneration
			&& left.worktreePath === right.worktreePath
			&& JSON.stringify(left.herdr) === JSON.stringify(right.herdr);
	}
	return false;
}

export function sameMonitorIdentity(left: HostedMonitor, right: HostedMonitor): boolean {
	return left.monitorId === right.monitorId
		&& left.targetKey === right.targetKey
		&& left.generation === right.generation
		&& left.directory === right.directory
		&& left.settleMs === right.settleMs;
}

export function sameClaim(left: HostedClaim, right: HostedClaim): boolean {
	return left.claimId === right.claimId
		&& left.targetKey === right.targetKey
		&& left.registrationId === right.registrationId
		&& left.clientGeneration === right.clientGeneration
		&& sameIds(left.eventIds, right.eventIds);
}

export function sameWake(left: HostedWake, right: HostedWake): boolean {
	return left.wakeId === right.wakeId
		&& left.targetKey === right.targetKey
		&& left.registrationId === right.registrationId
		&& left.createdAt === right.createdAt;
}

export function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const leftSorted = [...left].sort();
	const rightSorted = [...right].sort();
	return leftSorted.every((value, index) => value === rightSorted[index]);
}
