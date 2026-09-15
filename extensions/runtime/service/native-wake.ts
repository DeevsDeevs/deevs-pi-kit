import { type HostedAgentTarget, type HostedRuntimeState, isAgentTarget, isHeld } from "../schemas/state.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "./identity.ts";
import { unreadMailEvents } from "./messaging.ts";
import type { HostedStateStore } from "./state.ts";

const WAKE_COOLDOWN_MS = 30_000;
/** A tab that ignores the same mail three times is not going to read it; more prompts only burn its context. */
const MAX_WAKES_PER_MESSAGE = 3;
/** A tab that is not busy: `done` is a finished turn nobody has looked at yet, and a prompt is exactly how one follows it up. */
const RESTING_STATUSES = new Set<HostedLiveAgent["agentStatus"]>(["idle", "done"]);

/** One native tab holding a participant with unread mail, and the prompt that would wake it. */
interface PendingWake {
	targetKey: string;
	agentName: string;
	eventId: string;
	text: string;
}

/** The last wake attempted for a target: the cooldown and the cap apply only while that same message is the newest unread one. */
interface WakeAttempt {
	eventId: string;
	at: number;
	delivered: number;
}

/**
 * A native collaborator has no heartbeat to carry a mail hint, so the daemon nudges its tab instead:
 * at most one short prompt per target per 30 s and three per newest message, only for a tab that was issued
 * a mail namespace, only while `herdr agent get` reports `idle` or `done`, and only while the mail is still
 * unread. The prompt names the sender; it never carries a body, never proves the agent acted, and may land
 * on a partially typed line.
 */
export class NativeWakeSweeper {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly now: () => number;
	private readonly attempts = new Map<string, WakeAttempt>();
	private sweeping = false;

	constructor(store: HostedStateStore, host: HostedHostVerifier, now: () => number = Date.now) {
		this.store = store;
		this.host = host;
		this.now = now;
	}

	/** Fire-and-forget entry point for the interval and for a fresh publication; it never throws. */
	trigger(): void {
		void this.sweep().catch(() => {});
	}

	async sweep(): Promise<void> {
		if (this.sweeping || !this.host.promptAgent) return;
		this.sweeping = true;
		try {
			for (const wake of this.pending()) await this.prompt(wake);
		} finally {
			this.sweeping = false;
		}
	}

	private pending(): PendingWake[] {
		const state = this.store.read();
		return Object.values(state.targets)
			.filter(isAgentTarget)
			.flatMap((target) => this.pendingWake(state, target) ?? []);
	}

	private pendingWake(state: HostedRuntimeState, target: HostedAgentTarget): PendingWake | undefined {
		const participant = state.participants[target.participantKey];
		if (!isHeld(participant?.state) || participant.holderTargetKey !== target.targetKey) return undefined;
		if (!hasMailNamespace(state, target.targetKey)) return undefined;
		const newest = unreadMailEvents(state, target.participantKey).at(-1);
		const from = newest ? state.participants[newest.source.id]?.participantId : undefined;
		if (newest === undefined || from === undefined) return undefined;
		const last = this.attempts.get(target.targetKey);
		if (last?.eventId === newest.eventId && (last.delivered >= MAX_WAKES_PER_MESSAGE || this.now() - last.at < WAKE_COOLDOWN_MS)) return undefined;
		return { targetKey: target.targetKey, agentName: target.agentName, eventId: newest.eventId, text: wakeText(from) };
	}

	private async prompt(wake: PendingWake): Promise<void> {
		try {
			const live = await this.host.getAgent(wake.agentName);
			if (!RESTING_STATUSES.has(live.agentStatus)) return;
			// The attempt is recorded before delivery, so an undelivered prompt still waits its full turn.
			const last = this.attempts.get(wake.targetKey);
			const attempt = { eventId: wake.eventId, at: this.now(), delivered: last?.eventId === wake.eventId ? last.delivered : 0 };
			this.attempts.set(wake.targetKey, attempt);
			await this.host.promptAgent?.(wake.agentName, wake.text);
			attempt.delivered += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown failure";
			process.stderr.write(`${JSON.stringify({ status: "wake_skipped", agent: wake.agentName, message: message.slice(0, 200) })}\n`);
		}
	}

}

/** Without an issued namespace the tab has no `collaborator_inbox` to call, so a wake could only waste its turn. */
function hasMailNamespace(state: HostedRuntimeState, targetKey: string): boolean {
	return Object.values(state.messaging).some(grant => grant.targetKey === targetKey && grant.status === "active");
}

function wakeText(from: string): string {
	return `Mail from ${from}: call collaborator_inbox, do what it asks, answer with collaborator_reply.`;
}
