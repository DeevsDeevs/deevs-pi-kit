import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workflowExtension from "../extensions/workflow/index.ts";
import { DelegateExecutor } from "../extensions/subagents/executor.ts";
import { SubagentService } from "../extensions/subagents/service.ts";
import { clearSubagentService, setSubagentService } from "../extensions/subagents/registry.ts";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()));

async function setup(trusted = true, hangAgents = false) {
	const root = mkdtempSync(path.join(tmpdir(), "workflow-test-"));
	const project = mkdtempSync(path.join(tmpdir(), "workflow-project-"));
	const branch: Array<Record<string, unknown>> = [];
	const widgetUpdates: Array<{ key: string; value: unknown }> = [];
	let tool: { execute: (...args: unknown[]) => Promise<{ details?: unknown; isError?: boolean; usage?: { totalTokens: number; cost: { total: number } } }> } | undefined;
	const pi = {
		registerTool(value: typeof tool) { tool = value; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: project,
		hasUI: true,
		ui: { setWidget: (key: string, value: unknown) => widgetUpdates.push({ key, value }), setStatus() {} },
		isProjectTrusted: () => trusted,
		isIdle: () => false,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => "/tmp/parent.jsonl", getBranch: () => branch },
	} as unknown as ExtensionContext;
	const executor = new DelegateExecutor({
		artifactsRoot: root,
		command: (spec) => {
			if (hangAgents) return { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] };
			const message = { role: "assistant", content: [{ type: "text", text: `${spec.persona} result` }], usage: { input: 3, output: 2, cost: { total: 0.002 } } };
			return { command: process.execPath, args: ["-e", `const m=${JSON.stringify(message)};console.log(JSON.stringify({type:'message_end',message:m}));console.log(JSON.stringify({type:'turn_end',message:m,toolResults:[]}));console.log(JSON.stringify({type:'agent_settled'}));`] };
		},
	});
	const service = new SubagentService(pi, executor, root);
	service.setContext(ctx);
	setSubagentService(service);
	workflowExtension(pi);
	cleanups.push(() => { clearSubagentService(service); service.dispose(); }, () => rmSync(root, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }));
	if (!tool) throw new Error("workflow tool was not registered");
	return { tool, ctx, service, branch, widgetUpdates, reload: () => { workflowExtension(pi); return tool!; } };
}

async function execute(tool: { execute: (...args: unknown[]) => Promise<{ details?: unknown; isError?: boolean; usage?: { totalTokens: number; cost: { total: number } } }> }, ctx: ExtensionContext, source: string, timeoutMs = 2_000) {
	return tool.execute("call", { source, timeoutMs }, undefined, () => undefined, ctx);
}

describe("trusted workflow runtime", () => {
	it("runs read-only agent calls through the shared executor and waits for quiescence", async () => {
		const { tool, ctx, branch } = await setup();
		const result = await execute(tool, ctx, `const run = await agent({ agent: "reviewer", task: "Review it." }); return { status: run.status, output: run.output };`);
		const details = result.details as { status: string; completedAgents: number; activeAgents: number; result: unknown };

		expect(details.status).toBe("completed");
		expect(details.completedAgents).toBe(1);
		expect(details.activeAgents).toBe(0);
		expect(details.result).toEqual({ status: "completed", output: "reviewer result" });
		expect(result.usage).toMatchObject({ totalTokens: 5, cost: { total: 0.002 } });
		expect(branch.some((entry) => JSON.stringify(entry).includes('"type":"emit"'))).toBe(false);
	});

	it("uses one race-safe widget for concurrent Workflows", async () => {
		const { tool, ctx, widgetUpdates } = await setup();
		await Promise.all([
			execute(tool, ctx, `await new Promise(resolve => setTimeout(resolve, 80)); return "one";`),
			execute(tool, ctx, `await new Promise(resolve => setTimeout(resolve, 120)); return "two";`),
		]);
		expect(new Set(widgetUpdates.map((update) => update.key))).toEqual(new Set(["workflow:fleet"]));
		expect(widgetUpdates.filter((update) => update.value === undefined)).toHaveLength(1);
		expect(widgetUpdates.at(-1)?.value).toBeUndefined();
	});

	it("isolates fleet state between unsaved sessions in the same cwd", async () => {
		const { tool, ctx, widgetUpdates } = await setup();
		const otherCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "other-session", getSessionFile: () => undefined } } as ExtensionContext;
		const unsavedCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "unsaved-session", getSessionFile: () => undefined } } as ExtensionContext;
		await Promise.all([
			execute(tool, unsavedCtx, `await new Promise(resolve => setTimeout(resolve, 80)); return "one";`),
			execute(tool, otherCtx, `await new Promise(resolve => setTimeout(resolve, 120)); return "two";`),
		]);
		const theme = { fg: (_color: string, text: string) => text };
		const renderedHeaders = widgetUpdates.flatMap((update) => {
			if (typeof update.value !== "function") return [];
			const component = update.value({}, theme);
			return [component.render(80)[0]];
		});
		expect(renderedHeaders.every((line) => line.includes("◆ Workflow ") && !line.includes("◆ Workflows "))).toBe(true);
	});

	it("does not let an older hot-reload generation clear a newer Workflow widget", async () => {
		const { tool: oldTool, ctx, widgetUpdates, reload } = await setup();
		const oldRun = execute(oldTool, ctx, `await new Promise(resolve => setTimeout(resolve, 80)); return "old";`);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const newTool = reload();
		const newRun = execute(newTool, ctx, `await new Promise(resolve => setTimeout(resolve, 140)); return "new";`);
		await Promise.all([oldRun, newRun]);
		expect(widgetUpdates.filter((update) => update.value === undefined)).toHaveLength(1);
		expect(widgetUpdates.at(-1)?.value).toBeUndefined();
	});

	it("rejects untrusted projects before evaluating JavaScript", async () => {
		const { tool, ctx } = await setup(false);
		await expect(execute(tool, ctx, `throw new Error("should not run")`)).rejects.toThrow("trusted project");
	});

	it("terminates a synchronous infinite loop at the hard timeout", async () => {
		const { tool, ctx } = await setup();
		const result = await execute(tool, ctx, `while (true) {}`, 1_000);
		const details = result.details as { status: string; error: string };
		expect(result.isError).toBeUndefined();
		expect(details.status).toBe("timeout");
		expect(details.error).toContain("timed out");
	});

	it("settles and quiesces through executor fallback when service cancellation rejects", async () => {
		const { tool, ctx, service } = await setup(true, true);
		const originalWait = service.wait.bind(service);
		service.wait = ((request, signal) => request.cancel ? Promise.reject(new Error("synthetic service cancellation failure")) : originalWait(request, signal)) as typeof service.wait;
		const result = await execute(tool, ctx, `agent({ agent: "reviewer", task: "hang" }); while (true) {}`, 1_000);
		expect((result.details as { status: string }).status).toBe("timeout");
		expect(service.list().runs.filter((run) => ["starting", "running", "stopping"].includes(run.runtime.status))).toEqual([]);
	});

	it("cannot hang when both cancellation APIs reject", async () => {
		const { tool, ctx, service } = await setup(true, true);
		const originalWait = service.wait.bind(service);
		service.wait = ((request, signal) => request.cancel ? Promise.reject(new Error("synthetic service cancellation failure")) : originalWait(request, signal)) as typeof service.wait;
		service.executor.cancel = (async () => { throw new Error("synthetic executor cancellation failure"); }) as typeof service.executor.cancel;
		const startedAt = Date.now();
		const result = await execute(tool, ctx, `agent({ agent: "reviewer", task: "hang" }); while (true) {}`, 1_000);
		expect((result.details as { status: string }).status).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(8_000);
	});

	it("does not launch or leave orphan agents after workflow timeout", async () => {
		const { tool, ctx, service } = await setup(true, true);
		const result = await execute(tool, ctx, `agent({ agent: "reviewer", task: "hang" }); while (true) {}`, 1_000);
		expect(result.isError).toBeUndefined();
		expect((result.details as { status: string }).status).toBe("timeout");
		expect(service.list().runs.filter((run) => ["starting", "running", "stopping"].includes(run.runtime.status))).toEqual([]);
	});
});
