import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	consumeRuntimeEvent,
	emptyRuntimeEventState,
	pendingRuntimeEvents,
	reduceRuntimeEvent,
	replayRuntimeEventEntries,
	runtimeEvents,
	type RuntimeEvent,
} from "../extensions/shared/runtime-events.ts";

function event(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		version: 1,
		id: "event-1",
		dedupeKey: "subagent:run-1:terminal:g1",
		source: { kind: "subagent", id: "run-1", generation: "g1" },
		type: "terminal",
		status: "completed",
		createdAt: 100,
		summary: "review complete",
		...overrides,
	};
}

describe("runtime event reducer", () => {
	it("deduplicates events and orders pending delivery", () => {
		let state = emptyRuntimeEventState();
		state = reduceRuntimeEvent(state, { type: "emit", event: event() });
		state = reduceRuntimeEvent(state, { type: "emit", event: event({ id: "duplicate" }) });

		expect(Object.keys(state.events)).toEqual(["event-1"]);
		expect(pendingRuntimeEvents(state).map((item) => item.id)).toEqual(["event-1"]);
	});

	it("records silent events without making them deliverable", () => {
		const state = reduceRuntimeEvent(emptyRuntimeEventState(), { type: "emit", event: event({ delivery: "record_only" }) });
		expect(state.events["event-1"]?.delivery).toBe("record_only");
		expect(state.deliveries["event-1"]?.status).toBe("acked");
		expect(pendingRuntimeEvents(state)).toEqual([]);
	});

	it("rejects stale generation events", () => {
		let state = emptyRuntimeEventState();
		state = reduceRuntimeEvent(state, {
			type: "activate",
			source: { kind: "subagent", id: "run-1" },
			generation: "g2",
		});
		state = reduceRuntimeEvent(state, { type: "emit", event: event() });

		expect(state.events).toEqual({});
	});

	it("claims and acknowledges only for the owner", () => {
		let state = reduceRuntimeEvent(emptyRuntimeEventState(), { type: "emit", event: event() });
		state = reduceRuntimeEvent(state, { type: "claim", eventId: "event-1", claimant: "session-a", at: 200 });
		state = reduceRuntimeEvent(state, { type: "ack", eventId: "event-1", claimant: "session-b", at: 300 });
		expect(state.deliveries["event-1"]?.status).toBe("claimed");

		state = reduceRuntimeEvent(state, { type: "ack", eventId: "event-1", claimant: "session-a", at: 300 });
		expect(state.deliveries["event-1"]?.status).toBe("acked");
		expect(pendingRuntimeEvents(state)).toEqual([]);
	});

	it("consumes a pending event for the exact claimant", () => {
		const branch: Array<Record<string, unknown>> = [];
		const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		runtimeEvents.restore([{ type: "custom", customType: "deevs.runtime-event-op.v1", data: { type: "emit", event: event() } }]);
		expect(consumeRuntimeEvent(pi, "event-1", "session-a")).toBe(true);
		expect(branch.map((entry) => (entry.data as { type?: string }).type)).toEqual(["claim", "ack"]);
		expect(pendingRuntimeEvents(runtimeEvents.read())).toEqual([]);
	});

	it("releases a failed delivery claim only for its claimant", () => {
		let state = reduceRuntimeEvent(emptyRuntimeEventState(), { type: "emit", event: event() });
		state = reduceRuntimeEvent(state, { type: "claim", eventId: "event-1", claimant: "session-a", at: 100 });
		state = reduceRuntimeEvent(state, { type: "release", eventId: "event-1", claimant: "session-b", at: 101 });
		expect(state.deliveries["event-1"]?.status).toBe("claimed");
		state = reduceRuntimeEvent(state, { type: "release", eventId: "event-1", claimant: "session-a", at: 102 });
		expect(state.deliveries["event-1"]).toEqual({ status: "pending" });
	});

	it("repairs stale claims without replaying acknowledged events", () => {
		let state = reduceRuntimeEvent(emptyRuntimeEventState(), { type: "emit", event: event() });
		state = reduceRuntimeEvent(state, { type: "claim", eventId: "event-1", claimant: "session-a", at: 100 });
		state = reduceRuntimeEvent(state, { type: "release_stale_claims", at: 1_101, staleAfterMs: 1_000 });

		expect(state.deliveries["event-1"]).toEqual({ status: "pending" });
	});

	it("replays valid custom entries and ignores corrupted records", () => {
		const operation = { type: "emit" as const, event: event() };
		const state = replayRuntimeEventEntries([
			{ type: "custom", customType: "other", data: operation },
			{ type: "custom", customType: "deevs.runtime-event-op.v1", data: { type: "emit" } },
			{ type: "custom", customType: "deevs.runtime-event-op.v1", data: { type: "activate", source: { kind: "workflow", id: "wf" }, generation: "g1" } },
			{ type: "custom", customType: "deevs.runtime-event-op.v1", data: { type: "emit", event: { ...event(), id: "bad-status", status: "running" } } },
			{ type: "custom", customType: "deevs.runtime-event-op.v1", data: { type: "emit", event: { ...event(), id: "bad-usage", usage: { inputTokens: -1 } } } },
			{ type: "custom", customType: "deevs.runtime-event-op.v1", data: operation },
		]);

		expect(pendingRuntimeEvents(state).map((item) => item.id)).toEqual(["event-1"]);
		expect(state.generations["workflow:wf"]).toBeUndefined();
	});
});
