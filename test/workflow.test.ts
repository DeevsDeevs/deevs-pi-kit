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
	let tool: { execute: (...args: unknown[]) => Promise<{ details?: unknown; isError?: boolean; usage?: { totalTokens: number; cost: { total: number } } }> } | undefined;
	const pi = {
		registerTool(value: typeof tool) { tool = value; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: project,
		isProjectTrusted: () => trusted,
		isIdle: () => false,
		hasPendingMessages: () => false,
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getBranch: () => branch },
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
	return { tool, ctx, service, branch };
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

	it("does not launch or leave orphan agents after workflow timeout", async () => {
		const { tool, ctx, service } = await setup(true, true);
		const result = await execute(tool, ctx, `agent({ agent: "reviewer", task: "hang" }); while (true) {}`, 1_000);
		expect(result.isError).toBeUndefined();
		expect((result.details as { status: string }).status).toBe("timeout");
		expect(service.list().runs.filter((run) => ["starting", "running", "stopping"].includes(run.runtime.status))).toEqual([]);
	});
});
