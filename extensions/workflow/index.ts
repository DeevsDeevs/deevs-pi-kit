import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TIMEOUT_MS as DEFAULT_SUBAGENT_TIMEOUT_MS, MAX_TIMEOUT_MS as MAX_SUBAGENT_TIMEOUT_MS } from "../subagents/config.ts";
import { getSubagentService } from "../subagents/registry.ts";
import type { DelegateRun } from "../subagents/runtime-types.ts";
import { ownsProcessIdentity, quiesceProcessGroup } from "../shared/process-group.ts";
import { toToolUsage } from "../shared/runtime-events.ts";
import { formatDuration, formatUsage } from "../shared/runtime-ui.ts";
import { WorkflowFleetWidget } from "./ui.ts";

const WORKER_URL = new URL("./worker.ts", import.meta.url);
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_AGENT_CONCURRENCY = 3;
const WORKFLOW_FLEETS = Symbol.for("deevs.pi-kit.workflow-fleets.v1");

type WorkflowFleetRegistry = Map<string, Map<string, WorkflowDetails>>;

const WorkflowSchema = Type.Object({
	source: Type.String({ description: "Trusted JavaScript function body. Use await agent({agent, task, ...}) and return structured-cloneable data." }),
	input: Type.Optional(Type.Unknown({ description: "Structured-cloneable workflow input available as input" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Hard workflow timeout; defaults to six hours and is capped at 24 hours" })),
});

interface WorkflowInput {
	source: string;
	input?: unknown;
	timeoutMs?: number;
}

export interface WorkflowDetails {
	id: string;
	status: "running" | "completed" | "failed" | "cancelled" | "timeout";
	startedAt: number;
	endedAt?: number;
	activeAgents: number;
	completedAgents: number;
	runs: DelegateRun[];
	agents: Array<{ id: string; persona: string; status: string; startedAt: number; endedAt?: number }>;
	result?: unknown;
	error?: string;
}

function workflowFleetRegistry(): WorkflowFleetRegistry {
	const global = globalThis as typeof globalThis & { [WORKFLOW_FLEETS]?: WorkflowFleetRegistry };
	return global[WORKFLOW_FLEETS] ??= new Map();
}

function workflowSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function workflowFleet(ctx: ExtensionContext): Map<string, WorkflowDetails> {
	const registry = workflowFleetRegistry();
	const key = workflowSessionKey(ctx);
	let fleet = registry.get(key);
	if (!fleet) { fleet = new Map(); registry.set(key, fleet); }
	return fleet;
}

export default function workflowExtension(pi: ExtensionAPI): void {
	const updateWorkflowWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const workflows = [...workflowFleet(ctx).values()];
		if (workflows.length) ctx.ui.setWidget("workflow:fleet", (_tui, theme) => new WorkflowFleetWidget(workflows, theme), { placement: "belowEditor" });
		else ctx.ui.setWidget("workflow:fleet", undefined);
	};

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
			const details: WorkflowDetails = { id, status: "running", startedAt: Date.now(), activeAgents: 0, completedAgents: 0, runs: [], agents: [] };
			workflowFleet(ctx).set(id, details);
			const update = (): void => {
				onUpdate?.({ content: [{ type: "text", text: formatWorkflow(details) }], details });
				updateWorkflowWidget(ctx);
			};
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
				for (const agent of details.agents) if (agent.status === "queued" || agent.status === "running") { agent.status = details.status; agent.endedAt = details.endedAt; }
				return { content: [{ type: "text" as const, text: formatWorkflow(details) }], details, usage: toToolUsage(sumUsage(details.runs)), isError: true };
			} finally {
				const fleet = workflowFleet(ctx);
				fleet.delete(id);
				updateWorkflowWidget(ctx);
				if (!fleet.size) workflowFleetRegistry().delete(workflowSessionKey(ctx));
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
	const emergencyQuiesce = async (ids: string[]): Promise<void> => {
		for (const id of ids) {
			let run: DelegateRun;
			try { run = service.executor.get(id); } catch { continue; }
			for (const [pid, identity] of [[run.runtime.childPid, run.runtime.childIdentity], [run.runtime.workerPid, run.runtime.workerIdentity]] as const) {
				if (pid && await ownsProcessIdentity(pid, identity)) await quiesceProcessGroup(pid, { graceful: false });
			}
		}
	};
	const cancelIds = async (ids: string[]): Promise<void> => {
		if (!ids.length) return;
		try {
			await service.wait({ ids, cancel: true, waitMs: 3_000 });
		} catch (error) {
			const fallback = await Promise.allSettled(ids.map((id) => service.executor.cancel(id)));
			const failed = fallback.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") {
				await emergencyQuiesce(ids);
				throw failed.reason;
			}
			throw error;
		}
	};
	const cancelChildren = (): Promise<void> => cancelIds([...activeIds]);
	const settleRequests = async (): Promise<void> => {
		const tasks = [...requestTasks];
		if (!tasks.length) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.allSettled(tasks),
				new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Workflow request cleanup timed out.")), 5_000); timer.unref?.(); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};

	return new Promise<unknown>((resolve, reject) => {
		const finish = async (error?: Error): Promise<void> => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			releaseQueue();
			let terminalError = error;
			const cleanup = async (operation: () => Promise<unknown>): Promise<void> => {
				try { await operation(); }
				catch (cleanupError) { terminalError ??= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)); }
			};
			if (error) await cleanup(cancelChildren);
			await cleanup(settleRequests);
			await cleanup(() => worker.terminate());
			if (terminalError) reject(terminalError);
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
			const queuedRequest = record(value.request);
			if (queuedRequest && typeof queuedRequest.agent === "string") {
				details.agents.push({ id: `queued:${value.requestId}`, persona: queuedRequest.agent, status: "queued", startedAt: Date.now() });
				update();
			}
			let task!: Promise<void>;
			task = (async () => {
				await acquire();
				let startedId: string | undefined;
				try {
					if (settled) return;
					const request = queuedRequest;
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
					const queued = details.agents.find((agent) => agent.id === `queued:${value.requestId}`);
					if (queued) { queued.id = startedId; queued.status = "running"; queued.startedAt = started.runtime.startedAt; }
					else details.agents.push({ id: startedId, persona: started.spec.persona, status: "running", startedAt: started.runtime.startedAt });
					details.activeAgents = activeIds.size;
					update();
					if (settled) {
						await cancelIds([startedId]);
						return;
					}
					const [run] = await service.wait({ ids: [startedId] });
					if (!run || "children" in run) throw new Error("Workflow agent result was unavailable.");
					details.runs.push(run);
					details.completedAgents++;
					const progress = details.agents.find((agent) => agent.id === run.spec.id);
					if (progress) { progress.status = run.runtime.status; progress.endedAt = run.runtime.endedAt ?? Date.now(); }
					activeIds.delete(run.spec.id);
					details.activeAgents = activeIds.size;
					update();
					if (!settled) worker.postMessage({ type: "agent_result", requestId: value.requestId, ok: run.runtime.status === "completed", result: compactRun(run), error: run.runtime.error });
				} catch (error) {
					if (startedId) activeIds.delete(startedId);
					const progress = details.agents.find((agent) => agent.id === (startedId ?? `queued:${value.requestId}`));
					if (progress) { progress.status = "failed"; progress.endedAt = Date.now(); }
					details.activeAgents = activeIds.size;
					update();
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
	return Number.isFinite(value) ? Math.max(1_000, Math.min(Math.floor(value!), MAX_SUBAGENT_TIMEOUT_MS)) : DEFAULT_SUBAGENT_TIMEOUT_MS;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

class WorkflowTimeoutError extends Error {}
