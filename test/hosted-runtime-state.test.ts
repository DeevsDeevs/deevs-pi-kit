import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTED_ACK_RETENTION_MS, HOSTED_STATE_MAX_BYTES } from "../extensions/runtime/schemas/common.ts";
import type { HostedRuntimeState, HostedTarget } from "../extensions/runtime/schemas/state.ts";
import { RuntimeError } from "../extensions/runtime/errors.ts";
import {
	HostedStateStorageError,
	HostedStateStore,
	deriveParticipantKey,
	emptyHostedRuntimeState,
	loadOrCreateRuntimeInstance,
	readHostedRuntimeState,
	reduceHostedState,
	runtimeStatePaths,
	validateHostedRuntimeState,
	writeHostedRuntimeState,
} from "../extensions/runtime/service/state.ts";

const roots: string[] = [];
const PROJECT_ROOT = "/tmp/project";
const SENDER = deriveParticipantKey(PROJECT_ROOT, "review", "main");
const RECIPIENT = deriveParticipantKey(PROJECT_ROOT, "review", "peer");

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-state-"));
	roots.push(root);
	return root;
}

function target(sessionId = "session-1"): HostedTarget {
	return {
		kind: "pi",
		targetKey: `pi_${sessionId}`,
		projectRoot: PROJECT_ROOT,
		piSessionId: sessionId,
		piSessionFile: `/tmp/${sessionId}.jsonl`,
		createdAt: 100,
	};
}

/** One held sender, one vacant recipient, and one mail event addressed from the first to the second. */
function populatedState(): HostedRuntimeState {
	let state = reduceHostedState(emptyHostedRuntimeState(), { type: "target.ensure", target: target() });
	state = reduceHostedState(state, { type: "target.ensure", target: target("session-2") });
	state = reduceHostedState(state, {
		type: "participant.acquire",
		participantKey: SENDER,
		projectRoot: PROJECT_ROOT,
		protocol: "review",
		participantId: "main",
		targetKey: "pi_session-1",
		generation: "lease_sender",
		at: 100,
	});
	state = reduceHostedState(state, {
		type: "participant.acquire",
		participantKey: RECIPIENT,
		projectRoot: PROJECT_ROOT,
		protocol: "review",
		participantId: "peer",
		targetKey: "pi_session-2",
		generation: "lease_peer",
		at: 100,
	});
	state = reduceHostedState(state, {
		type: "participant.stand_down",
		participantKey: RECIPIENT,
		targetKey: "pi_session-2",
		generation: "lease_peer_2",
		at: 150,
	});
	return reduceHostedState(state, {
		type: "mailbox.send",
		senderParticipantKey: SENDER,
		expectedSenderGeneration: "lease_sender",
		senderTargetKey: "pi_session-1",
		recipientParticipantKey: RECIPIENT,
		sendId: "send_1",
		eventId: "evt_1",
		body: "Please inspect.",
		at: 200,
	});
}

describe("hosted runtime state reducer", () => {
	it("distinguishes idempotent natural-key retries from conflicts", () => {
		const state = reduceHostedState(emptyHostedRuntimeState(), { type: "target.ensure", target: target() });
		expect(reduceHostedState(state, { type: "target.ensure", target: target() })).toBe(state);
		expect(() => reduceHostedState(state, {
			type: "target.ensure",
			target: { ...target(), projectRoot: "/tmp/other" },
		})).toThrow(RuntimeError);
	});

	it("publishes one mail event per send ID and repeats identical input without a second event", () => {
		const state = populatedState();
		expect(state.events.evt_1).toMatchObject({ type: "mailbox.message", recipientParticipantKey: RECIPIENT, body: "Please inspect." });
		expect(state.dedupe[`mailbox:${SENDER}:send_1`]).toBe("evt_1");
		const repeated = reduceHostedState(state, {
			type: "mailbox.send",
			senderParticipantKey: SENDER,
			expectedSenderGeneration: "lease_sender",
			senderTargetKey: "pi_session-1",
			recipientParticipantKey: RECIPIENT,
			sendId: "send_1",
			eventId: "evt_repeat",
			body: "Please inspect.",
			at: 300,
		});
		expect(repeated).toBe(state);
	});

	it("retains mail until its retention window passes, then prunes it with its dedupe key", () => {
		const state = populatedState();
		expect(reduceHostedState(state, { type: "retention.prune", before: 200 }).events.evt_1).toBeDefined();
		const pruned = reduceHostedState(state, { type: "retention.prune", before: 201 });
		expect(pruned.events).toEqual({});
		expect(pruned.dedupe).toEqual({});
	});
});

describe("hosted runtime state persistence", () => {
	it("persists owner-only validated state and a stable runtime identity", () => {
		const root = temporaryRoot();
		const first = loadOrCreateRuntimeInstance(root, () => "rt_fixed");
		const second = loadOrCreateRuntimeInstance(root, () => "rt_other");
		expect(first).toEqual({ version: 1, runtimeId: "rt_fixed" });
		expect(second).toEqual(first);

		const state = populatedState();
		writeHostedRuntimeState(root, state);
		expect(readHostedRuntimeState(root)).toEqual(state);
		expect(statSync(root).mode & 0o777).toBe(0o700);
		expect(statSync(runtimeStatePaths(root).state).mode & 0o777).toBe(0o600);
	});

	it("ignores an uncommitted temporary snapshot and accepts the next committed snapshot", () => {
		const root = temporaryRoot();
		const oldState = populatedState();
		writeHostedRuntimeState(root, oldState);
		writeFileSync(join(root, ".state.v1.json.crash.tmp"), JSON.stringify(emptyHostedRuntimeState()), { mode: 0o600 });
		expect(readHostedRuntimeState(root)).toEqual(oldState);

		const pruned = reduceHostedState(oldState, { type: "retention.prune", before: 201 });
		writeHostedRuntimeState(root, pruned);
		expect(readHostedRuntimeState(root).events).toEqual({});
	});

	it("cleans its temporary file when the atomic rename fails", () => {
		const root = temporaryRoot();
		mkdirSync(runtimeStatePaths(root).state);
		expect(() => writeHostedRuntimeState(root, emptyHostedRuntimeState())).toThrow(HostedStateStorageError);
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("fails closed for malformed, unknown-field, and oversized state", () => {
		const root = temporaryRoot();
		const path = runtimeStatePaths(root).state;
		writeFileSync(path, "{not-json", { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(HostedStateStorageError);

		writeFileSync(path, JSON.stringify({ ...emptyHostedRuntimeState(), surprise: true }), { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(/additional properties.*surprise/);

		writeFileSync(path, Buffer.alloc(HOSTED_STATE_MAX_BYTES + 1, 0x20), { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(/exceeds/);
	});

	/** State is current-only: a superseded version must start the daemon fresh, never wedge it. */
	it("discards a state file written by another state version", () => {
		const root = temporaryRoot();
		const path = runtimeStatePaths(root).state;
		writeHostedRuntimeState(root, populatedState());
		const superseded = { ...populatedState(), version: 1 };
		writeFileSync(path, JSON.stringify(superseded), { mode: 0o600 });
		expect(readHostedRuntimeState(root)).toEqual(emptyHostedRuntimeState());
		expect(readdirSync(root)).toContain("state.v1.json.superseded");
		expect(readHostedRuntimeState(root)).toEqual(emptyHostedRuntimeState());
	});

	it("rejects invalid cross-references rather than repairing them", () => {
		const dangling = structuredClone(populatedState());
		delete dangling.dedupe[dangling.events.evt_1!.dedupeKey];
		expect(() => validateHostedRuntimeState(dangling)).toThrow(HostedStateStorageError);
		const orphanMail = structuredClone(populatedState());
		orphanMail.events.evt_1!.recipientParticipantKey = "participant_absent";
		expect(() => validateHostedRuntimeState(orphanMail)).toThrow(HostedStateStorageError);
	});

	it("expires a grant whose window has closed while its published mail is still retained", () => {
		const state = populatedState();
		const namespaceId = "msg_00000000-0000-0000-0000-000000000001";
		state.messaging[namespaceId] = {
			namespaceId,
			secretDigest: "a".repeat(64),
			participantKey: SENDER,
			holderGeneration: "lease_sender",
			targetKey: "pi_session-1",
			configurationHash: "b".repeat(64),
			createdAt: 100,
			expiresAt: 100 + HOSTED_ACK_RETENTION_MS,
			status: "active",
			operations: { "op-1": "evt_1" },
		};
		const pruned = reduceHostedState(state, { type: "retention.prune", before: 101 + HOSTED_ACK_RETENTION_MS });
		expect(pruned.messaging[namespaceId]?.status).toBe("expired");
		expect(pruned.events.evt_1).toBeUndefined();
	});

	it("drops read mail after its own shorter window even while the sender's grant still lists it", () => {
		const state = structuredClone(populatedState());
		state.messaging["msg_00000000-0000-0000-0000-000000000002"] = {
			namespaceId: "msg_00000000-0000-0000-0000-000000000002",
			secretDigest: "a".repeat(64),
			participantKey: SENDER,
			holderGeneration: "lease_sender",
			targetKey: "pi_session-1",
			configurationHash: "b".repeat(64),
			createdAt: 100,
			expiresAt: 100 + HOSTED_ACK_RETENTION_MS,
			status: "active",
			operations: { "op-1": "evt_1" },
		};
		expect(reduceHostedState(state, { type: "retention.prune", before: 0, readBefore: 1_000 }).events.evt_1).toBeDefined();
		state.events.evt_1!.readAt = 500;
		expect(reduceHostedState(state, { type: "retention.prune", before: 0, readBefore: 500 }).events.evt_1).toBeDefined();
		const pruned = reduceHostedState(state, { type: "retention.prune", before: 0, readBefore: 501 });
		expect(pruned.events.evt_1).toBeUndefined();
		expect(pruned.messaging["msg_00000000-0000-0000-0000-000000000002"]?.operations).toEqual({ "op-1": "evt_1" });
	});
});

describe("hosted runtime state pressure", () => {
	const size = (state: HostedRuntimeState) => Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
	const send = (sendId: string, at: number) => ({
		type: "mailbox.send" as const,
		senderParticipantKey: SENDER,
		expectedSenderGeneration: "lease_sender",
		senderTargetKey: "pi_session-1",
		recipientParticipantKey: RECIPIENT,
		sendId,
		eventId: `evt_${sendId}`,
		body: "pressure",
		at,
	});

	it("sheds read mail older than an hour before refusing a write at the cap, and refuses once nothing is left to shed", () => {
		const root = temporaryRoot();
		const read = structuredClone(populatedState());
		read.events.evt_1!.readAt = 200;
		writeHostedRuntimeState(root, read);
		const now = 200 + 2 * 60 * 60 * 1_000;
		const afterSend = reduceHostedState(read, send("send_2", now));
		const evicted = reduceHostedState(afterSend, { type: "retention.prune", before: 0, readBefore: now - 60 * 60 * 1_000 });
		expect(size(afterSend)).toBeGreaterThan(size(evicted) + 1);
		const store = new HostedStateStore(root, { now: () => now, maxBytes: size(evicted) + 1 });
		store.apply(send("send_2", now));
		expect(readHostedRuntimeState(root).events).toEqual({ evt_send_2: expect.objectContaining({ body: "pressure" }) });
		expect(() => store.apply(send("send_3", now))).toThrow(expect.objectContaining({ full: true, uncertain: false }));
		expect(store.read().events.evt_send_2).toBeDefined();
	});
});
