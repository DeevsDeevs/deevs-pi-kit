import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeJournalStore, readRunnerConfig, writeRunnerConfig } from "../extensions/runtime/bridge-runner/journal.ts";
import type { BridgeJournal, BridgeRunnerConfig } from "../extensions/runtime/bridge-runner/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string { const value = mkdtempSync(join(tmpdir(), "pi-kit-bridge-journal-")); roots.push(value); return value; }
function initial(): BridgeJournal { return { version: 1, bridgeId: "bridge_1", driver: "fake", protocol: "review", participantId: "fake", nextSequence: 1, admissions: [], turns: [], status: "starting", updatedAt: 1 }; }

describe("bridge runner journal", () => {
	it("persists owner-private atomic state and restores exact admission before ACK", () => {
		const directory = root();
		const store = new BridgeJournalStore(directory, initial());
		store.update((state) => ({ ...state, nextSequence: 2, admissions: [{ claimId: "claim_1", eventIds: ["event_1"], ack: "uncertain", createdAt: 2 }], turns: [{ turnId: "turn_1", sequence: 1, eventId: "event_1", claimId: "claim_1", senderParticipantKey: "participant_sender", body: "hello", state: "pending", attempt: 0, replySendId: "reply_1", reply: "unsent", createdAt: 2, updatedAt: 2 }], updatedAt: 2 }));
		expect(new BridgeJournalStore(directory, initial()).read()).toMatchObject({ admissions: [{ ack: "uncertain" }], turns: [{ state: "pending" }] });
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(store.path).mode & 0o777).toBe(0o600);
		expect(readFileSync(store.path, "utf8")).not.toContain(".tmp");
	});

	it("fails closed for corruption, unknown fields, and symlink replacement", () => {
		const directory = root();
		const store = new BridgeJournalStore(directory, initial());
		writeFileSync(store.path, "{broken");
		expect(() => new BridgeJournalStore(directory, initial())).toThrow("Cannot read bridge state");
		rmSync(store.path);
		writeFileSync(store.path, JSON.stringify({ ...initial(), extra: true }), { mode: 0o600 });
		expect(() => new BridgeJournalStore(directory, initial())).toThrow("unknown field");
		rmSync(store.path);
		writeFileSync(store.path, JSON.stringify({ ...initial(), nextSequence: 2, admissions: [{ claimId: "claim_1", eventIds: ["event_1"], ack: "confirmed", createdAt: 2 }], turns: [{ turnId: "turn_1", sequence: 1, eventId: "event_1", claimId: "claim_1", senderParticipantKey: "participant_sender", body: "hello", state: "starting", attempt: 1, replySendId: "reply_1", reply: "unsent", worker: { attempt: 1, statePath: "/tmp/worker", cancelRequested: "yes" }, createdAt: 2, updatedAt: 2 }] }), { mode: 0o600 });
		expect(() => new BridgeJournalStore(directory, initial())).toThrow("cancel request must be boolean");
		rmSync(store.path);
		writeFileSync(store.path, JSON.stringify(initial()), { mode: 0o644 });
		expect(() => new BridgeJournalStore(directory, initial())).toThrow("Cannot read bridge state");
		rmSync(store.path);
		const outside = join(directory, "outside");
		writeFileSync(outside, "{}");
		symlinkSync(outside, store.path);
		expect(() => new BridgeJournalStore(directory, initial())).toThrow();
	});

	it("keeps reconnect credentials only in the private controller config", () => {
		const directory = root();
		const path = join(directory, "config.v1.json");
		const config: BridgeRunnerConfig = { version: 1, bridgeId: "bridge_1", driver: "fake", root: directory, runtimeSocket: join(directory, "runtime.sock"), projectRoot: directory, cwd: directory, clientGeneration: "client_1", protocol: "review", participantId: "fake", launchToken: `bridge_launch_bridge_1.${"a".repeat(43)}`, reconnectToken: "b".repeat(43), wallMs: 1_000 };
		writeRunnerConfig(path, config);
		expect(readRunnerConfig(path)).toEqual(config);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(new BridgeJournalStore(join(directory, "journal"), initial()).read()).not.toHaveProperty("reconnectToken");
	});
});
