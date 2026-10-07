import { type HostedAgentTarget, type HostedRuntimeState, isAgentTarget, holds } from "../schemas/state.ts";
import type { HostedHostVerifier } from "./herdr-cli.ts";
import { unreadMailEvents } from "./messaging.ts";
import type { HostedStateStore } from "./state.ts";

/** One native tab holding a participant with unread mail, and the prompt that carries it. */
interface PendingWake {
	agentName: string;
	namespaceId: string;
	eventIds: string[];
	text: string;
}

/** What one prompt carried, and Herdr's status-change count when it was typed. */
interface Prompted {
	namespaceId: string;
	eventIds: string[];
	seq: number;
	at: number;
	count: number;
}

const RETRY_MS = 30_000;
/** A tab that ignores the same mail three times is not going to read it; more prompts only burn its context. */
const MAX_PROMPTS = 3;

/**
 * A native collaborator has no heartbeat, so the daemon types its mail into its tab: every unread message in one
 * `herdr agent prompt`, sent only while `herdr agent get` reports the tab idle, so messages sent during a turn
 * coalesce into one delivery at its next idle. The messages are marked read once Herdr's status-change count shows
 * the tab took a turn after the prompt; until then the prompt is repeated every 30 s, three times at most. A Herdr
 * without that count gets read-on-prompt. A tab blocked on a human prompt is left alone.
 */
export class NativeWakeSweeper {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly now: () => number;
	private readonly prompted = new Map<string, Prompted>();
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
			.flatMap((target) => pendingWake(state, target) ?? []);
	}

	private async prompt(wake: PendingWake): Promise<void> {
		try {
			const live = await this.host.getAgent(wake.agentName);
			const last = this.prompted.get(wake.agentName);
			if (last && live.stateSeq !== undefined && live.stateSeq > last.seq) {
				this.prompted.delete(wake.agentName);
				this.store.apply({ type: "messaging.read", namespaceId: last.namespaceId, eventIds: last.eventIds, at: this.now() });
				return;
			}
			if (live.ready === false || live.agentStatus === "working" || live.agentStatus === "blocked") return;
			const same = last?.eventIds.join() === wake.eventIds.join();
			if (same && (last.count >= MAX_PROMPTS || this.now() - last.at < RETRY_MS)) return;
			await this.host.promptAgent?.(wake.agentName, wake.text);
			if (live.stateSeq === undefined) {
				this.store.apply({ type: "messaging.read", namespaceId: wake.namespaceId, eventIds: wake.eventIds, at: this.now() });
				return;
			}
			this.prompted.set(wake.agentName, { namespaceId: wake.namespaceId, eventIds: wake.eventIds, seq: live.stateSeq, at: this.now(), count: same ? last.count + 1 : 1 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown failure";
			process.stderr.write(`${JSON.stringify({ status: "wake_skipped", agent: wake.agentName, message: message.slice(0, 200) })}\n`);
		}
	}
}

function pendingWake(state: HostedRuntimeState, target: HostedAgentTarget): PendingWake | undefined {
	const participant = state.participants[target.participantKey];
	if (!holds(participant, target.targetKey)) return undefined;
	// Without an issued namespace the tab has no SendMessage to answer with.
	const grant = Object.values(state.messaging).find((candidate) => candidate.targetKey === target.targetKey && candidate.status === "active");
	const unread = unreadMailEvents(state, target.participantKey);
	if (!grant || unread.length === 0) return undefined;
	// ponytail: Herdr submits the prompt as one line, so each body's whitespace collapses; a file path carries anything longer.
	const text = unread.map((event) => `Message from ${state.participants[event.source.id]?.participantId ?? "unknown"}: ${event.body.replace(/\s+/gu, " ").trim()}`).join(" ");
	return { agentName: target.agentName, namespaceId: grant.namespaceId, eventIds: unread.map((event) => event.eventId), text };
}
