import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JobBuffer } from "../extensions/jobs/buffer.ts";
import { JobManager } from "../extensions/jobs/manager.ts";
import { claimJobManager, clearJobManager, releaseJobManager, setJobManager } from "../extensions/jobs/registry.ts";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

function setup() {
	const root = mkdtempSync(path.join(tmpdir(), "jobs-test-"));
	const project = mkdtempSync(path.join(tmpdir(), "jobs-project-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const branch: Array<Record<string, unknown>> = [];
	const pi = { appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	const ctx = { cwd: project, ui: { setStatus: () => undefined }, sessionManager: { getSessionFile: () => "/tmp/jobs-parent.jsonl" } } as unknown as ExtensionContext;
	const manager = new JobManager(pi);
	cleanups.push(() => { process.env.PI_CODING_AGENT_DIR = previous; }, () => rmSync(root, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }), () => { clearJobManager(manager); void manager.shutdown(); });
	return { manager, ctx, branch };
}

describe("bounded Jobs", () => {
	it("retains a bounded tail and advances the cursor for one oversized output chunk", () => {
		const buffer = new JobBuffer(1_024);
		buffer.append("stdout", Buffer.alloc(5_000, "x"));
		const job = { spec: { id: "oversized" }, runtime: {} } as unknown as Parameters<JobBuffer["read"]>[0];
		const result = buffer.read(job, 0, 2_048);
		expect(buffer.bufferedBytes).toBeLessThanOrEqual(1_024);
		expect(result.chunks).toHaveLength(1);
		expect(result.chunks[0]?.text).toMatch(/^\[job chunk truncated: earlier bytes omitted\]/);
		expect(result.chunks[0]?.text).toMatch(/x+$/);
		expect(result.nextSeq).toBe(1);
		expect(result.earliestSeq).toBe(1);
	});

	it("captures cursor output and settles after process close", async () => {
		const { manager, ctx, branch } = setup();
		const started = await manager.start({ name: "echo", argv: [process.execPath, "-e", "console.log('hello'); console.error('warn'); setTimeout(()=>{},100)"], env: { SECRET_TOKEN: "do-not-persist" }, stdin: "private-input" }, ctx);
		const [job] = await manager.wait([started.spec.id]);
		const output = manager.read({ id: started.spec.id });

		expect(job?.runtime.status).toBe("completed");
		expect(output.chunks.map((chunk) => chunk.text).join("")).toContain("hello");
		expect(output.chunks.map((chunk) => chunk.text).join("")).toContain("warn");
		expect(branch.some((entry) => (entry.data as { type?: string })?.type === "emit")).toBe(true);
		const persistedSpec = readFileSync(path.join(started.spec.artifactsDir, "spec.json"), "utf8");
		expect(persistedSpec).not.toContain("do-not-persist");
		expect(persistedSpec).not.toContain("private-input");
		expect(job?.runtime.processIdentity).toBeTruthy();
		expect(job?.runtime.heartbeatAt).toBeTypeOf("number");

		const restored = new JobManager({ appendEntry() {} } as unknown as ExtensionAPI);
		await restored.restore(ctx);
		expect(restored.read({ id: started.spec.id }).chunks.map((chunk) => chunk.text).join("")).toContain("hello");
		expect(restored.clearTerminal(started.spec.id)).toBe(1);
		expect(() => restored.get(started.spec.id)).toThrow("Unknown job");
		await restored.shutdown();
	});

	it("rejects explicit detached-process syntax for shell and argv Jobs", async () => {
		const { manager, ctx } = setup();
		await expect(manager.start({ name: "shell-detach", command: "setsid node worker.js" }, ctx)).rejects.toThrow("Detached process launch");
		await expect(manager.start({ name: "argv-detach", argv: ["/usr/bin/setsid", "node", "worker.js"] }, ctx)).rejects.toThrow("Detached process launch");
		await expect(manager.start({ name: "argv-shell-detach", argv: ["bash", "-lc", "nohup node worker.js &"] }, ctx)).rejects.toThrow("Detached process launch");
		await expect(manager.start({ name: "argv-env-detach", argv: ["env", "MODE=test", "setsid", "node", "worker.js"] }, ctx)).rejects.toThrow("Detached process launch");
		await expect(manager.start({ name: "argv-env-unset-detach", argv: ["env", "-u", "FOO", "setsid", "node", "worker.js"] }, ctx)).rejects.toThrow("Detached process launch");
		await expect(manager.start({ name: "argv-fish-detach", argv: ["fish", "--command=setsid node worker.js"] }, ctx)).rejects.toThrow("Detached process launch");
	});

	it("keeps an active Job alive when a new hot-reload generation claims its manager", async () => {
		const { manager, ctx } = setup();
		const firstPi = { appendEntry() {} } as unknown as ExtensionAPI;
		setJobManager(manager);
		const first = claimJobManager(firstPi);
		const started = await first.manager.start({ name: "reload", argv: [process.execPath, "-e", "setTimeout(()=>{},3000)"], timeoutMs: 5_000 }, ctx);
		releaseJobManager(first.owner);
		const registry = (globalThis as typeof globalThis & { __deevsPiKitJobs?: { shutdownTimer?: NodeJS.Timeout } }).__deevsPiKitJobs;
		expect(registry?.shutdownTimer?.hasRef()).toBe(false);

		const second = claimJobManager({ appendEntry() {} } as unknown as ExtensionAPI);
		expect(second.manager).toBe(first.manager);
		await second.manager.restore(ctx);
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(second.manager.get(started.spec.id).runtime.status).toBe("running");
		await second.manager.stop(started.spec.id);
		clearJobManager(second.manager);
	});

	it("synchronously kills active process groups as a real-exit backstop", async () => {
		const { manager, ctx } = setup();
		const started = await manager.start({ name: "exit-backstop", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 5_000 }, ctx);
		manager.terminateActiveSync();
		const [settled] = await manager.wait([started.spec.id], 3_000);
		expect(settled.runtime.status).toBe("failed");
		expect(settled.runtime.exitSignal).toBe("SIGKILL");
	});

	it("restores Jobs only for their exact parent Pi session", async () => {
		const { manager, ctx } = setup();
		const started = await manager.start({ name: "owned", argv: [process.execPath, "-e", "console.log('done')"] }, ctx);
		await manager.wait([started.spec.id]);
		const other = new JobManager({ appendEntry() {} } as unknown as ExtensionAPI);
		const otherCtx = { ...ctx, sessionManager: { getSessionFile: () => "/tmp/other-jobs-parent.jsonl" } } as ExtensionContext;
		await manager.restore(otherCtx);
		expect(manager.list()).toEqual([]);
		await other.restore(otherCtx);
		expect(other.list()).toEqual([]);
		const spec = JSON.parse(readFileSync(path.join(started.spec.artifactsDir, "spec.json"), "utf8")) as Record<string, unknown>;
		delete spec.parentSessionFile;
		writeFileSync(path.join(started.spec.artifactsDir, "spec.json"), JSON.stringify(spec));
		const legacy = new JobManager({ appendEntry() {} } as unknown as ExtensionAPI);
		await legacy.restore(ctx);
		expect(legacy.list()).toEqual([]);
		await Promise.all([other.shutdown(), legacy.shutdown()]);
	});

	it("hides and quiesces an active Job when the same manager switches parent sessions", async () => {
		const { manager, ctx, branch } = setup();
		const started = await manager.start({ name: "active-owned", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, ctx);
		const otherCtx = { ...ctx, sessionManager: { getSessionFile: () => "/tmp/other-jobs-parent.jsonl" } } as ExtensionContext;
		await manager.restore(otherCtx);
		expect(manager.list()).toEqual([]);
		const runtime = JSON.parse(readFileSync(started.spec.runtimePath, "utf8")) as { status: string };
		expect(runtime.status).toBe("cancelled");
		const oldTerminalEvents = branch.filter((entry) => {
			const operation = entry.data as { type?: string; event?: { source?: { id?: string } } };
			return operation.type === "emit" && operation.event?.source?.id === started.spec.id;
		});
		expect(oldTerminalEvents).toEqual([]);
	});

	it("does not postpone SIGKILL when stop is requested repeatedly", async () => {
		const { manager, ctx } = setup();
		const started = await manager.start({ name: "repeat-stop", argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"] }, ctx);
		const internal = manager as unknown as { active: Map<string, { killTimer?: NodeJS.Timeout }> };
		const first = manager.stop(started.spec.id);
		const killTimer = internal.active.get(started.spec.id)?.killTimer;
		const second = manager.stop(started.spec.id);
		expect(internal.active.get(started.spec.id)?.killTimer).toBe(killTimer);
		await Promise.all([first, second]);
	});

	it("resolves an internal hidden-job wait timeout from its captured record", async () => {
		const { manager, ctx } = setup();
		const started = await manager.start({ name: "hidden-wait", argv: [process.execPath, "-e", "console.log('done')"] }, ctx);
		await manager.wait([started.spec.id]);
		started.runtime.status = "stopping";
		const internal = manager as unknown as { hidden: Set<string>; waitOne: (id: string, waitMs: number, signal: undefined, includeHidden: boolean) => Promise<typeof started> };
		internal.hidden.add(started.spec.id);
		await expect(internal.waitOne(started.spec.id, 1, undefined, true)).resolves.toBe(started);
	});

	it("preserves the configured output cap and cursor drops after restore", async () => {
		const { manager, ctx } = setup();
		const script = `let i=0;const timer=setInterval(()=>{console.log(String(i++ % 10).repeat(200));if(i===20)clearInterval(timer)},5);`;
		const started = await manager.start({ name: "capped", argv: [process.execPath, "-e", script], maxBytes: 1_024 }, ctx);
		await manager.wait([started.spec.id]);
		const before = manager.read({ id: started.spec.id, maxBytes: 10_000 });
		expect(before.job.spec.maxBufferBytes).toBe(1_024);
		expect(before.job.runtime.bufferedBytes).toBeLessThanOrEqual(1_024);
		expect(before.earliestSeq).toBeGreaterThan(1);
		expect(before.chunks.length).toBeGreaterThan(0);
		expect(statSync(started.spec.spoolPath).size).toBeLessThan(2_048);
		const metadata = readFileSync(started.spec.spoolPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; nextSeq?: number; droppedBytes?: number }).reverse().find((record) => record.type === "meta")! as { nextSeq: number; droppedBytes: number };
		expect(metadata.nextSeq).toBe(before.chunks.at(-1)!.seq + 1);
		expect(metadata.droppedBytes).toBeGreaterThan(0);

		const restored = new JobManager({ appendEntry() {} } as unknown as ExtensionAPI);
		await restored.restore(ctx);
		const after = restored.read({ id: started.spec.id, maxBytes: 10_000 });
		expect(after.job.runtime.bufferedBytes).toBeLessThanOrEqual(1_024);
		expect(after.job.runtime.droppedBytes).toBe(before.job.runtime.droppedBytes);
		expect(after.earliestSeq).toBe(before.earliestSeq);
		expect(after.chunks.map((chunk) => chunk.text)).toEqual(before.chunks.map((chunk) => chunk.text));
		expect(after.droppedBeforeSeq).toBe(before.earliestSeq - 1);
		await restored.shutdown();
	});

	it("waits for readiness without treating the live process as terminal", async () => {
		const { manager, ctx } = setup();
		const ready = await manager.start({
			name: "ready",
			argv: [process.execPath, "-e", "process.stdout.write('REA'); setTimeout(()=>console.log('DY'),10); setTimeout(()=>{},100)"],
			readyPattern: "READY",
			readyTimeoutMs: 1_000,
		}, ctx);
		expect(ready.runtime.ready).toBe(true);
		expect(ready.runtime.status).toBe("running");
		const [settled] = await manager.wait([ready.spec.id]);
		expect(settled?.runtime.status).toBe("completed");
	});

	it("does not arm a timeout after readiness arrived during identity lookup", async () => {
		const { manager, ctx } = setup();
		const ready = await manager.start({
			name: "immediately-ready",
			argv: [process.execPath, "-e", "console.log('READY'); setTimeout(()=>{},300)"],
			readyPattern: "READY",
			readyTimeoutMs: 50,
		}, ctx);
		expect(ready.runtime.ready).toBe(true);
		const [settled] = await manager.wait([ready.spec.id]);
		expect(settled?.runtime.status).toBe("completed");
	});

	it("keeps live owned jobs intact during restore and cancels readiness waits on abort", async () => {
		const { manager, ctx } = setup();
		const live = await manager.start({ name: "live", argv: [process.execPath, "-e", "setTimeout(()=>{},300)"], timeoutMs: 2_000 }, ctx);
		await manager.restore(ctx);
		expect(manager.get(live.spec.id).runtime.status).toBe("running");

		const staleRuntime = JSON.parse(readFileSync(live.spec.runtimePath, "utf8")) as typeof live.runtime;
		writeFileSync(live.spec.runtimePath, JSON.stringify({ ...staleRuntime, processIdentity: "reused-pid" }));
		const restored = new JobManager({ appendEntry() {} } as unknown as ExtensionAPI);
		await restored.restore(ctx);
		expect(restored.get(live.spec.id).runtime.status).toBe("lost");
		expect(isAlive(live.runtime.pid!)).toBe(true);
		await restored.shutdown();
		await manager.stop(live.spec.id);

		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("cancel readiness")), 50);
		await expect(manager.start({
			name: "never-ready",
			argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
			readyPattern: "READY",
			readyTimeoutMs: 5_000,
		}, ctx, controller.signal)).rejects.toThrow("cancel readiness");
		expect(manager.list().find((job) => job.spec.name === "never-ready")?.runtime.status).toBe("cancelled");
	});

	it("captures output and exit status from zero-delay Jobs", async () => {
		const { manager, ctx } = setup();
		for (let index = 0; index < 5; index++) {
			const started = await manager.start({ name: `true-${index}`, argv: ["/usr/bin/true"], timeoutMs: 2_000 }, ctx);
			const [settled] = await manager.wait([started.spec.id]);
			expect(settled!.runtime.status).toBe("completed");
		}
		const echo = await manager.start({ name: "echo", argv: ["/bin/echo", "hello"], timeoutMs: 2_000 }, ctx);
		const [settled] = await manager.wait([echo.spec.id]);
		expect(settled!.runtime.status).toBe("completed");
		expect(manager.read({ id: echo.spec.id }).chunks.map((chunk) => chunk.text).join("")).toContain("hello");
	});

	it("rejects a wait whose signal is already aborted", async () => {
		const { manager, ctx } = setup();
		const started = await manager.start({ name: "waiting", argv: [process.execPath, "-e", "setTimeout(()=>{},300)"], timeoutMs: 2_000 }, ctx);
		const controller = new AbortController();
		controller.abort(new Error("already cancelled"));
		await expect(manager.wait([started.spec.id], undefined, controller.signal)).rejects.toThrow("already cancelled");
		await manager.stop(started.spec.id);
	});

	it("enforces timeout and process-tree cancellation", async () => {
		const { manager, ctx } = setup();
		const started = await manager.start({ name: "hang", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 100 }, ctx);
		const [timedOut] = await manager.wait([started.spec.id]);
		expect(timedOut?.runtime.status).toBe("timeout");

		const second = await manager.start({ name: "cancel", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 5_000 }, ctx);
		const cancelled = await manager.stop(second.spec.id);
		expect(cancelled.runtime.status).toBe("cancelled");

		const pidFile = path.join(ctx.cwd, "job-descendant.pid");
		const stubborn = await manager.start({
			name: "stubborn-tree",
			argv: [process.execPath, "-e", `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));console.log('DESCENDANT_READY');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`],
			readyPattern: "DESCENDANT_READY",
			readyTimeoutMs: 1_000,
			timeoutMs: 5_000,
		}, ctx);
		const treeStopped = await manager.stop(stubborn.spec.id);
		const descendantPid = Number(readFileSync(pidFile, "utf8"));
		expect(treeStopped.runtime.status).toBe("cancelled");
		expect(isAlive(descendantPid)).toBe(false);
	});
});

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
