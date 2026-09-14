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
const PROJECT_ROOT = "/tmp/project";
const SENDER = deriveParticipantKey(PROJECT_ROOT, "review", "main");
const RECIPIENT = deriveParticipantKey(PROJECT_ROOT, "review", "peer");
const DEDUPE_KEY = `mailbox:${SENDER}:send_1`;

const context: HostedProtocolContext = { runtimeId: "rt_test", agentWake: "none" };

function populatedState(): HostedRuntimeState {
	return {
		version: 23,
		messaging: {
			[NAMESPACE]: {
				namespaceId: NAMESPACE,
				secretDigest: DIGEST,
				participantKey: SENDER,
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
		participants: {
			[SENDER]: {
				participantKey: SENDER,
				projectRoot: PROJECT_ROOT,
				protocol: "review",
				participantId: "main",
				state: "held",
				generation: "lease_1",
				holderTargetKey: "pi_session-1",
				outSeq: { [RECIPIENT]: 1 },
				transition: { cause: "acquire", at: 100 },
				createdAt: 100,
				updatedAt: 100,
			},
			[RECIPIENT]: {
				participantKey: RECIPIENT,
				projectRoot: PROJECT_ROOT,
				protocol: "review",
				participantId: "peer",
				state: "vacant",
				generation: "lease_2",
				outSeq: {},
				transition: { cause: "stand_down", at: 100 },
				createdAt: 100,
				updatedAt: 100,
			},
		},
		events: {
			evt_1: {
				version: 1,
				eventId: "evt_1",
				dedupeKey: DEDUPE_KEY,
				type: "mailbox.message",
				source: { kind: "participant", id: SENDER, generation: "lease_1", sequence: 1 },
				recipientParticipantKey: RECIPIENT,
				sendId: "send_1",
				body: "Please inspect.",
				createdAt: 201,
				summary: "message from main to peer",
			},
		},
		dedupe: { [DEDUPE_KEY]: "evt_1" },
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
	["participants", (state) => { Reflect.set(record(state.participants, SENDER).transition, "cause", "paused"); }],
	["events", (state) => { Reflect.set(record(state.events, "evt_1"), "type", "filesystem.created"); }],
	["dedupe", (state) => { Reflect.set(state.dedupe, DEDUPE_KEY, 7); }],
];

/** Cross-record invariants no single-record schema can see; each must fail the load, never be repaired. */
const INCOHERENT: Array<[string, (state: HostedRuntimeState) => void]> = [
	["dangling dedupe entry", (state) => { state.dedupe.stale = "evt_missing"; }],
	["dedupe entry pointing at an event that carries another key", (state) => { record(state.events, "evt_1").dedupeKey = "other"; }],
	["event unreachable through its dedupe key", (state) => { Reflect.deleteProperty(state.dedupe, DEDUPE_KEY); }],
	["record id that differs from its map key", (state) => { record(state.events, "evt_1").eventId = "evt_2"; }],
	["participant key that is not derived from its identity", (state) => { record(state.participants, SENDER).participantId = "other"; }],
	["mail event addressed to an absent participant", (state) => { record(state.events, "evt_1").recipientParticipantKey = "participant_gone"; }],
	["mail dedupe key that is not derived from its sender and send ID", (state) => { record(state.events, "evt_1").sendId = "send_2"; }],
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
			method: "participant.list",
			params: { registrationId: "reg_1", registrationKey: "key_1", extra: true },
		});
		expect(await dispatchHostedLine(line, context)).toMatchObject({
			id: "req_unknown_field",
			ok: false,
			error: { code: "invalid_request" },
		});
	});
});
