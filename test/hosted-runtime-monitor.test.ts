import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTED_MONITOR_MAX_ENTRIES, type HostedFileObservation, type HostedMonitor, type HostedTarget } from "../extensions/runtime/hosted-types.ts";
import { DirectoryMonitorManager, MonitorInputError, MonitorLimitError } from "../extensions/runtime/service/monitor.ts";
import { HostedStateStore, pendingHostedEvents } from "../extensions/runtime/service/state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(automatic = false) {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-monitor-"));
	roots.push(root);
	const runtimeRoot = join(root, "runtime");
	const projectRoot = join(root, "project");
	const watchRoot = join(projectRoot, "reviews");
	mkdirSync(watchRoot, { recursive: true });
	const store = new HostedStateStore(runtimeRoot);
	const target: HostedTarget = { targetKey: "pi_target", projectRoot, piSessionId: "session_1", piSessionFile: join(root, "session.jsonl"), createdAt: 1 };
	store.apply({ type: "target.ensure", target });
	let now = 1_000;
	const manager = new DirectoryMonitorManager(store, {
		automatic,
		now: () => now,
		createId: (prefix) => `${prefix}_fixed`,
		scanIntervalMs: automatic ? 60_000 : 20,
		watchDebounceMs: 5,
	});
	return { runtimeRoot, projectRoot, watchRoot, store, manager, setNow: (value: number) => { now = value; } };
}

describe("hosted directory Monitor", () => {
	it("does not rewrite durable state for an idle authoritative scan", () => {
		const test = setup();
		writeFileSync(join(test.watchRoot, "existing.md"), "baseline");
		const monitor = test.manager.create("pi_target", test.watchRoot, 250);
		const before = test.store.read();
		test.setNow(2_000);
		expect(test.manager.reconcile(monitor.monitorId)).toBe(before.monitors[monitor.monitorId]);
		expect(test.store.read()).toBe(before);
	});

	it("keeps a non-emitting baseline and emits one event only after a new file settles", () => {
		const test = setup();
		writeFileSync(join(test.watchRoot, "existing.md"), "baseline");
		const monitor = test.manager.create("pi_target", test.watchRoot, 250);
		expect(monitor.entries["existing.md"]?.emitted).toBe(true);
		writeFileSync(join(test.watchRoot, "review.md"), "review");
		test.manager.reconcile(monitor.monitorId);
		test.setNow(1_249);
		test.manager.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), "pi_target")).toEqual([]);
		test.setNow(1_250);
		test.manager.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), "pi_target")).toMatchObject([{
			source: { id: "mon_fixed", generation: "gen_fixed", sequence: 1 },
			payload: { relativePath: "review.md", fileType: "regular", size: 6 },
		}]);
		test.setNow(2_000);
		writeFileSync(join(test.watchRoot, "review.md"), "modified after emission");
		test.manager.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), "pi_target")).toHaveLength(1);
	});

	it("resets settling after disappearance but never emits a baseline path", () => {
		const test = setup();
		writeFileSync(join(test.watchRoot, "baseline.md"), "base");
		const monitor = test.manager.create("pi_target", test.watchRoot, 250);
		rmSync(join(test.watchRoot, "baseline.md"));
		writeFileSync(join(test.watchRoot, "new.md"), "new");
		test.manager.reconcile(monitor.monitorId);
		test.setNow(1_100);
		rmSync(join(test.watchRoot, "new.md"));
		test.manager.reconcile(monitor.monitorId);
		test.setNow(1_200);
		writeFileSync(join(test.watchRoot, "new.md"), "new");
		writeFileSync(join(test.watchRoot, "baseline.md"), "base again");
		test.manager.reconcile(monitor.monitorId);
		test.setNow(1_449);
		test.manager.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), "pi_target")).toEqual([]);
		test.setNow(1_450);
		test.manager.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), "pi_target").map((event) => event.payload.relativePath)).toEqual(["new.md"]);
	});

	it("rejects symlink roots and ignores symlink entries and nested files", () => {
		const test = setup();
		const outside = join(test.projectRoot, "outside");
		mkdirSync(outside);
		const linkedRoot = join(test.projectRoot, "linked-root");
		symlinkSync(test.watchRoot, linkedRoot);
		expect(() => test.manager.create("pi_target", linkedRoot)).toThrow(MonitorInputError);
		const monitor = test.manager.create("pi_target", test.watchRoot, 0);
		writeFileSync(join(outside, "outside.md"), "outside");
		symlinkSync(join(outside, "outside.md"), join(test.watchRoot, "linked.md"));
		mkdirSync(join(test.watchRoot, "nested"));
		writeFileSync(join(test.watchRoot, "nested", "nested.md"), "nested");
		test.manager.reconcile(monitor.monitorId);
		test.setNow(1_001);
		test.manager.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(test.store.read(), "pi_target")).toEqual([]);
	});

	it("degrades without losing its cursor and recovers when the root returns", () => {
		const test = setup();
		writeFileSync(join(test.watchRoot, "baseline.md"), "base");
		const monitor = test.manager.create("pi_target", test.watchRoot);
		rmSync(test.watchRoot, { recursive: true });
		test.setNow(2_000);
		expect(test.manager.reconcile(monitor.monitorId)?.status).toBe("degraded");
		expect(test.store.read().monitors[monitor.monitorId]?.entries["baseline.md"]).toMatchObject({ emitted: true });
		mkdirSync(test.watchRoot);
		test.setNow(3_000);
		expect(test.manager.reconcile(monitor.monitorId)?.status).toBe("watching");
		expect(test.store.read().monitors[monitor.monitorId]?.entries["baseline.md"]).toMatchObject({ present: false, emitted: true });
	});

	it("fails a cursor-cap crossing without advancing durable state", () => {
		const test = setup();
		const entries: Record<string, HostedFileObservation> = Object.fromEntries(Array.from({ length: HOSTED_MONITOR_MAX_ENTRIES }, (_, index) => {
			const relativePath = `old-${index}.md`;
			return [relativePath, { relativePath, size: 1, mtimeMs: 1, stableSince: 1, present: false, emitted: true }];
		}));
		const monitor: HostedMonitor = { monitorId: "mon_cap", targetKey: "pi_target", generation: "gen_cap", directory: test.watchRoot, settleMs: 250, status: "watching", sequence: 0, entries, createdAt: 1, updatedAt: 1 };
		test.store.apply({ type: "monitor.create", monitor });
		writeFileSync(join(test.watchRoot, "overflow.md"), "overflow");
		expect(() => test.manager.reconcile(monitor.monitorId)).toThrow(MonitorLimitError);
		expect(test.store.read().monitors[monitor.monitorId]).toEqual(monitor);
	});

	it("discovers files created during downtime from durable state", () => {
		const test = setup();
		const monitor = test.manager.create("pi_target", test.watchRoot, 250);
		writeFileSync(join(test.watchRoot, "offline.md"), "offline");
		let now = 5_000;
		const store = new HostedStateStore(test.runtimeRoot);
		const restarted = new DirectoryMonitorManager(store, { automatic: false, now: () => now });
		restarted.reconcile(monitor.monitorId);
		now = 5_250;
		restarted.reconcile(monitor.monitorId);
		expect(pendingHostedEvents(store.read(), "pi_target").map((event) => event.payload.relativePath)).toEqual(["offline.md"]);
	});

	it("uses fs.watch only as a low-latency hint", async () => {
		const test = setup(true);
		const monitor = test.manager.create("pi_target", test.watchRoot, 0);
		test.manager.start();
		writeFileSync(join(test.watchRoot, "hinted.md"), "hinted");
		await vi.waitFor(() => expect(pendingHostedEvents(test.store.read(), "pi_target").map((event) => event.payload.relativePath)).toContain("hinted.md"), { timeout: 1_000, interval: 10 });
		test.manager.close();
		expect(test.store.read().monitors[monitor.monitorId]?.status).toBe("watching");
	});
});
