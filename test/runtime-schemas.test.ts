import { describe, expect, it } from "vitest";
import { HOSTED_ACK_RETENTION_MS, type HostedRuntimeState } from "../extensions/runtime/hosted-types.ts";
import { dispatchHostedLine, type HostedProtocolContext } from "../extensions/runtime/service/protocol.ts";
import { HostedStateStorageError, validateHostedRuntimeState } from "../extensions/runtime/service/state.ts";

const DIGEST = "a".repeat(64);
const NAMESPACE = "msg_00000000-0000-0000-0000-000000000001";
const DEDUPE_KEY = "mon_1:gen_1:1:review.md";

const context: HostedProtocolContext = { runtimeId: "rt_test", epoch: "epoch_test", agentWake: "none" };

function populatedState(): HostedRuntimeState {
	return {
		version: 17,
		messaging: {
			[NAMESPACE]: {
				namespaceId: NAMESPACE,
				secretDigest: DIGEST,
				participantKey: "participant_a",
				holderGeneration: "lease_1",
				targetKey: "pi_target",
				clientGeneration: "client_1",
				terminalId: "term_1",
				configurationHash: DIGEST,
				createdAt: 100,
				expiresAt: 100 + HOSTED_ACK_RETENTION_MS,
				status: "active",
				operations: {},
			},
		},
		targets: {
			pi_target: {
				kind: "pi",
				targetKey: "pi_target",
				projectRoot: "/tmp/project",
				piSessionId: "session-1",
				piSessionFile: "/tmp/session.jsonl",
				createdAt: 100,
			},
		},
		monitors: {
			mon_1: {
				monitorId: "mon_1",
				targetKey: "pi_target",
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
			participant_a: {
				participantKey: "participant_a",
				projectRoot: "/tmp/project",
				protocol: "review",
				participantId: "main",
				state: "held",
				generation: "lease_1",
				holderTargetKey: "pi_target",
				outSeq: {},
				transitions: [{ cause: "acquire", generation: "lease_1", holderTargetKey: "pi_target", at: 100 }],
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
				targetKey: "pi_target",
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
				targetKey: "pi_target",
				registrationId: "reg_1",
				clientGeneration: "client_1",
				eventIds: ["evt_1"],
				createdAt: 300,
				leaseUntil: 1_300,
				status: "active",
			},
		},
		wakes: { wake_1: { wakeId: "wake_1", targetKey: "pi_target", registrationId: "reg_1", createdAt: 250 } },
	};
}

/** One malformed record per top-level collection; each must fail the root schema, never be repaired. */
const MALFORMED: Array<[string, (state: HostedRuntimeState) => void]> = [
	["messaging", (state) => { state.messaging[NAMESPACE]!.secretDigest = "not-a-digest"; }],
	["targets", (state) => { Reflect.set(state.targets.pi_target!, "kind", "unknown"); }],
	["monitors", (state) => { Reflect.set(state.monitors.mon_1!, "status", "paused"); }],
	["participants", (state) => { state.participants.participant_a!.transitions = []; }],
	["events", (state) => { Reflect.set(state.events.evt_1!, "type", "filesystem.removed"); }],
	["dedupe", (state) => { Reflect.set(state.dedupe, DEDUPE_KEY, 7); }],
	["claims", (state) => { state.claims.claim_1!.eventIds = ["evt_1", "evt_1"]; }],
	["wakes", (state) => { Reflect.deleteProperty(state.wakes.wake_1!, "registrationId"); }],
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
