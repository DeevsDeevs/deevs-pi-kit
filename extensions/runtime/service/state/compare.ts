import { type HostedMonitor, type HostedTarget, isAgentTarget, isPiTarget } from "../../hosted-types.ts";

export function sameTarget(left: HostedTarget, right: HostedTarget): boolean {
	if (left.kind !== right.kind || left.targetKey !== right.targetKey || left.projectRoot !== right.projectRoot) return false;
	if (isPiTarget(left) && isPiTarget(right)) {
		return left.piSessionId === right.piSessionId
			&& left.piSessionFile === right.piSessionFile
			&& left.worktreePath === right.worktreePath;
	}
	if (isAgentTarget(left) && isAgentTarget(right)) {
		return left.agentName === right.agentName
			&& left.driver === right.driver
			&& left.participantKey === right.participantKey
			&& left.holderGeneration === right.holderGeneration
			&& left.profile === right.profile
			&& left.worktreePath === right.worktreePath;
	}
	return false;
}

export function sameMonitorIdentity(left: HostedMonitor, right: HostedMonitor): boolean {
	return left.monitorId === right.monitorId
		&& left.targetKey === right.targetKey
		&& left.directory === right.directory
		&& left.settleMs === right.settleMs;
}
