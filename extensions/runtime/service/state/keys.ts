import { createHash } from "node:crypto";
import type { HostedTarget } from "../../hosted-types.ts";

export function deriveParticipantKey(projectRoot: string, protocol: string, participantId: string): string {
	const digest = createHash("sha256").update(projectRoot).update("\0").update(protocol).update("\0").update(participantId).digest("hex");
	return `participant_${digest}`;
}

export function deriveAgentTargetKey(projectRoot: string, agentName: string): string {
	return `agent_${createHash("sha256").update(projectRoot).update("\0").update(agentName).digest("hex")}`;
}

export function mailboxDedupeKey(senderParticipantKey: string, sendId: string): string {
	return `mailbox:${senderParticipantKey}:${sendId}`;
}

export function messagingSendId(namespaceId: string, operationId: string): string {
	return `mcp_${createHash("sha256").update(JSON.stringify([namespaceId, operationId])).digest("hex")}`;
}

export function messagingConfigurationHash(target: HostedTarget): string {
	const identity = target.kind === "pi"
		? [target.projectRoot, target.piSessionId, target.piSessionFile, target.worktreePath ?? null]
		: [target.projectRoot, target.agentName, target.driver, target.clientGeneration, target.worktreePath ?? null];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
