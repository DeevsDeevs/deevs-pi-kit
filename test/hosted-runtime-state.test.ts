import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTED_ACK_RETENTION_MS, HOSTED_MONITOR_MAX_ENTRIES, HOSTED_STATE_MAX_BYTES, type HostedClaim, type HostedFilesystemCreatedEvent, type HostedMonitor, type HostedTarget } from "../extensions/runtime/hosted-types.ts";
import {
	HostedStateConflictError,
	HostedStateStorageError,
	emptyHostedRuntimeState,
	loadOrCreateRuntimeInstance,
	pendingHostedEvents,
	readHostedRuntimeState,
	reduceHostedState,
	runtimeStatePaths,
	validateHostedRuntimeState,
	writeHostedRuntimeState,
} from "../extensions/runtime/service/state.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-state-"));
	roots.push(root);
	return root;
}

function target(): HostedTarget {
	return {
		kind: "pi",
		targetKey: "pi_target",
		projectRoot: "/tmp/project",
		piSessionId: "session-1",
		piSessionFile: "/tmp/session.jsonl",
		createdAt: 100,
	};
}

function monitor(overrides: Partial<HostedMonitor> = {}): HostedMonitor {
	return {
		monitorId: "mon_1",
		targetKey: "pi_target",
		generation: "gen_1",
		directory: "/tmp/project/reviews",
		settleMs: 250,
		status: "watching",
		sequence: 0,
		entries: {},
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

function event(id = "evt_1", sequence = 1): HostedFilesystemCreatedEvent {
	return {
		version: 1,
		eventId: id,
		dedupeKey: `mon_1:gen_1:${sequence}:review.md`,
		source: { kind: "monitor", id: "mon_1", generation: "gen_1", sequence },
		targetKey: "pi_target",
		type: "filesystem.created",
		createdAt: 200 + sequence,
		summary: "new file: review.md",
		payload: {
			relativePath: "review.md",
			path: "/tmp/project/reviews/review.md",
			fileType: "regular",
			size: 42,
			mtimeMs: 200,
		},
		delivery: { status: "pending" },
	};
}

function populatedState(): ReturnType<typeof emptyHostedRuntimeState> {
	let state = reduceHostedState(emptyHostedRuntimeState(), { type: "target.ensure", target: target() });
	state = reduceHostedState(state, { type: "monitor.create", monitor: monitor() });
	return reduceHostedState(state, {
		type: "monitor.commit",
		monitor: monitor({
			sequence: 1,
			updatedAt: 200,
			entries: {
				"review.md": { relativePath: "review.md", size: 42, mtimeMs: 200, stableSince: 200, present: true, emitted: true },
			},
		}),
		events: [event()],
	});
}

function claim(id = "claim_1", eventIds = ["evt_1"]): HostedClaim {
	return {
		claimId: id,
		targetKey: "pi_target",
		registrationId: "reg_1",
		clientGeneration: "client_1",
		eventIds,
		createdAt: 300,
		leaseUntil: 1_300,
		status: "active",
	};
}

describe("hosted runtime state reducer", () => {
	it("commits a monitor cursor and event together while deduplicating repeats", () => {
		const state = populatedState();
		expect(state.monitors.mon_1?.sequence).toBe(1);
		expect(state.events.evt_1?.type === "filesystem.created" ? state.events.evt_1.payload.relativePath : undefined).toBe("review.md");
		expect(pendingHostedEvents(state, "pi_target").map((candidate) => candidate.eventId)).toEqual(["evt_1"]);

		const duplicate = { ...event("evt_duplicate"), dedupeKey: event().dedupeKey };
		const replayed = reduceHostedState(state, { type: "monitor.commit", monitor: state.monitors.mon_1!, events: [duplicate] });
		expect(Object.keys(replayed.events)).toEqual(["evt_1"]);
	});

	it("orders events from different sources by Runtime creation time", () => {
		const older: HostedFilesystemCreatedEvent = { ...event("evt_older", 12), createdAt: 100, source: { kind: "monitor", id: "source_fable", generation: "gen_1", sequence: 12 } };
		const newer: HostedFilesystemCreatedEvent = { ...event("evt_newer", 2), createdAt: 200, source: { kind: "monitor", id: "source_release_gate", generation: "gen_1", sequence: 2 } };
		const state = { ...populatedState(), events: { evt_newer: newer, evt_older: older } };
		expect(pendingHostedEvents(state, "pi_target").map((candidate) => candidate.eventId)).toEqual(["evt_older", "evt_newer"]);
	});

	it("distinguishes idempotent natural-key retries from conflicts", () => {
		let state = reduceHostedState(emptyHostedRuntimeState(), { type: "target.ensure", target: target() });
		expect(reduceHostedState(state, { type: "target.ensure", target: target() })).toBe(state);
		expect(() => reduceHostedState(state, {
			type: "target.ensure",
			target: { ...target(), projectRoot: "/tmp/other" },
		})).toThrow(HostedStateConflictError);

		state = reduceHostedState(state, { type: "monitor.create", monitor: monitor() });
		expect(reduceHostedState(state, { type: "monitor.create", monitor: monitor({ monitorId: "mon_retry" }) })).toBe(state);
		expect(() => reduceHostedState(state, {
			type: "monitor.create",
			monitor: monitor({ monitorId: "mon_other", directory: "/tmp/project/other" }),
		})).toThrow(/another monitor/);
	});

	it("rejects monitor definition changes, sequence rollback, and entry overflow", () => {
		const state = populatedState();
		for (const changed of [
			monitor({ sequence: 2, settleMs: 500, updatedAt: 300 }),
			monitor({ sequence: 0, updatedAt: 300 }),
			monitor({
				sequence: 2,
				updatedAt: 300,
				entries: Object.fromEntries(Array.from({ length: HOSTED_MONITOR_MAX_ENTRIES + 1 }, (_, index) => {
					const relativePath = `file-${index}`;
					return [relativePath, { relativePath, size: 1, mtimeMs: 1, stableSince: 1, present: true, emitted: false }];
				})),
			}),
		]) {
			expect(reduceHostedState(state, { type: "monitor.commit", monitor: changed, events: [] })).toBe(state);
		}
	});

	it("claims only pending target events and enforces exact claim receipts", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.claim", claim: claim() });
		expect(state.events.evt_1?.delivery).toEqual({ status: "claimed", claimId: "claim_1" });

		const foreignAck = reduceHostedState(state, {
			type: "inbox.ack",
			targetKey: "pi_foreign",
			claimId: "claim_1",
			eventIds: ["evt_1"],
			at: 400,
		});
		expect(foreignAck).toBe(state);

		state = reduceHostedState(state, {
			type: "inbox.release",
			targetKey: "pi_target",
			claimId: "claim_1",
			eventIds: ["evt_1"],
			at: 400,
		});
		expect(state.events.evt_1?.delivery).toEqual({ status: "pending", latestClaimId: "claim_1" });

		state = reduceHostedState(state, {
			type: "inbox.ack",
			targetKey: "pi_target",
			claimId: "claim_1",
			eventIds: ["evt_1"],
			at: 500,
		});
		expect(state.events.evt_1?.delivery).toEqual({ status: "acked", claimId: "claim_1", ackedAt: 500 });
		expect(state.claims.claim_1?.status).toBe("acked");
	});

	it("preserves the first acknowledgement receipt when an older released claim reconciles later", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.claim", claim: claim("claim_1") });
		state = reduceHostedState(state, { type: "inbox.release", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 400 });
		state = reduceHostedState(state, { type: "inbox.claim", claim: { ...claim("claim_2"), createdAt: 500, leaseUntil: 1_500 } });
		const staleAck = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 550 });
		expect(staleAck).toBe(state);
		expect(state.events.evt_1?.delivery).toEqual({ status: "claimed", claimId: "claim_2" });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_target", claimId: "claim_2", eventIds: ["evt_1"], at: 600 });
		state = reduceHostedState(state, { type: "inbox.reconcile", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 700 });
		expect(state.events.evt_1?.delivery).toEqual({ status: "acked", claimId: "claim_2", ackedAt: 600 });
	});

	it("reconciles an older exact admission without leaving a newer claim active", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.claim", claim: claim("claim_1") });
		state = reduceHostedState(state, { type: "inbox.release", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 400 });
		state = reduceHostedState(state, { type: "inbox.claim", claim: { ...claim("claim_2"), createdAt: 500, leaseUntil: 1_500 } });
		state = reduceHostedState(state, { type: "inbox.reconcile", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 550 });
		expect(state.events.evt_1?.delivery).toEqual({ status: "acked", claimId: "claim_1", ackedAt: 550 });
		expect(state.claims.claim_1?.status).toBe("acked");
		expect(state.claims.claim_2?.status).toBe("released");
		expect(Object.values(state.claims).filter((candidate) => candidate.status === "active")).toEqual([]);
	});

	it("rejects malformed or conflicting claim attempts", () => {
		const state = populatedState();
		expect(reduceHostedState(state, { type: "inbox.claim", claim: claim("duplicate", ["evt_1", "evt_1"]) })).toBe(state);
		expect(reduceHostedState(state, { type: "inbox.claim", claim: { ...claim("expired"), leaseUntil: 300 } })).toBe(state);
		expect(reduceHostedState(state, { type: "inbox.claim", claim: claim("missing", ["evt_missing"]) })).toBe(state);

		const claimed = reduceHostedState(state, { type: "inbox.claim", claim: claim() });
		expect(() => reduceHostedState(claimed, {
			type: "inbox.claim",
			claim: { ...claim(), eventIds: ["evt_other"] },
		})).toThrow(HostedStateConflictError);
		expect(() => reduceHostedState(claimed, { type: "inbox.claim", claim: claim("claim_2") })).toThrow(HostedStateConflictError);
	});

	it("releases expired claims without replaying acknowledged events", () => {
		let state = populatedState();
		state = reduceHostedState(state, { type: "inbox.claim", claim: claim() });
		state = reduceHostedState(state, { type: "inbox.release_expired", at: 1_300 });
		expect(state.events.evt_1?.delivery.status).toBe("pending");
		expect(state.claims.claim_1?.status).toBe("released");

		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 1_400 });
		const afterAckExpiry = reduceHostedState(state, { type: "inbox.release_expired", at: 2_000 });
		expect(afterAckExpiry.events.evt_1?.delivery.status).toBe("acked");
	});

	it("prunes old acknowledged receipt groups during later acknowledgements", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.claim", claim: claim("claim_1") });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 1_000 });
		state = reduceHostedState(state, { type: "monitor.commit", monitor: { ...state.monitors.mon_1!, sequence: 2, updatedAt: 2_000 }, events: [event("evt_2", 2)] });
		state = reduceHostedState(state, { type: "inbox.claim", claim: { ...claim("claim_2", ["evt_2"]), createdAt: 2_000, leaseUntil: 3_000 } });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_target", claimId: "claim_2", eventIds: ["evt_2"], at: 1_001 + HOSTED_ACK_RETENTION_MS });
		expect(state.events.evt_1).toBeUndefined();
		expect(state.claims.claim_1).toBeUndefined();
		expect(state.events.evt_2?.delivery.status).toBe("acked");
	});

	it("prunes only complete old acknowledged receipt groups", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.claim", claim: claim() });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_target", claimId: "claim_1", eventIds: ["evt_1"], at: 1_000 });
		expect(reduceHostedState(state, { type: "retention.prune", before: 1_000 }).events.evt_1).toBeDefined();
		state = reduceHostedState(state, { type: "retention.prune", before: 1_000 + HOSTED_ACK_RETENTION_MS });
		expect(state.events).toEqual({});
		expect(state.dedupe).toEqual({});
		expect(state.claims).toEqual({});
	});

	it("atomically accepts one wake into its exact first pending batch", () => {
		let state = populatedState();
		state = reduceHostedState(state, { type: "wake.set", wake: { wakeId: "wake_1", targetKey: "pi_target", registrationId: "reg_1", createdAt: 250 } });
		const operation = { type: "wake.accept" as const, wakeId: "wake_1", claim: claim() };
		state = reduceHostedState(state, operation);
		expect(state.wakes).toEqual({});
		expect(state.events.evt_1?.delivery).toEqual({ status: "claimed", claimId: "claim_1" });
		expect(reduceHostedState(state, operation)).toBe(state);
		const fresh = reduceHostedState(populatedState(), { type: "wake.set", wake: { wakeId: "wake_1", targetKey: "pi_target", registrationId: "reg_1", createdAt: 250 } });
		expect(() => reduceHostedState(fresh, { ...operation, claim: claim("claim_wrong", ["evt_missing"]) })).toThrow(HostedStateConflictError);
	});

	it("keeps one outstanding wake per target and clears only the exact wake", () => {
		let state = reduceHostedState(emptyHostedRuntimeState(), { type: "target.ensure", target: target() });
		state = reduceHostedState(state, {
			type: "wake.set",
			wake: { wakeId: "wake_1", targetKey: "pi_target", registrationId: "reg_1", createdAt: 200 },
		});
		expect(reduceHostedState(state, { type: "wake.set", wake: { wakeId: "wake_1", targetKey: "pi_target", registrationId: "reg_1", createdAt: 200 } })).toBe(state);
		expect(() => reduceHostedState(state, {
			type: "wake.set",
			wake: { wakeId: "wake_2", targetKey: "pi_target", registrationId: "reg_1", createdAt: 201 },
		})).toThrow(HostedStateConflictError);
		expect(reduceHostedState(state, { type: "wake.clear", targetKey: "pi_target", wakeId: "wake_2" })).toBe(state);
		expect(reduceHostedState(state, { type: "wake.clear", targetKey: "pi_target", wakeId: "wake_1" }).wakes).toEqual({});
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

		const claimed = reduceHostedState(oldState, { type: "inbox.claim", claim: claim() });
		writeHostedRuntimeState(root, claimed);
		expect(readHostedRuntimeState(root).events.evt_1?.delivery.status).toBe("claimed");
	});

	it("preserves committed state when a replacement fails validation", () => {
		const root = temporaryRoot();
		const state = populatedState();
		writeHostedRuntimeState(root, state);
		const invalid = structuredClone(state);
		invalid.events.evt_1!.summary = "x".repeat(2_049);
		expect(() => writeHostedRuntimeState(root, invalid)).toThrow(HostedStateStorageError);
		expect(readHostedRuntimeState(root)).toEqual(state);
	});

	it("cleans its temporary file when the atomic rename fails", () => {
		const root = temporaryRoot();
		mkdirSync(runtimeStatePaths(root).state);
		expect(() => writeHostedRuntimeState(root, emptyHostedRuntimeState())).toThrow(HostedStateStorageError);
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("fails closed for malformed, unknown-field, mismatched-delivery, and oversized state", () => {
		const root = temporaryRoot();
		const path = runtimeStatePaths(root).state;
		writeFileSync(path, "{not-json", { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(HostedStateStorageError);

		writeFileSync(path, JSON.stringify({ ...emptyHostedRuntimeState(), surprise: true }), { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(/unknown field surprise/);

		const mismatched = populatedState();
		(mismatched.events.evt_1!.delivery as unknown as Record<string, unknown>).claimId = "stray";
		writeFileSync(path, JSON.stringify(mismatched), { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(/unknown field claimId/);

		writeFileSync(path, Buffer.alloc(HOSTED_STATE_MAX_BYTES + 1, 0x20), { mode: 0o600 });
		expect(() => readHostedRuntimeState(root)).toThrow(/exceeds/);
	});

	it("rejects invalid cross-references rather than repairing them", () => {
		const state = populatedState();
		const parsed = JSON.parse(readFileSync(writeFixture(state), "utf8")) as Record<string, unknown>;
		(parsed.dedupe as Record<string, string>)[state.events.evt_1!.dedupeKey] = "missing";
		expect(() => validateHostedRuntimeState(parsed)).toThrow(HostedStateStorageError);
	});
});

function writeFixture(state: unknown): string {
	const root = temporaryRoot();
	const path = join(root, "fixture.json");
	writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
	return path;
}
