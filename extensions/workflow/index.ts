import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSubagentService } from "../subagents/registry.ts";
import type { DelegateRun } from "../subagents/runtime-types.ts";
import { toToolUsage } from "../shared/runtime-events.ts";
import { formatDuration, formatUsage } from "../shared/runtime-ui.ts";

const WORKER_URL = new URL("./worker.ts", import.meta.url);
const MAX_SOURCE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_AGENT_CONCURRENCY = 3;

const WorkflowSchema = Type.Object({
	source: Type.String({ description: "Trusted JavaScript function body. Use await agent({agent, task, ...}) and return structured-cloneable data." }),
	input: Type.Optional(Type.Unknown({ description: "Structured-cloneable workflow input available as input" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Hard workflow timeout, capped at five minutes" })),
});

interface WorkflowInput {
	source: string;
	input?: unknown;
	timeoutMs?: number;
}

interface WorkflowDetails {
	id: string;
	status: "running" | "completed" | "failed" | "cancelled" | "timeout";
	startedAt: number;
	endedAt?: number;
	activeAgents: number;
	completedAgents: number;
	runs: DelegateRun[];
	result?: unknown;
	error?: string;
}

export default function workflowExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: "Run trusted-project JavaScript in a terminable worker over the shared read-only Subagent executor.",
		promptSnippet: "Compose bounded foreground read-only agent workflows in trusted projects.",
		promptGuidelines: [
			"Only use in a trusted project.",
			"Workflow JavaScript is trusted code, not a security sandbox.",
			"Initial workflows are foreground, non-resumable, and force all child agents read-only.",
			"Return structured-cloneable data and await every agent() call.",
		],
		parameters: WorkflowSchema,
		async execute(_toolCallId, params: WorkflowInput, signal, onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) throw new Error("workflow requires an explicitly trusted project.");
			if (Buffer.byteLength(params.source) > MAX_SOURCE_BYTES) throw new Error(`workflow source exceeds ${MAX_SOURCE_BYTES} bytes.`);
			const service = getSubagentService();
			service.setContext(ctx);
			const id = `wf_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
			const timeoutMs = clampTimeout(params.timeoutMs);
			const details: WorkflowDetails = { id, status: "running", startedAt: Date.now(), activeAgents: 0, completedAgents: 0, runs: [] };
			const update = (): void => onUpdate?.({ content: [{ type: "text", text: formatWorkflow(details) }], details });
			update();

			try {
				const result = await runWorkflow(params, details, service, ctx, timeoutMs, signal, update);
				details.status = "completed";
				details.result = result;
				details.endedAt = Date.now();
				return { content: [{ type: "text" as const, text: formatWorkflow(details) }], details, usage: toToolUsage(sumUsage(details.runs)) };
			} catch (error) {
				details.status = signal?.aborted ? "cancelled" : error instanceof WorkflowTimeoutError ? "timeout" : "failed";
				details.error = error instanceof Error ? error.message : String(error);
				details.endedAt = Date.now();
				return { content: [{ type: "text" as const, text: formatWorkflow(details) }], details, usage: toToolUsage(sumUsage(details.runs)) };
			}
		},
		renderCall(args: WorkflowInput, theme: Theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("muted", `${Buffer.byteLength(args.source)} bytes`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as WorkflowDetails | undefined;
			if (!details) return new Text("No workflow details", 0, 0);
			let text = theme.fg(details.status === "completed" ? "success" : details.status === "running" ? "warning" : "error", details.status);
			text += ` ${theme.fg("accent", details.id)} · ${details.completedAgents} agent(s) · ${formatDuration((details.endedAt ?? Date.now()) - details.startedAt)}`;
			if (expanded && details.error) text += `\n${theme.fg("error", details.error)}`;
			if (expanded && details.result !== undefined) text += `\n${JSON.stringify(details.result, null, 2)}`;
			return new Text(text, 0, 0);
		},
	});
}

async function runWorkflow(
	params: WorkflowInput,
	details: WorkflowDetails,
	service: ReturnType<typeof getSubagentService>,
	ctx: ExtensionContext,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	update: () => void,
): Promise<unknown> {
	const worker = new Worker(WORKER_URL, { workerData: { source: params.source, input: params.input } });
	const activeIds = new Set<string>();
	const queue: Array<() => void> = [];
	const requestTasks = new Set<Promise<void>>();
	let slots = MAX_AGENT_CONCURRENCY;
	let workflowResult: unknown;
	let workflowDone = false;
	let settled = false;

	const acquire = async (): Promise<void> => {
		if (slots > 0) { slots--; return; }
		await new Promise<void>((resolve) => queue.push(resolve));
	};
	const release = (): void => {
		const next = queue.shift();
		if (next) next();
		else slots++;
	};
	const releaseQueue = (): void => {
		for (const releaseWaiting of queue.splice(0)) releaseWaiting();
	};
	const cancelChildren = async (): Promise<void> => {
		if (activeIds.size) await service.wait({ ids: [...activeIds], cancel: true, waitMs: 3_000 });
	};

	return new Promise<unknown>((resolve, reject) => {
		const finish = async (error?: Error): Promise<void> => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			releaseQueue();
			if (error) await cancelChildren();
			await Promise.allSettled([...requestTasks]);
			if (error) await cancelChildren();
			await worker.terminate();
			if (error) reject(error);
			else resolve(workflowResult);
		};
		const maybeFinish = (): void => {
			if (workflowDone && requestTasks.size === 0 && activeIds.size === 0) void finish();
		};
		const abort = (): void => void finish(signal?.reason instanceof Error ? signal.reason : new Error("Workflow cancelled."));
		const timer = setTimeout(() => void finish(new WorkflowTimeoutError(`Workflow timed out after ${timeoutMs}ms.`)), timeoutMs);
		timer.unref?.();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();

		worker.on("message", (message: unknown) => {
			const value = record(message);
			if (value?.type === "done") {
				workflowDone = true;
				workflowResult = value.result;
				maybeFinish();
				return;
			}
			if (value?.type === "error") {
				void finish(new Error(typeof value.error === "string" ? value.error : "Workflow worker failed."));
				return;
			}
			if (value?.type !== "agent_request" || typeof value.requestId !== "string" || settled) return;
			let task!: Promise<void>;
			task = (async () => {
				await acquire();
				let startedId: string | undefined;
				try {
					if (settled) return;
					const request = record(value.request);
					if (!request || typeof request.agent !== "string" || typeof request.task !== "string") throw new Error("Invalid workflow agent request.");
					const cwd = resolveWorkflowCwd(ctx.cwd, typeof request.cwd === "string" ? request.cwd : undefined);
					const started = await service.start({
						agent: request.agent,
						task: request.task,
						cwd,
						model: typeof request.model === "string" ? request.model : undefined,
						tools: Array.isArray(request.tools) ? request.tools.filter((tool): tool is string => typeof tool === "string") : undefined,
						allowWrite: false,
						deliverTerminal: false,
						background: true,
						wallMs: number(request.wallMs),
						turns: number(request.turns),
						tokens: number(request.tokens),
						costUsd: number(request.costUsd),
					}, ctx);
					if ("children" in started) throw new Error("Nested workflow groups are not supported.");
					startedId = started.spec.id;
					activeIds.add(startedId);
					details.activeAgents = activeIds.size;
					update();
					if (settled) {
						await service.wait({ ids: [startedId], cancel: true, waitMs: 3_000 });
						return;
					}
					const [run] = await service.wait({ ids: [startedId] });
					if (!run || "children" in run) throw new Error("Workflow agent result was unavailable.");
					details.runs.push(run);
					details.completedAgents++;
					activeIds.delete(run.spec.id);
					details.activeAgents = activeIds.size;
					update();
					if (!settled) worker.postMessage({ type: "agent_result", requestId: value.requestId, ok: run.runtime.status === "completed", result: compactRun(run), error: run.runtime.error });
				} catch (error) {
					if (startedId) activeIds.delete(startedId);
					details.activeAgents = activeIds.size;
					if (!settled) worker.postMessage({ type: "agent_result", requestId: value.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
				} finally {
					release();
				}
			})().finally(() => {
				requestTasks.delete(task);
				maybeFinish();
			});
			requestTasks.add(task);
		});
		worker.once("error", (error) => void finish(error));
		worker.once("exit", (code) => {
			if (!settled && !workflowDone) void finish(new Error(`Workflow worker exited before completion (${code}).`));
		});
	});
}

function resolveWorkflowCwd(root: string, requested?: string): string {
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(root, requested ?? ".");
	if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Workflow agent cwd must stay inside the trusted project.");
	return resolved;
}

function compactRun(run: DelegateRun) {
	return { id: run.spec.id, agentId: run.spec.agentId, persona: run.spec.persona, status: run.runtime.status, output: run.runtime.output, error: run.runtime.error, usage: run.runtime.usage };
}

function formatWorkflow(details: WorkflowDetails): string {
	const usage = sumUsage(details.runs);
	const header = `${details.id} [${details.status}] active=${details.activeAgents} completed=${details.completedAgents} ${formatUsage(usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens, usage.costUsd)}`;
	if (details.error) return `${header}\n${details.error}`;
	return details.result === undefined ? header : `${header}\n${JSON.stringify(details.result, null, 2)}`;
}

function sumUsage(runs: DelegateRun[]) {
	return runs.reduce((total, run) => ({
		inputTokens: total.inputTokens + run.runtime.usage.inputTokens,
		outputTokens: total.outputTokens + run.runtime.usage.outputTokens,
		cacheReadTokens: total.cacheReadTokens + run.runtime.usage.cacheReadTokens,
		cacheWriteTokens: total.cacheWriteTokens + run.runtime.usage.cacheWriteTokens,
		costUsd: total.costUsd + run.runtime.usage.costUsd,
	}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
}

function clampTimeout(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(1_000, Math.min(Math.floor(value!), MAX_TIMEOUT_MS)) : DEFAULT_TIMEOUT_MS;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

class WorkflowTimeoutError extends Error {}
