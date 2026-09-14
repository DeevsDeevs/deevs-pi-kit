import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTED_ACK_RETENTION_MS, HOSTED_MONITOR_MAX_ENTRIES, HOSTED_STATE_MAX_BYTES, type HostedFilesystemCreatedEvent, type HostedMonitor, type HostedTarget } from "../extensions/runtime/hosted-types.ts";
import {
	HostedStateConflictError,
	HostedStateStorageError,
	emptyHostedRuntimeState,
	loadOrCreateRuntimeInstance,
	readHostedRuntimeState,
	reduceHostedState,
	runtimeStatePaths,
	undeliveredHostedEvents,
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
		targetKey: "pi_session-1",
		projectRoot: "/tmp/project",
		piSessionId: "session-1",
		piSessionFile: "/tmp/session.jsonl",
		createdAt: 100,
	};
}

function monitor(overrides: Partial<HostedMonitor> = {}): HostedMonitor {
	return {
		monitorId: "mon_1",
		targetKey: "pi_session-1",
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
		targetKey: "pi_session-1",
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

describe("hosted runtime state reducer", () => {
	it("commits a monitor cursor and event together while deduplicating repeats", () => {
		const state = populatedState();
		expect(state.monitors.mon_1?.sequence).toBe(1);
		expect(state.events.evt_1?.type === "filesystem.created" ? state.events.evt_1.payload.relativePath : undefined).toBe("review.md");
		expect(undeliveredHostedEvents(state, "pi_session-1").map((candidate) => candidate.eventId)).toEqual(["evt_1"]);

		const duplicate = { ...event("evt_duplicate"), dedupeKey: event().dedupeKey };
		const replayed = reduceHostedState(state, { type: "monitor.commit", monitor: state.monitors.mon_1!, events: [duplicate] });
		expect(Object.keys(replayed.events)).toEqual(["evt_1"]);
	});

	it("orders events from different sources by Runtime creation time", () => {
		const older: HostedFilesystemCreatedEvent = { ...event("evt_older", 12), createdAt: 100, source: { kind: "monitor", id: "source_fable", generation: "gen_1", sequence: 12 } };
		const newer: HostedFilesystemCreatedEvent = { ...event("evt_newer", 2), createdAt: 200, source: { kind: "monitor", id: "source_release_gate", generation: "gen_1", sequence: 2 } };
		const state = { ...populatedState(), events: { evt_newer: newer, evt_older: older } };
		expect(undeliveredHostedEvents(state, "pi_session-1").map((candidate) => candidate.eventId)).toEqual(["evt_older", "evt_newer"]);
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

	it("holds one claim per target and only for a known target", () => {
		const state = populatedState();
		const claimed = reduceHostedState(state, { type: "inbox.claim", targetKey: "pi_session-1", leaseUntil: 1_300 });
		expect(claimed.claims).toEqual({ "pi_session-1": 1_300 });
		expect(reduceHostedState(claimed, { type: "inbox.claim", targetKey: "pi_session-1", leaseUntil: 1_900 }).claims)
			.toEqual({ "pi_session-1": 1_900 });
		expect(reduceHostedState(state, { type: "inbox.claim", targetKey: "pi_absent", leaseUntil: 1_300 })).toBe(state);
	});

	it("acknowledges only its own target's events and frees that target's claim", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.claim", targetKey: "pi_session-1", leaseUntil: 1_300 });
		expect(reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_foreign", eventIds: ["evt_1"], at: 400 })).toBe(state);
		expect(undeliveredHostedEvents(state, "pi_session-1").map((candidate) => candidate.eventId)).toEqual(["evt_1"]);

		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_session-1", eventIds: ["evt_1"], at: 500 });
		expect(state.events.evt_1?.type === "filesystem.created" ? state.events.evt_1.deliveredAt : undefined).toBe(500);
		expect(state.claims).toEqual({});
		expect(undeliveredHostedEvents(state, "pi_session-1")).toEqual([]);
		expect(reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_session-1", eventIds: ["evt_1"], at: 600 })).toBe(state);
	});

	it("prunes delivered events once they outlive their retention window", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.ack", targetKey: "pi_session-1", eventIds: ["evt_1"], at: 1_000 });
		state = reduceHostedState(state, { type: "monitor.commit", monitor: { ...state.monitors.mon_1!, sequence: 2, updatedAt: 2_000 }, events: [event("evt_2", 2)] });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "pi_session-1", eventIds: ["evt_2"], at: 1_001 + HOSTED_ACK_RETENTION_MS });
		expect(state.events.evt_1).toBeUndefined();
		expect(state.events.evt_2?.type === "filesystem.created" ? state.events.evt_2.deliveredAt : undefined).toBeDefined();
	});

	it("retains a delivered event until its retention window passes", () => {
		let state = reduceHostedState(populatedState(), { type: "inbox.ack", targetKey: "pi_session-1", eventIds: ["evt_1"], at: 1_000 });
		expect(reduceHostedState(state, { type: "retention.prune", before: 1_000 }).events.evt_1).toBeDefined();
		state = reduceHostedState(state, { type: "retention.prune", before: 1_001 });
		expect(state.events).toEqual({});
		expect(state.dedupe).toEqual({});
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

		const claimed = reduceHostedState(oldState, { type: "inbox.claim", targetKey: "pi_session-1", leaseUntil: 1_300 });
		writeHostedRuntimeState(root, claimed);
		expect(readHostedRuntimeState(root).claims).toEqual({ "pi_session-1": 1_300 });
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

	it("rejects invalid cross-references rather than repairing them", () => {
		const dangling = structuredClone(populatedState());
		delete dangling.dedupe[dangling.events.evt_1!.dedupeKey];
		expect(() => validateHostedRuntimeState(dangling)).toThrow(HostedStateStorageError);
		const orphanClaim = { ...populatedState(), claims: { pi_absent: 1_300 } };
		expect(() => validateHostedRuntimeState(orphanClaim)).toThrow(HostedStateStorageError);
	});
});
