import { type HostedAgentTarget, type HostedRuntimeState, isAgentTarget, isHeld } from "../schemas/state.ts";
import type { HostedHostVerifier } from "./identity.ts";
import { unreadMailEvents } from "./messaging.ts";
import type { HostedStateStore } from "./state.ts";

const WAKE_COOLDOWN_MS = 30_000;

/** One native tab holding a participant with unread mail, and the prompt that would wake it. */
interface PendingWake {
	targetKey: string;
	agentName: string;
	text: string;
}

/**
 * A native collaborator has no heartbeat to carry a mail hint, so the daemon nudges its tab instead:
 * at most one short prompt per target per 30 s, only while `herdr agent get` reports `idle`, and only
 * while the mail is still unread. The prompt names the event; it never carries a body, never proves the
 * agent acted, and may land on a partially typed line.
 */
export class NativeWakeSweeper {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly now: () => number;
	private readonly lastPromptedAt = new Map<string, number>();
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
		const unread = unreadMailEvents(state, target.participantKey);
		const newest = unread.at(-1);
		const from = newest ? state.participants[newest.source.id]?.participantId : undefined;
		if (!newest || from === undefined) return undefined;
		return { targetKey: target.targetKey, agentName: target.agentName, text: wakeText(unread.length, newest.eventId, from) };
	}

	private async prompt(wake: PendingWake): Promise<void> {
		try {
			const live = await this.host.getAgent(wake.agentName);
			if (live.agentStatus !== "idle") return;
			// The cooldown is recorded before delivery, so an undelivered prompt still waits its full turn.
			this.lastPromptedAt.set(wake.targetKey, this.now());
			await this.host.promptAgent?.(wake.agentName, wake.text);
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

function wakeText(unread: number, eventId: string, participantId: string): string {
	return `Mail from ${participantId} (${unread} unread, newest ${eventId}).`
		+ " Read it with collaborator_inbox and collaborator_receive, do what it asks, and answer with collaborator_reply."
		+ " Keep narration to one line.";
}
