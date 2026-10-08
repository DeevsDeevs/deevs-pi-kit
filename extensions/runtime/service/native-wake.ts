import { type HostedAgentTarget, type HostedMailboxMessageEvent, type HostedRuntimeState, isAgentTarget, holds } from "../schemas/state.ts";
import type { HostedHostVerifier } from "./herdr-cli.ts";
import { unreadMailEvents } from "./messaging.ts";
import type { HostedStateStore } from "./state.ts";

/** One native tab holding a participant with unread mail, and the namespace its reply goes out from. */
interface PendingWake {
	namespaceId: string;
	events: HostedMailboxMessageEvent[];
}

/** What the tab was typed and not yet seen to take, and Herdr's status-change count when it was typed. */
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
 * coalesce into one delivery at its next idle. Typed mail is marked read, at the time it was typed, once the tab sends
 * a message of its own or Herdr's status-change count shows it took a turn; until then newer mail is typed alone and
 * the whole lot is typed again every 30 s, three times at most, after which it counts as read. A Herdr without that
 * count gets read-on-prompt. A tab blocked on a human prompt is left alone.
 */
export class NativeWakeSweeper {
	private readonly store: HostedStateStore;
	private readonly host: HostedHostVerifier;
	private readonly now: () => number;
	private readonly prompted = new Map<string, Prompted>();
	private sweeping = false;
	private again = false;

	constructor(store: HostedStateStore, host: HostedHostVerifier, now: () => number = Date.now) {
		this.store = store;
		this.host = host;
		this.now = now;
	}

	/** Fire-and-forget entry point for the interval and for a fresh publication; it never throws. */
	trigger(): void {
		void this.sweep().catch(() => {});
	}

	/** A tab that sends has taken what it was typed, as a Pi's send acknowledges the mail its session holds. */
	published(namespaceId: string): void {
		for (const [agentName, last] of this.prompted) if (last.namespaceId === namespaceId) this.markRead(agentName, last);
		this.trigger();
	}

	/** A trigger during a sweep runs one more pass, so mail sent meanwhile does not wait for the next interval. */
	async sweep(): Promise<void> {
		if (!this.host.promptAgent) return;
		if (this.sweeping) {
			this.again = true;
			return;
		}
		this.sweeping = true;
		try {
			do {
				this.again = false;
				const state = this.store.read();
				for (const target of Object.values(state.targets).filter(isAgentTarget)) {
					if (pendingWake(state, target)) await this.prompt(target);
				}
			} while (this.again);
		} finally {
			this.sweeping = false;
		}
	}

	private markRead(agentName: string, last: Prompted): void {
		this.prompted.delete(agentName);
		try {
			this.store.apply({ type: "messaging.read", namespaceId: last.namespaceId, eventIds: last.eventIds, at: last.at });
		} catch {}
	}

	private async prompt(target: HostedAgentTarget): Promise<void> {
		const { agentName } = target;
		try {
			const live = await this.host.getAgent(agentName);
			const seen = this.prompted.get(agentName);
			if (seen && live.stateSeq !== undefined && live.stateSeq > seen.seq) this.markRead(agentName, seen);
			if (live.ready === false || live.agentStatus === "working" || live.agentStatus === "blocked") return;
			// Built now, not at the sweep's start: mail sent while earlier tabs were prompted goes out in this prompt.
			const wake = pendingWake(this.store.read(), target);
			if (!wake) return;
			const last = this.prompted.get(agentName);
			const typed = last?.namespaceId === wake.namespaceId ? last : undefined;
			const fresh = wake.events.filter((event) => !typed?.eventIds.includes(event.eventId));
			if (typed && fresh.length === 0) {
				if (this.now() - typed.at < RETRY_MS) return;
				if (typed.count >= MAX_PROMPTS) return this.markRead(agentName, typed);
			}
			const events = fresh.length > 0 ? fresh : wake.events;
			await this.host.promptAgent?.(agentName, promptText(this.store.read(), events));
			const eventIds = events.map((event) => event.eventId);
			if (live.stateSeq === undefined) {
				this.store.apply({ type: "messaging.read", namespaceId: wake.namespaceId, eventIds, at: this.now() });
				return;
			}
			const count = !typed ? 1 : fresh.length > 0 ? typed.count : typed.count + 1;
			this.prompted.set(agentName, { namespaceId: wake.namespaceId, eventIds: [...new Set([...(typed?.eventIds ?? []), ...eventIds])], seq: live.stateSeq, at: this.now(), count });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown failure";
			process.stderr.write(`${JSON.stringify({ status: "wake_skipped", agent: agentName, message: message.slice(0, 200) })}\n`);
		}
	}
}

function pendingWake(state: HostedRuntimeState, target: HostedAgentTarget): PendingWake | undefined {
	const participant = state.participants[target.participantKey];
	if (!holds(participant, target.targetKey)) return undefined;
	// Without an issued namespace the tab has no SendMessage to answer with.
	const grant = Object.values(state.messaging).find((candidate) => candidate.targetKey === target.targetKey && candidate.status === "active");
	const events = unreadMailEvents(state, target.participantKey);
	if (!grant || events.length === 0) return undefined;
	return { namespaceId: grant.namespaceId, events };
}

// ponytail: Herdr submits the prompt as one line, so each body's whitespace collapses; a file path carries anything longer.
function promptText(state: HostedRuntimeState, events: HostedMailboxMessageEvent[]): string {
	return events.map((event) => `Message from ${state.participants[event.source.id]?.participantId ?? "unknown"}: ${event.body.replace(/\s+/gu, " ").trim()}`).join(" ");
}
