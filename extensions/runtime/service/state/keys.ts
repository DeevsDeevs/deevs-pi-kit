import { createHash } from "node:crypto";
import type { HostedTarget } from "../../schemas/state.ts";

export function deriveParticipantKey(projectRoot: string, protocol: string, participantId: string): string {
	const digest = createHash("sha256").update(projectRoot).update("\0").update(protocol).update("\0").update(participantId).digest("hex");
	return `participant_${digest}`;
}

/** A Pi session ID is unique on its own; a Herdr agent name is only unique within one project. */
export function piTargetKey(piSessionId: string): string {
	return `pi_${piSessionId}`;
}

/** One runtime root serves every project, so per-project names carry this discriminator. */
export function projectScope(projectRoot: string): string {
	return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

export function deriveAgentTargetKey(projectRoot: string, agentName: string): string {
	return `agent_${projectScope(projectRoot)}_${agentName}`;
}

export function targetIdentityKey(target: HostedTarget): string {
	switch (target.kind) {
		case "pi": return piTargetKey(target.piSessionId);
		case "agent": return deriveAgentTargetKey(target.projectRoot, target.agentName);
		default: {
			const unreachable: never = target;
			throw new Error(`Unsupported runtime target ${JSON.stringify(unreachable)}.`);
		}
	}
}

export function mailboxDedupeKey(senderParticipantKey: string, sendId: string): string {
	return `mailbox:${senderParticipantKey}:${sendId}`;
}

export function messagingSendId(namespaceId: string, operationId: string): string {
	return `mcp_${createHash("sha256").update(JSON.stringify([namespaceId, operationId])).digest("hex")}`;
}

export function messagingConfigurationHash(target: HostedTarget): string {
	return createHash("sha256").update(JSON.stringify(targetIdentity(target))).digest("hex");
}

function targetIdentity(target: HostedTarget): Array<string | null> {
	switch (target.kind) {
		case "pi": return [target.projectRoot, target.piSessionId, target.piSessionFile, target.worktreePath ?? null];
		case "agent": return [target.projectRoot, target.agentName, target.driver, target.worktreePath ?? null];
		default: {
			const unreachable: never = target;
			throw new Error(`Unsupported runtime target ${JSON.stringify(unreachable)}.`);
		}
	}
}
