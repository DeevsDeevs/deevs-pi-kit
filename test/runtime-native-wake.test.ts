import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrAgentStatus } from "../extensions/runtime/schemas/herdr.ts";
import type { HostedAgentTarget, HostedMessagingGrant, HostedTarget } from "../extensions/runtime/schemas/state.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/herdr-cli.ts";
import { NativeWakeSweeper } from "../extensions/runtime/service/native-wake.ts";
import { HostedStateStore, deriveParticipantKey, messagingConfigurationHash } from "../extensions/runtime/service/state.ts";

const PROJECT_ROOT = "/tmp/native-wake-project";
const NATIVE = deriveParticipantKey(PROJECT_ROOT, "proof", "native");
const PEER = deriveParticipantKey(PROJECT_ROOT, "proof", "peer");
const CALLER = deriveParticipantKey(PROJECT_ROOT, "proof", "caller");
const NATIVE_EVENT = "evt_native";
const PEER_EVENT = "evt_peer";
const EXPECTED_PROMPT = "Message from caller: native wake proof";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface RecordedPrompt {
	agentName: string;
	text: string;
}

/** Records every wake instead of touching Herdr, and reports whatever status the test chose. */
class RecordingHost implements HostedHostVerifier {
	status: HerdrAgentStatus | undefined = "idle";
	stateSeq: number | undefined;
	absent = false;
	readonly prompts: RecordedPrompt[] = [];

	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		if (this.absent) throw new Error("Herdr reports no such agent.");
		return { name: agentName, cwd: PROJECT_ROOT, agentStatus: this.status, stateSeq: this.stateSeq };
	}

	async promptAgent(agentName: string, text: string): Promise<void> {
		this.prompts.push({ agentName, text });
	}
}

function piTarget(sessionId: string): HostedTarget {
	return {
		kind: "pi",
		targetKey: `pi_${sessionId}`,
		projectRoot: PROJECT_ROOT,
		piSessionId: sessionId,
		piSessionFile: `/tmp/${sessionId}.jsonl`,
		createdAt: 100,
	};
}

function agentTarget(): HostedAgentTarget {
	return {
		kind: "agent",
		targetKey: "agent_native",
		projectRoot: PROJECT_ROOT,
		agentName: "collab-native",
		driver: "claude-code",
		participantKey: NATIVE,
		holderGeneration: "lease_native",
		profile: "read-only",
		herdr: { tabId: "w1:t1", workspaceId: "w1" },
		createdAt: 100,
	};
}

/** One held native collaborator and one held Pi peer, each with exactly one unread message from the caller. */
function setup(issued = true) {
	const root = mkdtempSync(join(tmpdir(), "native-wake-"));
	roots.push(root);
	const store = new HostedStateStore(root);
	store.apply({ type: "target.ensure", target: piTarget("caller") });
	store.apply({ type: "target.ensure", target: piTarget("peer") });
	store.apply({ type: "target.ensure", target: agentTarget() });
	acquire(store, CALLER, "caller", "pi_caller");
	acquire(store, PEER, "peer", "pi_peer");
	acquire(store, NATIVE, "native", "agent_native");
	const namespaceId = issued ? issueNamespace(store) : undefined;
	mail(store, NATIVE, NATIVE_EVENT);
	mail(store, PEER, PEER_EVENT);
	let now = 1000;
	const host = new RecordingHost();
	const sweeper = new NativeWakeSweeper(store, host, () => now);
	return { store, host, sweeper, namespaceId, advance(ms: number) { now += ms; }, at() { return now; } };
}

/** Issues the native collaborator's mail namespace exactly as the launching Pi session does after the bind. */
function issueNamespace(store: HostedStateStore): string {
	const grant: HostedMessagingGrant = {
		namespaceId: `msg_${randomUUID()}`,
		secretDigest: "a".repeat(64),
		participantKey: NATIVE,
		holderGeneration: "lease_native",
		targetKey: "agent_native",
		configurationHash: messagingConfigurationHash(agentTarget()),
		createdAt: 900,
		status: "active",
		operations: {},
	};
	store.apply({ type: "messaging.issue", grant });
	return grant.namespaceId;
}

function acquire(store: HostedStateStore, participantKey: string, participantId: string, targetKey: string): void {
	store.apply({
		type: "participant.acquire",
		participantKey,
		projectRoot: PROJECT_ROOT,
		protocol: "proof",
		participantId,
		targetKey,
		generation: targetKey === "agent_native" ? "lease_native" : `lease_${participantId}`,
		at: 100,
	});
}

function mail(store: HostedStateStore, recipientParticipantKey: string, eventId: string): void {
	store.apply({
		type: "mailbox.send",
		senderParticipantKey: CALLER,
		expectedSenderGeneration: "lease_caller",
		senderTargetKey: "pi_caller",
		recipientParticipantKey,
		sendId: `send_${eventId}`,
		eventId,
		body: "native wake proof",
		at: 500,
	});
}

/** Marks the native collaborator's message read exactly as its own MCP receipt would. */
function markRead(store: HostedStateStore, namespaceId: string, at: number): void {
	store.apply({ type: "messaging.read", namespaceId, eventIds: [NATIVE_EVENT], at });
}

describe("native wake", () => {
	it("prompts an idle native holder once and never the Pi holder of the same unread mail", async () => {
		const test = setup();
		await test.sweeper.sweep();
		expect(test.host.prompts).toEqual([{ agentName: "collab-native", text: EXPECTED_PROMPT }]);
	});

	it("prompts a finished or undetected tab exactly like an idle one", async () => {
		for (const status of ["done", "unknown", undefined] as const) {
			const test = setup();
			test.host.status = status;
			await test.sweeper.sweep();
			expect(test.host.prompts).toEqual([{ agentName: "collab-native", text: EXPECTED_PROMPT }]);
		}
	});

	it("holds mail for a working tab and delivers it all in one prompt at its next idle", async () => {
		const test = setup();
		test.host.status = "working";
		await test.sweeper.sweep();
		mail(test.store, NATIVE, "evt_native_2");
		await test.sweeper.sweep();
		expect(test.host.prompts).toEqual([]);
		test.host.status = "idle";
		await test.sweeper.sweep();
		expect(test.host.prompts).toEqual([{ agentName: "collab-native", text: `${EXPECTED_PROMPT} ${EXPECTED_PROMPT}` }]);
	});

	it("does not prompt a tab blocked on a human prompt", async () => {
		const test = setup();
		test.host.status = "blocked";
		await test.sweeper.sweep();
		expect(test.host.prompts).toEqual([]);
	});

	it("does not prompt an agent Herdr no longer reports", async () => {
		const test = setup();
		test.host.absent = true;
		await test.sweeper.sweep();
		expect(test.host.prompts).toEqual([]);
	});

	it("marks what it prompted read, so the same message is never typed twice", async () => {
		const test = setup();
		await test.sweeper.sweep();
		test.advance(30_000);
		await test.sweeper.sweep();
		expect(test.host.prompts).toHaveLength(1);
		expect(test.store.read().events[NATIVE_EVENT]?.readAt).toBe(1000);
	});

	it("with Herdr's status count, marks mail read only once the tab took a turn, and retries a dropped prompt", async () => {
		const test = setup();
		test.host.stateSeq = 4;
		await test.sweeper.sweep();
		test.advance(30_000);
		await test.sweeper.sweep();
		expect(test.host.prompts).toHaveLength(2);
		expect(test.store.read().events[NATIVE_EVENT]?.readAt).toBeUndefined();
		test.advance(30_000);
		await test.sweeper.sweep();
		test.advance(30_000);
		await test.sweeper.sweep();
		expect(test.host.prompts).toHaveLength(3);
		test.host.stateSeq = 6;
		await test.sweeper.sweep();
		expect(test.store.read().events[NATIVE_EVENT]?.readAt).toBe(test.at());
		expect(test.host.prompts).toHaveLength(3);
	});

	it("wakes again at once for newer mail", async () => {
		const test = setup();
		await test.sweeper.sweep();
		test.advance(1_000);
		mail(test.store, NATIVE, "evt_native_2");
		await test.sweeper.sweep();
		expect(test.host.prompts).toHaveLength(2);
	});

	it("keeps the namespace readable and writable after a clock jump past any former lifetime", () => {
		const test = setup();
		const later = 900 + 365 * 24 * 60 * 60 * 1_000;
		markRead(test.store, test.namespaceId!, later);
		const reply = { namespaceId: test.namespaceId!, operationId: "op_late", recipientParticipantKey: CALLER, body: "still here", eventId: "evt_late", at: later };
		test.store.apply({ type: "messaging.send", ...reply });
		expect(test.store.read().events.evt_late?.source.id).toBe(NATIVE);
	});

	it("never prompts a tab that was not issued a mail namespace", async () => {
		const test = setup(false);
		await test.sweeper.sweep();
		test.advance(30_000);
		await test.sweeper.sweep();
		expect(test.host.prompts).toEqual([]);
	});

	it("sweeps on a publication trigger without throwing out of it", async () => {
		const test = setup();
		test.sweeper.trigger();
		await vi.waitFor(() => expect(test.host.prompts).toHaveLength(1));
	});

	it("does nothing when the host cannot prompt at all", async () => {
		const test = setup();
		const store = test.store;
		const quiet = new NativeWakeSweeper(store, { async getAgent() { return { cwd: PROJECT_ROOT }; } }, () => 1000);
		await expect(quiet.sweep()).resolves.toBeUndefined();
	});
});
