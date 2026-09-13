import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listMissionSnapshots } from "./persistence.ts";
import { MissionState } from "./state.ts";
import type { MissionTakeoverCandidate } from "./types.ts";

// Cheap hint/guard listing for hot paths (mission_get, mission_create): reads only the small validated snapshots, never opens or replays session files. Marks usageComplete=false so any takeover attempted from a hint still fails closed on bounded budgets until the full scan derives exact usage.
export function listSnapshotTakeoverCandidates(ctx: ExtensionContext): MissionTakeoverCandidate[] {
	const currentSessionId = ctx.sessionManager.getSessionId();
	return listMissionSnapshots(ctx.cwd)
		.filter((snapshot) => snapshot.owner.sessionId !== currentSessionId && !["complete", "ended", "cleared"].includes(snapshot.mission.status))
		.map((snapshot) => ({ snapshot: { ...snapshot, usageComplete: false }, source: "snapshot" as const }))
		.sort((a, b) => b.snapshot.mission.updatedAt - a.snapshot.mission.updatedAt);
}

export async function discoverMissionTakeoverCandidates(ctx: ExtensionContext): Promise<MissionTakeoverCandidate[]> {
	const currentSessionId = ctx.sessionManager.getSessionId();
	const sessions = (await SessionManager.list(ctx.cwd)).filter((session) => session.cwd === ctx.cwd);
	const sessionsByPath = new Map(sessions.map((session) => [session.path, session]));
	const snapshots = listMissionSnapshots(ctx.cwd).filter((snapshot) => snapshot.owner.sessionId !== currentSessionId && !["complete", "ended", "cleared"].includes(snapshot.mission.status));
	const candidates: MissionTakeoverCandidate[] = [];

	for (const snapshot of snapshots) {
		let current = { ...snapshot, usageComplete: false };
		const sourceSession = sessionsByPath.get(snapshot.owner.sessionFile);
		try {
			if (sourceSession?.id === snapshot.owner.sessionId) {
				const manager = SessionManager.open(sourceSession.path);
				const state = new MissionState();
				state.loadFromSession({ ...ctx, sessionManager: manager });
				// Do not force usageComplete: a full replay of a readable source is complete only if the snapshot it restored was itself complete. Forcing true would let carried incompleteness (from an earlier takeover of an unreadable source) silently pass the bounded-budget gate.
				if (state.readAny()?.missionId === snapshot.mission.missionId) current = state.exportSnapshot(snapshot.owner);
			}
		} catch {
			// The canonical checkpoint remains usable, but bounded usage may be incomplete.
		}
		candidates.push({ snapshot: current, source: "snapshot" });
	}
	return candidates.sort((a, b) => b.snapshot.mission.updatedAt - a.snapshot.mission.updatedAt);
}

export function selectMissionTakeoverCandidate(candidates: MissionTakeoverCandidate[], selector: string): MissionTakeoverCandidate {
	const target = selector.trim();
	if (!target) {
		if (candidates.length !== 1) throw new Error(candidates.length ? `Specify one Mission id: ${candidates.map((candidate) => candidate.snapshot.mission.missionId).join(", ")}` : "No Mission is available for takeover in this workspace.");
		return candidates[0]!;
	}
	const matches = candidates.filter((candidate) => candidate.snapshot.mission.missionId === target || candidate.snapshot.mission.slug === target);
	if (matches.length !== 1) throw new Error(matches.length ? `Mission ${target} has ambiguous legacy session branches; resume the intended source session first.` : `Mission not found for takeover: ${target}`);
	return matches[0]!;
}
