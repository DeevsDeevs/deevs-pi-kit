import { describe, expect, it } from "vitest";
import { HOSTED_ACK_RETENTION_MS, type HostedRuntimeState } from "../extensions/runtime/hosted-types.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import {
	HostedStateStorageError,
	deriveParticipantKey,
	validateHostedRuntimeState,
} from "../extensions/runtime/service/state.ts";

const DIGEST = "a".repeat(64);
const NAMESPACE = "msg_00000000-0000-0000-0000-000000000001";
const DEDUPE_KEY = "mon_1:gen_1:1:review.md";
const PROJECT_ROOT = "/tmp/project";
const PARTICIPANT = deriveParticipantKey(PROJECT_ROOT, "review", "main");

const context: HostedProtocolContext = { runtimeId: "rt_test", agentWake: "none" };

function populatedState(): HostedRuntimeState {
	return {
		version: 18,
		messaging: {
			[NAMESPACE]: {
				namespaceId: NAMESPACE,
				secretDigest: DIGEST,
				participantKey: PARTICIPANT,
				holderGeneration: "lease_1",
				targetKey: "pi_session-1",
				configurationHash: DIGEST,
				createdAt: 100,
				expiresAt: 100 + HOSTED_ACK_RETENTION_MS,
				status: "active",
				operations: {},
			},
		},
		targets: {
			"pi_session-1": {
				kind: "pi",
				targetKey: "pi_session-1",
				projectRoot: PROJECT_ROOT,
				piSessionId: "session-1",
				piSessionFile: "/tmp/session.jsonl",
				createdAt: 100,
			},
		},
		monitors: {
			mon_1: {
				monitorId: "mon_1",
				targetKey: "pi_session-1",
				generation: "gen_1",
				directory: "/tmp/project/reviews",
				settleMs: 250,
				status: "watching",
				sequence: 1,
				entries: {},
				createdAt: 100,
				updatedAt: 200,
			},
		},
		participants: {
			[PARTICIPANT]: {
				participantKey: PARTICIPANT,
				projectRoot: PROJECT_ROOT,
				protocol: "review",
				participantId: "main",
				state: "held",
				generation: "lease_1",
				holderTargetKey: "pi_session-1",
				outSeq: {},
				transitions: [{ cause: "acquire", generation: "lease_1", holderTargetKey: "pi_session-1", at: 100 }],
				createdAt: 100,
				updatedAt: 100,
			},
		},
		events: {
			evt_1: {
				version: 1,
				eventId: "evt_1",
				dedupeKey: DEDUPE_KEY,
				source: { kind: "monitor", id: "mon_1", generation: "gen_1", sequence: 1 },
				targetKey: "pi_session-1",
				type: "filesystem.created",
				createdAt: 201,
				summary: "new file: review.md",
				payload: { relativePath: "review.md", path: "/tmp/project/reviews/review.md", fileType: "regular", size: 42, mtimeMs: 200 },
				delivery: { status: "claimed", claimId: "claim_1" },
			},
		},
		dedupe: { [DEDUPE_KEY]: "evt_1" },
		claims: {
			claim_1: {
				claimId: "claim_1",
				targetKey: "pi_session-1",
				registrationId: "reg_1",
				eventIds: ["evt_1"],
				createdAt: 300,
				leaseUntil: 1_300,
				status: "active",
			},
		},
		wakes: { "pi_session-1": { wakeId: "wake_1", targetKey: "pi_session-1", registrationId: "reg_1", createdAt: 250 } },
	};
}

function record<Value>(records: Record<string, Value>, key: string): Value {
	const found = records[key];
	if (found === undefined) throw new Error(`fixture is missing ${key}`);
	return found;
}

/** One malformed record per top-level collection; each must fail the root schema, never be repaired. */
const MALFORMED: Array<[string, (state: HostedRuntimeState) => void]> = [
	["messaging", (state) => { record(state.messaging, NAMESPACE).secretDigest = "not-a-digest"; }],
	["targets", (state) => { Reflect.set(record(state.targets, "pi_session-1"), "kind", "unknown"); }],
	["monitors", (state) => { Reflect.set(record(state.monitors, "mon_1"), "status", "paused"); }],
	["participants", (state) => { record(state.participants, PARTICIPANT).transitions = []; }],
	["events", (state) => { Reflect.set(record(state.events, "evt_1"), "type", "filesystem.removed"); }],
	["dedupe", (state) => { Reflect.set(state.dedupe, DEDUPE_KEY, 7); }],
	["claims", (state) => { record(state.claims, "claim_1").eventIds = ["evt_1", "evt_1"]; }],
	["wakes", (state) => { Reflect.deleteProperty(record(state.wakes, "pi_session-1"), "registrationId"); }],
];

/** Cross-record invariants no single-record schema can see; each must fail the load, never be repaired. */
const INCOHERENT: Array<[string, (state: HostedRuntimeState) => void]> = [
	["dangling dedupe entry", (state) => { state.dedupe.stale = "evt_missing"; }],
	["dedupe entry pointing at an event that carries another key", (state) => { record(state.events, "evt_1").dedupeKey = "other"; }],
	["event unreachable through its dedupe key", (state) => { Reflect.deleteProperty(state.dedupe, DEDUPE_KEY); }],
	["record id that differs from its map key", (state) => { record(state.claims, "claim_1").claimId = "claim_2"; }],
	["participant key that is not derived from its identity", (state) => { record(state.participants, PARTICIPANT).participantId = "other"; }],
	["claim lease that does not outlive its creation", (state) => { record(state.claims, "claim_1").leaseUntil = 300; }],
	["event claim that does not cover it", (state) => { record(state.claims, "claim_1").targetKey = "other_target"; }],
	["messaging grant with an edited lifetime", (state) => { record(state.messaging, NAMESPACE).expiresAt += 1; }],
];

describe("runtime schemas", () => {
	it("accepts a populated root state with a record in every collection", () => {
		expect(validateHostedRuntimeState(populatedState())).toEqual(populatedState());
	});

	it.each(MALFORMED)("rejects a malformed %s record", (_collection, corrupt) => {
		const state = populatedState();
		corrupt(state);
		expect(() => validateHostedRuntimeState(state)).toThrow(HostedStateStorageError);
	});

	it.each(INCOHERENT)("rejects a %s", (_invariant, corrupt) => {
		const state = populatedState();
		corrupt(state);
		expect(() => validateHostedRuntimeState(state)).toThrow(HostedStateStorageError);
	});

	it("rejects an RPC call carrying an unknown params field", async () => {
		const line = JSON.stringify({
			v: 1,
			id: "req_unknown_field",
			method: "inbox.status",
			params: { registrationId: "reg_1", registrationKey: "key_1", extra: true },
		});
		expect(await dispatchHostedLine(line, context)).toMatchObject({
			id: "req_unknown_field",
			ok: false,
			error: { code: "invalid_request" },
		});
	});
});
