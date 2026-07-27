import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DelegateExecutor } from "../extensions/subagents/executor.ts";
import { SubagentService, type SubagentGroup } from "../extensions/subagents/service.ts";
import { DEFAULT_TIMEOUT_MS } from "../extensions/subagents/config.ts";
import type { DelegateRun } from "../extensions/subagents/runtime-types.ts";
import { chainCheckpoints } from "../extensions/chains/checkpoint.ts";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));

function setup(failReviewer = false) {
	const root = mkdtempSync(path.join(tmpdir(), "subagent-service-"));
	const project = mkdtempSync(path.join(tmpdir(), "subagent-project-"));
	const branch: Array<Record<string, unknown>> = [];
	const pi = {
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: project,
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getBranch: () => branch },
		isIdle: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const executor = new DelegateExecutor({
		artifactsRoot: root,
		command: (spec) => {
			if (failReviewer && spec.persona === "reviewer") throw new Error("reviewer launch failed");
			const message = { role: "assistant", content: [{ type: "text", text: `${spec.persona} done` }], usage: { input: 2, output: 1, cost: { total: 0.001 } } };
			const script = `const m=${JSON.stringify(message)}; setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:m}));console.log(JSON.stringify({type:'turn_end',message:m,toolResults:[]}));console.log(JSON.stringify({type:'agent_settled'}));},25);`;
			return { command: process.execPath, args: ["-e", script] };
		},
	});
	const service = new SubagentService(pi, executor, root);
	service.setContext(ctx);
	cleanup.push(() => service.dispose(), () => rmSync(root, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }));
	return { service, ctx, branch, root, project, pi };
}

describe("SubagentService", () => {
	it("uses generous defaults unless the orchestrator supplies tighter limits", async () => {
		const { service, ctx } = setup();
		const defaulted = await service.start({ agent: "explorer", task: "Inspect." }, ctx);
		expect((defaulted as { spec: { limits: { wallMs: number; turns?: number } } }).spec.limits).toMatchObject({ wallMs: DEFAULT_TIMEOUT_MS });
		const limited = await service.start({ agent: "explorer", task: "Inspect.", wallMs: 1_234, turns: 2 }, ctx);
		expect((limited as { spec: { limits: { wallMs: number; turns?: number } } }).spec.limits).toMatchObject({ wallMs: 1_234, turns: 2 });
		const modeled = await service.start({ agent: "explorer", task: "Inspect.", model: "provider/model", background: false }, ctx);
		expect((modeled as { spec: { model?: string } }).spec.model).toBe("provider/model");
	});

	it("records a write-enabled terminal Chain obligation only once across reload", async () => {
		const { service, ctx, root, pi } = setup();
		const previous = chainCheckpoints.current;
		const due = vi.fn();
		chainCheckpoints.current = { due } as unknown as NonNullable<typeof chainCheckpoints.current>;
		try {
			const run = await service.start({ agent: "reviewer", task: "Write." }, ctx) as DelegateRun;
			run.spec.allowWrite = true;
			const specPath = path.join(run.spec.artifactsDir, "spec.json");
			writeFileSync(specPath, JSON.stringify(run.spec));
			await service.wait({ ids: [run.spec.id], waitMs: 3_000 });
			expect(due).toHaveBeenCalledTimes(1);
			expect(JSON.parse(readFileSync(run.spec.runtimePath, "utf8")).chainCheckpointRecordedAt).toBeTypeOf("number");

			service.dispose();
			const restored = new SubagentService(pi, new DelegateExecutor({ artifactsRoot: root }), root);
			cleanup.push(() => restored.dispose());
			await restored.restore(ctx);
			expect(due).toHaveBeenCalledTimes(1);
		} finally {
			chainCheckpoints.current = previous;
		}
	});

	it("restores only runs owned by the exact parent Pi session", async () => {
		const { service, ctx, root, project, pi } = setup();
		const started = await service.start({ agent: "explorer", task: "Inspect." }, ctx) as { spec: { id: string } };
		service.dispose();
		const otherCtx = { ...ctx, cwd: project, sessionManager: { ...ctx.sessionManager, getSessionFile: () => "/tmp/other-parent.jsonl" } } as ExtensionContext;
		await service.restore(otherCtx);
		expect(service.list().runs).toEqual([]);
		const otherExecutor = new DelegateExecutor({ artifactsRoot: root });
		const otherService = new SubagentService(pi, otherExecutor, root);
		cleanup.push(() => otherService.dispose());
		await otherService.restore(otherCtx);
		expect(otherService.list().runs).toEqual([]);
		const originalExecutor = new DelegateExecutor({ artifactsRoot: root });
		const originalService = new SubagentService(pi, originalExecutor, root);
		cleanup.push(() => originalService.dispose());
		await originalService.restore(ctx);
		expect((await originalExecutor.wait(started.spec.id, 3_000)).runtime.status).toBe("completed");
	});

	it("detaches prior-session runs and groups when the current session is unsaved", async () => {
		const { service, ctx } = setup();
		await service.start({ agent: "explorer", task: "Inspect.", background: false }, ctx);
		await service.start({ tasks: [{ agent: "reviewer", task: "Review." }], background: false }, ctx);
		expect(service.list().runs.length).toBeGreaterThan(0);
		expect(service.list().groups.length).toBeGreaterThan(0);

		const unsavedCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => undefined } } as ExtensionContext;
		await service.restore(unsavedCtx);
		expect(service.list()).toEqual({ runs: [], groups: [] });
	});

	it("restores a standalone alternate-cwd run through the durable parent root index", async () => {
		const parentRoot = mkdtempSync(path.join(tmpdir(), "subagent-parent-root-"));
		const childRoot = mkdtempSync(path.join(tmpdir(), "subagent-child-root-"));
		const parentCwd = mkdtempSync(path.join(tmpdir(), "subagent-parent-cwd-"));
		const childCwd = mkdtempSync(path.join(tmpdir(), "subagent-child-cwd-"));
		const parentSessionFile = "/tmp/alternate-parent.jsonl";
		const pi = { appendEntry: () => undefined } as unknown as ExtensionAPI;
		const ctx = { cwd: parentCwd, sessionManager: { getSessionFile: () => parentSessionFile, getBranch: () => [] }, isIdle: () => false, hasPendingMessages: () => false } as unknown as ExtensionContext;
		const message = { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cost: { total: 0 } } };
		const command = () => ({ command: process.execPath, args: ["-e", `const m=${JSON.stringify(message)};console.log(JSON.stringify({type:'message_end',message:m}));console.log(JSON.stringify({type:'turn_end',message:m,toolResults:[]}));console.log(JSON.stringify({type:'agent_settled'}));`] });
		const service = new SubagentService(pi, new DelegateExecutor({ artifactsRoot: childRoot, command }), parentRoot);
		cleanup.push(() => service.dispose(), ...[parentRoot, childRoot, parentCwd, childCwd].map((root) => () => rmSync(root, { recursive: true, force: true })));
		const run = await service.start({ agent: "explorer", task: "Inspect.", cwd: childCwd }, ctx) as DelegateRun;
		await service.wait({ ids: [run.spec.id], waitMs: 3_000 });
		expect(readdirSync(path.join(parentRoot, "roots"))).toHaveLength(1);
		service.dispose();
		const restoredExecutor = new DelegateExecutor({ artifactsRoot: parentRoot });
		const restoreRoot = vi.spyOn(restoredExecutor, "restoreRoot");
		const restored = new SubagentService(pi, restoredExecutor, parentRoot);
		cleanup.push(() => restored.dispose());
		await restored.restore(ctx);
		expect(restoreRoot).toHaveBeenCalledWith(childRoot, parentSessionFile);
		expect(restored.list().runs.some((candidate) => candidate.spec.id === run.spec.id)).toBe(true);
	});

	it("does not adopt legacy groups without exact parent-session ownership", async () => {
		const { service, ctx, root } = setup();
		mkdirSync(path.join(root, "groups"), { recursive: true });
		writeFileSync(path.join(root, "groups/legacy.json"), JSON.stringify({
			version: 1, id: "legacy", generation: "generation", status: "completed", cwd: ctx.cwd,
			createdAt: Date.now(), concurrency: 1, failFast: false, pending: [], children: [], active: [], launchFailures: [],
		}));
		await service.restore(ctx);
		expect(service.list().groups).toEqual([]);
	});

	it("degrades an owned group with a missing child record instead of failing restore", async () => {
		const { service, ctx, root } = setup();
		mkdirSync(path.join(root, "groups"), { recursive: true });
		writeFileSync(path.join(root, "groups/missing-child.json"), JSON.stringify({
			version: 1,
			id: "missing-child",
			generation: "generation",
			status: "running",
			cwd: ctx.cwd,
			createdAt: Date.now(),
			concurrency: 1,
			failFast: false,
			pending: [],
			children: ["absent-run"],
			active: ["absent-run"],
			launchFailures: [],
			parentSessionFile: "/tmp/parent.jsonl",
			childRoots: {},
		}));
		await expect(service.restore(ctx)).resolves.toBeUndefined();
		const group = service.list().groups.find((candidate) => candidate.id === "missing-child");
		expect(group).toMatchObject({ status: "failed", active: [], launchFailures: ["Missing child run record: absent-run"] });
	});

	it("runs a persisted bounded parallel group to quiescence", async () => {
		const { service, ctx, branch } = setup();
		const result = await service.start({
			tasks: [
				{ agent: "explorer", task: "Inspect one file." },
				{ agent: "reviewer", task: "Review one file." },
			],
			concurrency: 1,
			background: false,
		}, ctx) as SubagentGroup;

		expect(result.status).toBe("completed");
		expect(result.children).toHaveLength(2);
		expect(Object.keys(result.childRoots ?? {})).toEqual(result.children);
		expect(result.active).toEqual([]);
		expect(result.pending).toEqual([]);
		const emittedKinds = branch
			.map((entry) => entry.data as { type?: string; event?: { source?: { kind?: string } } })
			.filter((operation) => operation?.type === "emit")
			.map((operation) => operation.event?.source?.kind);
		expect(emittedKinds).toContain("subagent-group");
	});

	it("does not let already-terminal fast children stall pending group tasks", async () => {
		const { service, ctx } = setup();
		const originalStart = service.executor.start.bind(service.executor);
		vi.spyOn(service.executor, "start").mockImplementation(async (input) => {
			const run = await originalStart(input);
			await service.executor.cancel(run.spec.id);
			run.runtime.status = "completed";
			run.runtime.endedAt = Date.now();
			writeFileSync(run.spec.runtimePath, JSON.stringify(run.runtime));
			return run;
		});
		const group = await service.start({ tasks: [{ agent: "explorer", task: "Fast one." }, { agent: "reviewer", task: "Fast two." }], concurrency: 1 }, ctx) as SubagentGroup;
		expect(group.children).toHaveLength(2);
		expect(group.pending).toEqual([]);
		expect(group.active).toEqual([]);
		expect(group.status).not.toBe("running");
	});

	it("waits for active children and emits a terminal partial group after launch failure", async () => {
		const { service, ctx, branch } = setup(true);
		const result = await service.start({
			tasks: [{ agent: "explorer", task: "Inspect." }, { agent: "reviewer", task: "Review." }],
			concurrency: 2,
			background: false,
		}, ctx) as SubagentGroup;
		expect(result.status).toBe("partial");
		expect(result.active).toEqual([]);
		expect(result.launchFailures).toEqual(["reviewer launch failed"]);
		expect(branch.some((entry) => (entry.data as { event?: { source?: { kind?: string } } })?.event?.source?.kind === "subagent-group")).toBe(true);
	});

	it("enforces the configured global concurrency limit across fresh runs", async () => {
		const { service, ctx } = setup();
		mkdirSync(path.join(ctx.cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(ctx.cwd, ".pi/subagents.json"), JSON.stringify({ parallelMaxConcurrency: 1 }));
		const originalStart = service.executor.start.bind(service.executor);
		let releaseLaunch!: () => void;
		let launchEntered!: () => void;
		const entered = new Promise<void>((resolve) => { launchEntered = resolve; });
		const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
		vi.spyOn(service.executor, "start").mockImplementationOnce(async (input) => {
			launchEntered();
			await gate;
			return originalStart(input);
		});
		const first = service.start({ agent: "explorer", task: "First." }, ctx);
		await entered;
		await expect(service.start({ agent: "reviewer", task: "Second." }, ctx)).rejects.toThrow("concurrency limit reached (1)");
		releaseLaunch();
		const run = await first;
		await service.executor.cancel((run as { spec: { id: string } }).spec.id);
	});

	it("waits for capacity changes instead of spinning a pending group", async () => {
		const { service, ctx } = setup();
		mkdirSync(path.join(ctx.cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(ctx.cwd, ".pi/subagents.json"), JSON.stringify({ parallelMaxConcurrency: 1 }));
		const first = await service.start({ agent: "explorer", task: "Occupy capacity." }, ctx) as DelegateRun;
		const group = await service.start({ tasks: [{ agent: "reviewer", task: "Run after capacity." }], concurrency: 1 }, ctx) as SubagentGroup;
		expect(group.pending).toHaveLength(1);
		expect(group.active).toEqual([]);
		const [settled] = await service.wait({ ids: [group.id], waitMs: 3_000 });
		expect((settled as SubagentGroup).status).toBe("completed");
		expect((settled as SubagentGroup).children).toHaveLength(1);
		expect(service.executor.get(first.spec.id).runtime.status).toBe("completed");
	});

	it("serializes cancellation with an in-flight group launch", async () => {
		const { service, ctx } = setup();
		const originalStart = service.executor.start.bind(service.executor);
		let releaseLaunch!: () => void;
		let launchEntered!: () => void;
		const entered = new Promise<void>((resolve) => { launchEntered = resolve; });
		const gate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
		vi.spyOn(service.executor, "start").mockImplementation(async (input) => {
			launchEntered();
			await gate;
			return originalStart(input);
		});
		const starting = service.start({ tasks: [{ agent: "explorer", task: "Inspect." }], concurrency: 1 }, ctx);
		await entered;
		const group = service.list().groups[0]!;
		const cancelling = service.wait({ ids: [group.id], cancel: true, waitMs: 0 });
		releaseLaunch();
		await starting;
		const [result] = await cancelling;
		expect((result as SubagentGroup).status).toBe("cancelled");
		expect((result as SubagentGroup).active).toEqual([]);
	});

	it("withholds group terminal cancellation while a child is still stopping", async () => {
		const { service, ctx, branch } = setup();
		const group = await service.start({ tasks: [{ agent: "explorer", task: "Inspect." }], concurrency: 1 }, ctx) as SubagentGroup;
		vi.spyOn(service.executor, "cancel").mockImplementation(async (id) => {
			const run = service.executor.get(id);
			run.runtime.status = "stopping";
			return run;
		});
		const [result] = await service.wait({ ids: [group.id], cancel: true, waitMs: 0 });
		expect((result as SubagentGroup).status).toBe("running");
		expect(branch.some((entry) => (entry.data as { event?: { source?: { kind?: string; id?: string } } })?.event?.source?.kind === "subagent-group" && (entry.data as { event?: { source?: { id?: string } } }).event?.source?.id === group.id)).toBe(false);
	});

	it("enforces interactive write authorization and persona tool policy at the service boundary", async () => {
		const { service, ctx } = setup();
		const deniedCtx = { ...ctx, mode: "tui", ui: { confirm: async () => false } } as unknown as ExtensionContext;
		const approvedCtx = { ...ctx, mode: "tui", ui: { confirm: async () => true } } as unknown as ExtensionContext;
		await expect(service.start({ agent: "reviewer", task: "Edit it.", allowWrite: true }, deniedCtx)).rejects.toThrow("not authorized");
		await expect(service.start({ agent: "reviewer", task: "Edit it.", tools: ["edit"] }, ctx)).rejects.toThrow("not allowed");
		const authorized = await service.start({ agent: "reviewer", task: "Edit it.", allowWrite: true, background: false }, approvedCtx);
		expect((authorized as { spec: { id: string; tools: string[] } }).spec.tools).toContain("edit");
		await expect(service.start({ resume: (authorized as { spec: { id: string } }).spec.id, task: "Continue." }, deniedCtx)).rejects.toThrow("not authorized");
	});
});
