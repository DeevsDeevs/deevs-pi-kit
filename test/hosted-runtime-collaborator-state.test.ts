import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	HOSTED_MAILBOX_MAX_BODY_BYTES,
	HOSTED_PARTICIPANT_TRANSITION_LIMIT,
	type HostedClaim,
	type HostedFilesystemCreatedEvent,
	type HostedMonitor,
	type HostedRuntimeState,
	type HostedTarget,
} from "../extensions/runtime/hosted-types.ts";
import {
	HostedStateConflictError,
	HostedStateStorageError,
	deriveParticipantKey,
	emptyHostedRuntimeState,
	pendingHostedEvents,
	readHostedRuntimeState,
	reduceHostedState,
	runtimeStatePaths,
	validateHostedRuntimeState,
} from "../extensions/runtime/service/state.ts";

const projectRoot = "/project";

function target(targetKey: string): HostedTarget {
	return { kind: "pi", targetKey, projectRoot, piSessionId: `session_${targetKey}`, piSessionFile: `/sessions/${targetKey}.jsonl`, createdAt: 1 };
}

function withTargets(...targetKeys: string[]): HostedRuntimeState {
	return targetKeys.reduce((state, targetKey) => reduceHostedState(state, { type: "target.ensure", target: target(targetKey) }), emptyHostedRuntimeState());
}

function participantKey(participantId: string): string {
	return deriveParticipantKey(projectRoot, "review", participantId);
}

function acquire(state: HostedRuntimeState, participantId: string, targetKey: string, generation: string, at: number): HostedRuntimeState {
	return reduceHostedState(state, {
		type: "participant.acquire",
		participantKey: participantKey(participantId),
		projectRoot,
		protocol: "review",
		participantId,
		targetKey,
		generation,
		at,
	});
}

function send(state: HostedRuntimeState, sendId: string, eventId: string, body = "Review this.", expectedSenderGeneration = "lease_main"): HostedRuntimeState {
	return reduceHostedState(state, {
		type: "mailbox.send",
		senderParticipantKey: participantKey("main"),
		expectedSenderGeneration,
		senderTargetKey: "target_main",
		recipientParticipantKey: participantKey("fable"),
		sendId,
		eventId,
		body,
		at: 10,
	});
}

function pairedState(): HostedRuntimeState {
	let state = withTargets("target_main", "target_fable", "target_successor");
	state = acquire(state, "main", "target_main", "lease_main", 2);
	return acquire(state, "fable", "target_fable", "lease_fable", 3);
}

function activeClaim(eventId: string, targetKey = "target_fable"): HostedClaim {
	return {
		claimId: "claim_mail",
		targetKey,
		registrationId: "registration_fable",
		clientGeneration: "client_fable",
		eventIds: [eventId],
		createdAt: 20,
		leaseUntil: 50,
		status: "active",
	};
}

function v1MonitorState(): { raw: Record<string, unknown>; event: HostedFilesystemCreatedEvent } {
	let state = withTargets("target_main");
	const monitor: HostedMonitor = {
		monitorId: "monitor_1",
		targetKey: "target_main",
		generation: "monitor_generation_1",
		directory: "/project/reviews",
		settleMs: 250,
		status: "watching",
		sequence: 1,
		entries: {},
		createdAt: 2,
		updatedAt: 3,
	};
	state = reduceHostedState(state, { type: "monitor.create", monitor: { ...monitor, sequence: 0 } });
	const event: HostedFilesystemCreatedEvent = {
		version: 1,
		eventId: "event_existing",
		dedupeKey: "monitor_1\0monitor_generation_1\0review.md",
		source: { kind: "monitor", id: "monitor_1", generation: "monitor_generation_1", sequence: 1 },
		targetKey: "target_main",
		type: "filesystem.created",
		createdAt: 3,
		summary: "new file: review.md",
		payload: { relativePath: "review.md", path: "/project/reviews/review.md", fileType: "regular", size: 10, mtimeMs: 3 },
		delivery: { status: "pending" },
	};
	state = reduceHostedState(state, { type: "monitor.commit", monitor, events: [event] });
	const { participants: _participants, bridgeLaunches: _bridgeLaunches, workspaces: _workspaces, integrations: _integrations, ...rest } = state;
	const targets = Object.fromEntries(Object.entries(rest.targets).map(([key, value]) => { const { kind: _kind, ...legacy } = value; return [key, legacy]; }));
	return { raw: { ...rest, targets, version: 1 }, event };
}

describe("hosted Runtime collaborator state", () => {
	it("atomically migrates v1 state before use without changing existing Monitor events", () => {
		const root = mkdtempSync(join(tmpdir(), "hosted-state-v3-"));
		mkdirSync(root, { recursive: true });
		const { raw, event } = v1MonitorState();
		writeFileSync(runtimeStatePaths(root).state, `${JSON.stringify(raw, null, 2)}\n`);

		const migrated = readHostedRuntimeState(root);
		expect(migrated).toMatchObject({ version: 6, bridgeLaunches: {}, workspaces: {}, integrations: {}, participants: {}, targets: { target_main: { kind: "pi" } } });
		expect(migrated.events[event.eventId]).toEqual(event);
		expect(pendingHostedEvents(migrated, "target_main").map((candidate) => candidate.eventId)).toEqual([event.eventId]);
		expect(JSON.parse(readFileSync(runtimeStatePaths(root).state, "utf8"))).toEqual(migrated);
		expect(statSync(runtimeStatePaths(root).state).mode & 0o777).toBe(0o600);
	});

	it("migrates v2 Pi targets and collaborator ownership into discriminated v6 state", () => {
		const root = mkdtempSync(join(tmpdir(), "hosted-state-v2-to-v4-"));
		mkdirSync(root, { recursive: true });
		const state = pairedState();
		const { bridgeLaunches: _bridgeLaunches, workspaces: _workspaces, integrations: _integrations, ...rest } = state;
		const targets = Object.fromEntries(Object.entries(rest.targets).map(([key, value]) => { const { kind: _kind, ...legacy } = value; return [key, legacy]; }));
		writeFileSync(runtimeStatePaths(root).state, `${JSON.stringify({ ...rest, version: 2, targets }, null, 2)}\n`);
		const migrated = readHostedRuntimeState(root);
		expect(migrated).toMatchObject({ version: 6, bridgeLaunches: {}, workspaces: {}, integrations: {}, targets: { target_main: { kind: "pi" }, target_fable: { kind: "pi" } }, participants: { [participantKey("main")]: { state: "held", holderTargetKey: "target_main" }, [participantKey("fable")]: { state: "held", holderTargetKey: "target_fable" } } });
	});

	it("migrates the released v5 schema to v6 without changing durable references", () => {
		const root = mkdtempSync(join(tmpdir(), "hosted-state-v5-to-v6-"));
		mkdirSync(root, { recursive: true });
		const state = pairedState();
		writeFileSync(runtimeStatePaths(root).state, `${JSON.stringify({ ...state, version: 5 }, null, 2)}\n`);
		const migrated = readHostedRuntimeState(root);
		expect(migrated).toMatchObject({ version: 6, targets: state.targets, participants: state.participants, events: state.events });
	});

	it("fails closed instead of accepting an unknown state version", () => {
		expect(() => validateHostedRuntimeState({ ...emptyHostedRuntimeState(), version: 7 })).toThrow(HostedStateStorageError);
	});

	it("enforces one held participant identity per target and idempotent same-target acquire", () => {
		let state = withTargets("target_main", "target_fable");
		state = acquire(state, "fable", "target_fable", "lease_1", 2);
		const same = acquire(state, "fable", "target_fable", "ignored_retry_generation", 3);
		expect(same).toBe(state);
		expect(() => acquire(state, "fable", "target_main", "lease_2", 3)).toThrow(HostedStateConflictError);
		expect(() => acquire(state, "other", "target_fable", "lease_other", 3)).toThrow(HostedStateConflictError);
	});

	it("records stand-down, consensual reacquire, release, and visible revival", () => {
		let state = pairedState();
		const key = participantKey("fable");
		state = reduceHostedState(state, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", generation: "lease_vacant", at: 4 });
		expect(state.participants[key]).toMatchObject({ state: "vacant", generation: "lease_vacant" });
		expect(state.participants[key]?.holderTargetKey).toBeUndefined();
		state = acquire(state, "fable", "target_successor", "lease_successor", 5);
		expect(state.participants[key]).toMatchObject({ state: "held", holderTargetKey: "target_successor" });
		state = reduceHostedState(state, { type: "participant.release", participantKey: key, targetKey: "target_successor", generation: "lease_ended", at: 6 });
		expect(state.participants[key]?.state).toBe("ended");
		state = acquire(state, "fable", "target_fable", "lease_revived", 7);
		expect(state.participants[key]?.transitions.map((transition) => transition.cause)).toEqual(["acquire", "stand_down", "reacquire", "release", "revive"]);
	});

	it("generation-fences automatic stand-down rollback", () => {
		const state = pairedState();
		const key = participantKey("fable");
		expect(() => reduceHostedState(state, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", expectedGeneration: "stale_generation", generation: "lease_vacant", at: 4 })).toThrow("generation changed before stand-down");
		const expectedGeneration = state.participants[key]!.generation;
		const vacant = reduceHostedState(state, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", expectedGeneration, generation: "lease_vacant", at: 4 });
		expect(vacant.participants[key]?.state).toBe("vacant");
		expect(reduceHostedState(vacant, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", expectedGeneration, generation: "ignored_retry", at: 5 })).toBe(vacant);
	});

	it("bounds transition history without hiding the current generation", () => {
		let state = pairedState();
		const key = participantKey("fable");
		for (let index = 0; index < HOSTED_PARTICIPANT_TRANSITION_LIMIT + 3; index++) {
			state = reduceHostedState(state, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", generation: `vacant_${index}`, at: 10 + index * 2 });
			state = acquire(state, "fable", "target_fable", `held_${index}`, 11 + index * 2);
		}
		expect(state.participants[key]?.transitions).toHaveLength(HOSTED_PARTICIPANT_TRANSITION_LIMIT);
		expect(state.participants[key]?.transitions.at(-1)?.generation).toBe(state.participants[key]?.generation);
	});

	it("routes participant-addressed mail only to the current holder", () => {
		let state = send(pairedState(), "send_1", "event_1");
		expect(pendingHostedEvents(state, "target_main")).toEqual([]);
		expect(pendingHostedEvents(state, "target_fable").map((event) => event.eventId)).toEqual(["event_1"]);
		const key = participantKey("fable");
		state = reduceHostedState(state, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", generation: "vacant_1", at: 11 });
		expect(pendingHostedEvents(state, "target_fable")).toEqual([]);
		state = acquire(state, "fable", "target_successor", "lease_successor", 12);
		expect(pendingHostedEvents(state, "target_successor").map((event) => event.eventId)).toEqual(["event_1"]);
	});

	it("deduplicates exact sends, rejects changed retries, and advances per-pair sequence", () => {
		let state = send(pairedState(), "send_1", "event_1");
		const exactRetry = send(state, "send_1", "event_retry");
		expect(exactRetry).toBe(state);
		expect(() => send(state, "send_1", "event_changed", "Changed body")).toThrow(HostedStateConflictError);
		expect(() => send(state, "send_stale", "event_stale", "Stale sender", "lease_stale")).toThrow(HostedStateConflictError);
		state = send(state, "send_2", "event_2", "Second body");
		const events = pendingHostedEvents(state, "target_fable");
		expect(events.map((event) => [event.eventId, event.source.sequence])).toEqual([["event_1", 1], ["event_2", 2]]);
		expect(state.participants[participantKey("main")]?.outSeq[participantKey("fable")]).toBe(2);
	});

	it("queues for vacant participants, rejects ended recipients, and enforces the body cap", () => {
		let state = pairedState();
		const key = participantKey("fable");
		state = reduceHostedState(state, { type: "participant.stand_down", participantKey: key, targetKey: "target_fable", generation: "vacant", at: 4 });
		state = send(state, "send_vacant", "event_vacant");
		expect(state.events.event_vacant?.delivery.status).toBe("pending");
		state = acquire(state, "fable", "target_fable", "held_again", 5);
		state = reduceHostedState(state, { type: "participant.release", participantKey: key, targetKey: "target_fable", generation: "ended", at: 6 });
		expect(() => send(state, "send_ended", "event_ended")).toThrow(HostedStateConflictError);
		expect(() => send(pairedState(), "send_large", "event_large", "x".repeat(HOSTED_MAILBOX_MAX_BODY_BYTES + 1))).toThrow(HostedStateConflictError);
	});

	it("blocks takeover while recipient mail has an active claim", () => {
		let state = send(pairedState(), "send_1", "event_1");
		const claim = activeClaim("event_1");
		state = reduceHostedState(state, { type: "inbox.claim", claim });
		expect(() => reduceHostedState(state, { type: "participant.takeover", participantKey: participantKey("fable"), targetKey: "target_successor", generation: "lease_takeover", at: 21 })).toThrow(HostedStateConflictError);
		state = reduceHostedState(state, { type: "inbox.release", targetKey: claim.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, at: 22 });
		state = reduceHostedState(state, { type: "participant.takeover", participantKey: participantKey("fable"), targetKey: "target_successor", generation: "lease_takeover", at: 23 });
		expect(pendingHostedEvents(state, "target_successor").map((event) => event.eventId)).toEqual(["event_1"]);
	});

	it("keeps participant sends schema-valid through claim, acknowledgement, and retention", () => {
		let state = send(pairedState(), "send_1", "event_1");
		const claim = activeClaim("event_1");
		state = reduceHostedState(state, { type: "inbox.claim", claim });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: claim.targetKey, claimId: claim.claimId, eventIds: claim.eventIds, at: 60 });
		expect(validateHostedRuntimeState(state)).toEqual(state);
		state = reduceHostedState(state, { type: "retention.prune", before: 61 });
		expect(state.events.event_1).toBeUndefined();
		expect(Object.values(state.dedupe)).not.toContain("event_1");
		state = send(state, "send_1", "event_after_horizon");
		expect(state.events.event_after_horizon?.source.sequence).toBe(2);
	});

	it("retains an acknowledged task while its typed result is still retained", () => {
		let state = reduceHostedState(pairedState(), { type: "task.send", senderParticipantKey: participantKey("main"), expectedSenderGeneration: "lease_main", senderTargetKey: "target_main", recipientParticipantKey: participantKey("fable"), sendId: "task_1", eventId: "event_task", body: "Bounded.", at: 10 });
		state = reduceHostedState(state, { type: "task.result", senderParticipantKey: participantKey("fable"), expectedSenderGeneration: "lease_fable", senderTargetKey: "target_fable", sendId: "reply_1", eventId: "event_result", inReplyToEventId: "event_task", status: "completed", body: "Done.", sessionAdvance: "committed", at: 11 });
		const taskClaim = { ...activeClaim("event_task"), claimId: "claim_task" };
		state = reduceHostedState(state, { type: "inbox.claim", claim: taskClaim });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "target_fable", claimId: taskClaim.claimId, eventIds: taskClaim.eventIds, at: 60 });
		state = reduceHostedState(state, { type: "retention.prune", before: 61 });
		expect(state.events.event_task).toBeDefined();
		const resultClaim = { ...activeClaim("event_result", "target_main"), claimId: "claim_result", registrationId: "registration_main", clientGeneration: "client_main", createdAt: 61, leaseUntil: 90 };
		state = reduceHostedState(state, { type: "inbox.claim", claim: resultClaim });
		state = reduceHostedState(state, { type: "inbox.ack", targetKey: "target_main", claimId: resultClaim.claimId, eventIds: resultClaim.eventIds, at: 100 });
		state = reduceHostedState(state, { type: "retention.prune", before: 101 });
		expect(state.events.event_task).toBeUndefined();
		expect(state.events.event_result).toBeUndefined();

		let reverse = reduceHostedState(pairedState(), { type: "task.send", senderParticipantKey: participantKey("main"), expectedSenderGeneration: "lease_main", senderTargetKey: "target_main", recipientParticipantKey: participantKey("fable"), sendId: "task_reverse", eventId: "event_task_reverse", body: "Bounded.", at: 10 });
		reverse = reduceHostedState(reverse, { type: "task.result", senderParticipantKey: participantKey("fable"), expectedSenderGeneration: "lease_fable", senderTargetKey: "target_fable", sendId: "reply_reverse", eventId: "event_result_reverse", inReplyToEventId: "event_task_reverse", status: "completed", body: "Done.", sessionAdvance: "committed", at: 11 });
		const reverseClaim = { ...activeClaim("event_result_reverse", "target_main"), claimId: "claim_reverse", registrationId: "registration_main", clientGeneration: "client_main" };
		reverse = reduceHostedState(reverse, { type: "inbox.claim", claim: reverseClaim });
		reverse = reduceHostedState(reverse, { type: "inbox.ack", targetKey: "target_main", claimId: reverseClaim.claimId, eventIds: reverseClaim.eventIds, at: 60 });
		reverse = reduceHostedState(reverse, { type: "retention.prune", before: 61 });
		expect(reverse.events.event_task_reverse).toBeDefined();
		expect(reverse.events.event_result_reverse).toBeDefined();

		let mixed = reduceHostedState(pairedState(), { type: "task.send", senderParticipantKey: participantKey("main"), expectedSenderGeneration: "lease_main", senderTargetKey: "target_main", recipientParticipantKey: participantKey("fable"), sendId: "task_mixed", eventId: "event_task_mixed", body: "Bounded.", at: 10 });
		mixed = reduceHostedState(mixed, { type: "mailbox.send", senderParticipantKey: participantKey("main"), expectedSenderGeneration: "lease_main", senderTargetKey: "target_main", recipientParticipantKey: participantKey("fable"), sendId: "message_mixed", eventId: "event_message_mixed", body: "Free form.", at: 10 });
		mixed = reduceHostedState(mixed, { type: "task.result", senderParticipantKey: participantKey("fable"), expectedSenderGeneration: "lease_fable", senderTargetKey: "target_fable", sendId: "reply_mixed", eventId: "event_result_mixed", inReplyToEventId: "event_task_mixed", status: "completed", body: "Done.", sessionAdvance: "committed", at: 11 });
		const mixedClaim: HostedClaim = { claimId: "claim_mixed", targetKey: "target_fable", registrationId: "registration_fable", clientGeneration: "client_fable", eventIds: ["event_task_mixed", "event_message_mixed"], createdAt: 20, leaseUntil: 50, status: "active" };
		mixed = reduceHostedState(mixed, { type: "inbox.claim", claim: mixedClaim });
		mixed = reduceHostedState(mixed, { type: "inbox.ack", targetKey: mixedClaim.targetKey, claimId: mixedClaim.claimId, eventIds: mixedClaim.eventIds, at: 60 });
		mixed = reduceHostedState(mixed, { type: "retention.prune", before: 61 });
		expect(mixed.events.event_task_mixed).toBeDefined();
		expect(mixed.events.event_message_mixed).toBeDefined();
		expect(validateHostedRuntimeState(mixed)).toEqual(mixed);
	});

	it("rejects corrupted participant and mailbox references during validation", () => {
		const state = send(pairedState(), "send_1", "event_1");
		const corrupted = structuredClone(state);
		if (corrupted.events.event_1?.type === "mailbox.message") corrupted.events.event_1.payload.fingerprint = "wrong";
		expect(() => validateHostedRuntimeState(corrupted)).toThrow(HostedStateStorageError);
	});
});
