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

interface WakeTally {
	eventId: string;
	count: number;
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
	private readonly lastPromptedAt = new Map<string, number>();
	private readonly tallies = new Map<string, WakeTally>();
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
			.filter((target) => this.cooldownElapsed(target.targetKey))
			.flatMap((target) => this.pendingWake(state, target) ?? []);
	}

	private pendingWake(state: HostedRuntimeState, target: HostedAgentTarget): PendingWake | undefined {
		const participant = state.participants[target.participantKey];
		if (!isHeld(participant?.state) || participant.holderTargetKey !== target.targetKey) return undefined;
		if (!hasMailNamespace(state, target.targetKey)) return undefined;
		const newest = unreadMailEvents(state, target.participantKey).at(-1);
		const from = newest ? state.participants[newest.source.id]?.participantId : undefined;
		if (newest === undefined || from === undefined) return undefined;
		const tally = this.tallies.get(target.targetKey);
		if (tally?.eventId === newest.eventId && tally.count >= MAX_WAKES_PER_MESSAGE) return undefined;
		return { targetKey: target.targetKey, agentName: target.agentName, eventId: newest.eventId, text: wakeText(from) };
	}

	private async prompt(wake: PendingWake): Promise<void> {
		try {
			const live = await this.host.getAgent(wake.agentName);
			if (!RESTING_STATUSES.has(live.agentStatus)) return;
			// The cooldown is recorded before delivery, so an undelivered prompt still waits its full turn.
			this.lastPromptedAt.set(wake.targetKey, this.now());
			await this.host.promptAgent?.(wake.agentName, wake.text);
			const tally = this.tallies.get(wake.targetKey);
			const count = tally?.eventId === wake.eventId ? tally.count + 1 : 1;
			this.tallies.set(wake.targetKey, { eventId: wake.eventId, count });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown failure";
			process.stderr.write(`${JSON.stringify({ status: "wake_skipped", agent: wake.agentName, message: message.slice(0, 200) })}\n`);
		}
	}

	private cooldownElapsed(targetKey: string): boolean {
		const last = this.lastPromptedAt.get(targetKey);
		return last === undefined || this.now() - last >= WAKE_COOLDOWN_MS;
	}
}

/** Without an issued namespace the tab has no `collaborator_inbox` to call, so a wake could only waste its turn. */
function hasMailNamespace(state: HostedRuntimeState, targetKey: string): boolean {
	return Object.values(state.messaging).some(grant => grant.targetKey === targetKey && grant.status === "active");
}

function wakeText(from: string): string {
	return `Mail from ${from}: call collaborator_inbox, do what it asks, answer with collaborator_reply.`;
}
