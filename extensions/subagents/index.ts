import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SubagentService, type SubagentGroup, type SubagentStartRequest, type SubagentWaitRequest } from "./service.ts";
import type { DelegateRun } from "./runtime-types.ts";
import { clearSubagentService, setSubagentService } from "./registry.ts";
import { formatDuration, formatUsage } from "../shared/runtime-ui.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { loadBuiltinAgents } from "./agents.ts";
import { toToolUsage, type RuntimeUsage } from "../shared/runtime-events.ts";

const TaskSchema = Type.Object({
	agent: Type.String({ description: "Curated Pi Kit persona name" }),
	task: Type.String({ description: "Focused bounded task" }),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the parent cwd" })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional narrowing of persona tools" })),
	allowWrite: Type.Optional(Type.Boolean({ description: "Explicitly enable edit/write for this run" })),
	wallMs: Type.Optional(Type.Number({ description: "Hard wall-clock limit" })),
	turns: Type.Optional(Type.Number({ description: "Hard provider-turn limit" })),
	tokens: Type.Optional(Type.Number({ description: "Hard aggregate token limit with at most one provider-call overshoot" })),
	costUsd: Type.Optional(Type.Number({ description: "Hard cost limit in USD with at most one provider-call overshoot" })),
});

const SubagentSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Persona for a fresh single run" })),
	task: Type.Optional(Type.String({ description: "Task for a fresh or resumed single run" })),
	resume: Type.Optional(Type.String({ description: "Terminal run id whose persistent agent session should receive a new turn" })),
	background: Type.Optional(Type.Boolean({ description: "Return after start; default true. False waits for terminal settlement." })),
	cwd: Type.Optional(Type.String()),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	allowWrite: Type.Optional(Type.Boolean()),
	wallMs: Type.Optional(Type.Number()),
	turns: Type.Optional(Type.Number()),
	tokens: Type.Optional(Type.Number()),
	costUsd: Type.Optional(Type.Number()),
	tasks: Type.Optional(Type.Array(TaskSchema, { description: "Independent tasks for one bounded parallel group", maxItems: 16 })),
	concurrency: Type.Optional(Type.Number({ description: "Parallel group concurrency" })),
	failFast: Type.Optional(Type.Boolean()),
});

const WaitSchema = Type.Object({
	ids: Type.Array(Type.String(), { minItems: 1, description: "Run or group ids" }),
	waitMs: Type.Optional(Type.Number({ description: "Maximum wait for terminal state; omit to wait until terminal, 0 for status only" })),
	cancel: Type.Optional(Type.Boolean({ description: "Cancel these runs/groups before returning settlement" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum output bytes per run; default 65536" })),
});

export default function subagentsExtension(pi: ExtensionAPI): void {
	const service = new SubagentService(pi);
	setSubagentService(service);
	const usageClaims = new Set<string>();
	let latestCtx: ExtensionContext | undefined;
	const restoreUsageClaims = (ctx: ExtensionContext): void => {
		usageClaims.clear();
		for (const entry of ctx.sessionManager.getBranch() as readonly unknown[]) {
			const record = entry as { type?: string; customType?: string; data?: { key?: string } };
			if (record.type === "custom" && record.customType === "deevs.subagent-usage-claim.v1" && typeof record.data?.key === "string") usageClaims.add(record.data.key);
		}
	};
	const claimUsage = (values: Array<DelegateRun | SubagentGroup>) => {
		const runs = values.flatMap((value) => "children" in value ? value.children.map((id) => service.executor.get(id)) : [value]);
		const usage = runs.reduce((total, run) => {
			const key = `${run.spec.id}:${run.spec.generation}`;
			if (["starting", "running", "stopping"].includes(run.runtime.status) || usageClaims.has(key)) return total;
			usageClaims.add(key);
			pi.appendEntry("deevs.subagent-usage-claim.v1", { key });
			return {
				inputTokens: total.inputTokens + run.runtime.usage.inputTokens,
				outputTokens: total.outputTokens + run.runtime.usage.outputTokens,
				cacheReadTokens: total.cacheReadTokens + run.runtime.usage.cacheReadTokens,
				cacheWriteTokens: total.cacheWriteTokens + run.runtime.usage.cacheWriteTokens,
				costUsd: total.costUsd + run.runtime.usage.costUsd,
			};
		}, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } satisfies RuntimeUsage);
		return toToolUsage(usage);
	};
	const setContext = (ctx: ExtensionContext): void => {
		latestCtx = ctx;
		service.setContext(ctx);
	};
	const updateStatus = (): void => {
		if (!latestCtx) return;
		const state = service.list();
		const activeRuns = state.runs.filter((run) => ["starting", "running", "stopping"].includes(run.runtime.status)).length;
		const activeGroups = state.groups.filter((group) => group.status === "running").length;
		latestCtx.ui.setStatus("subagents", activeRuns ? `agents ${activeRuns}${activeGroups ? ` · groups ${activeGroups}` : ""}` : undefined);
	};
	const unsubscribe = service.executor.onChange(updateStatus);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start or resume one curated Pi Kit persona, or run a bounded independent parallel group. Read-only unless allowWrite is explicit.",
		promptSnippet: "Delegate focused exploration, review, testing, architecture, or specialist work to owned Pi Kit personas.",
		promptGuidelines: [
			"Use fresh independent runs for review and refutation; resume only when continuity is required.",
			"Keep scope concrete and bounded.",
			"Never enable allowWrite unless the user explicitly requested delegated writes.",
			"Use subagent_wait instead of polling output.",
		],
		parameters: SubagentSchema,
		async execute(_toolCallId, params: SubagentStartRequest, signal, onUpdate, ctx) {
			setContext(ctx);
			if (signal?.aborted) throw signal.reason;
			const writeRequested = params.allowWrite === true || params.tasks?.some((task) => task.allowWrite) === true || (params.resume ? service.executor.get(params.resume).spec.allowWrite : false);
			if (writeRequested && !hasDelegatedWriteAuthorization(ctx)) throw new Error("Writing or resuming a write-capable Subagent requires fresh explicit authorization in the latest user message.");
			const unsubscribeUpdate = service.executor.onChange((run) => onUpdate?.({ content: [{ type: "text", text: formatStart(run) }], details: run }));
			try {
				const result = await service.start({ ...params, writeAuthorized: writeRequested }, ctx);
				updateStatus();
				return { content: [{ type: "text" as const, text: formatStart(result) }], details: result, usage: claimUsage([result]) };
			} finally {
				unsubscribeUpdate();
			}
		},
		renderCall(args: SubagentStartRequest, theme: Theme) {
			const target = args.tasks?.length ? `${args.tasks.length} parallel` : args.resume ? `resume ${args.resume}` : args.agent ?? "invalid";
			return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("muted", target), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return new Text(renderDetails(result.details as DelegateRun | SubagentGroup | undefined, expanded, theme), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for Subagent",
		description: "Wait for, inspect, or cancel Subagent runs and groups without polling.",
		promptSnippet: "Wait on one or more Subagent lifecycle states; use waitMs=0 for status.",
		promptGuidelines: ["Prefer one bounded wait over repeated status calls.", "Terminal settlement follows actual worker/child quiescence."],
		parameters: WaitSchema,
		async execute(_toolCallId, params: SubagentWaitRequest & { maxBytes?: number }, signal, onUpdate, ctx) {
			setContext(ctx);
			const unsubscribeUpdate = service.executor.onChange((run) => {
				if (params.ids.includes(run.spec.id)) onUpdate?.({ content: [{ type: "text", text: formatWait(run, clampBytes(params.maxBytes)) }], details: { results: [run] } });
			});
			try {
				const results = await service.wait(params, signal);
				updateStatus();
				const maxBytes = clampBytes(params.maxBytes);
				return { content: [{ type: "text" as const, text: results.map((item) => formatWait(item, maxBytes)).join("\n\n") }], details: { results }, usage: claimUsage(results) };
			} finally {
				unsubscribeUpdate();
			}
		},
		renderCall(args: SubagentWaitRequest, theme: Theme) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent_wait ")) + theme.fg("muted", `${args.ids.length} id(s)${args.cancel ? " · cancel" : ""}`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { results?: Array<DelegateRun | SubagentGroup> } | undefined;
			const text = details?.results?.map((item) => renderDetails(item, expanded, theme)).join("\n") ?? textContent(result.content);
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("agents", {
		description: "Browse, inspect, resume, stop, or clear Subagent runs",
		getArgumentCompletions: (prefix) => service.list().runs.map((run) => run.spec.id).filter((id) => id.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, context) => {
			setContext(context);
			const [action, id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "clear") {
				context.ui.notify(`Cleared ${service.clearTerminal(id)} terminal Subagent record(s).`, "info");
				return;
			}
			if (action === "stop" && id) await service.wait({ ids: [id], cancel: true });
			if (action === "resume" && id) {
				const task = rest.join(" ").trim();
				if (!task) return context.ui.notify("Usage: /agents resume <run-id> <task>", "warning");
				const writeAuthorized = hasDelegatedWriteAuthorization(context);
				const resumed = await service.start({ resume: id, task, background: true, writeAuthorized }, context);
				await showTextViewer(context, "Subagent resumed", formatStart(resumed));
				return;
			}
			const target = action === "stop" ? id : action;
			await showTextViewer(context, "Subagents", formatAgentsBrowser(service, target ?? ""));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setContext(ctx);
		restoreUsageClaims(ctx);
		await service.restore(ctx);
		updateStatus();
	});
	pi.on("session_tree", async (_event, ctx) => {
		setContext(ctx);
		restoreUsageClaims(ctx);
		await service.restore(ctx);
		updateStatus();
	});
	pi.on("before_agent_start", (_event, ctx) => setContext(ctx));
	pi.on("agent_settled", (_event, ctx) => {
		setContext(ctx);
		updateStatus();
	});
	pi.on("session_shutdown", () => {
		unsubscribe();
		service.dispose();
		clearSubagentService(service);
		usageClaims.clear();
		latestCtx = undefined;
	});
}

function formatAgentsBrowser(service: SubagentService, id: string): string {
	const state = service.list();
	if (id) {
		const run = state.runs.find((candidate) => candidate.spec.id === id);
		if (run) return `${formatWait(run, 65_536)}\n\nAgent identity: ${run.spec.agentId}\nGeneration: ${run.spec.generation}\nSession: ${run.runtime.sessionFile ?? "(pending)"}\nArtifacts: ${run.spec.artifactsDir}`;
		const group = state.groups.find((candidate) => candidate.id === id);
		if (group) return `${formatWait(group, 65_536)}\nLaunch failures:\n${group.launchFailures.map((failure) => `- ${failure}`).join("\n") || "- none"}`;
		return `Unknown Subagent id: ${id}`;
	}
	const personas = loadBuiltinAgents().map((agent) => `- ${agent.name}: ${agent.description} [${agent.tools.join(",")}; ${agent.write ? "write-capable" : "read-only"}]`);
	const runs = state.runs.slice(0, 20).map((run) => `- ${run.spec.id} [${run.runtime.status}] ${run.spec.persona} · ${formatDuration((run.runtime.endedAt ?? Date.now()) - run.runtime.startedAt)}`);
	const groups = state.groups.slice(0, 10).map((group) => `- ${group.id} [${group.status}] ${group.children.length} child(ren) · ${group.pending.length} pending`);
	return ["Curated personas", ...personas, "", "Recent runs", ...(runs.length ? runs : ["- none"]), "", "Groups", ...(groups.length ? groups : ["- none"]), "", "Use /agents <run-or-group-id> for details."].join("\n");
}

function formatStart(value: DelegateRun | SubagentGroup): string {
	if (isGroup(value)) return `${value.id} [${value.status}] ${value.children.length} started, ${value.pending.length} pending`;
	const duration = Date.now() - value.runtime.startedAt;
	const header = `${value.spec.id} [${value.runtime.status}] ${value.spec.persona} · ${formatDuration(duration)}`;
	return value.runtime.output ? `${header}\n${value.runtime.output}` : header;
}

function formatWait(value: DelegateRun | SubagentGroup, maxBytes: number): string {
	if (isGroup(value)) return `${value.id} [${value.status}] children=${value.children.join(",") || "none"} pending=${value.pending.length}`;
	const header = `${value.spec.id} [${value.runtime.status}] ${formatUsage(tokenTotal(value), value.runtime.usage.costUsd)}`;
	const body = value.runtime.output || value.runtime.error || "(no output)";
	return `${header}\n${truncateBytes(body, maxBytes)}`;
}

function renderDetails(value: DelegateRun | SubagentGroup | undefined, expanded: boolean, theme: Theme): string {
	if (!value) return theme.fg("dim", "No structured Subagent result");
	if (isGroup(value)) return `${theme.fg(value.status === "completed" ? "success" : value.status === "running" ? "warning" : "error", value.status)} ${theme.fg("accent", value.id)} ${value.children.length} child(ren)${expanded ? ` · pending ${value.pending.length} · active ${value.active.length}` : ""}`;
	const statusColor = value.runtime.status === "completed" ? "success" : ["starting", "running", "stopping"].includes(value.runtime.status) ? "warning" : "error";
	let text = `${theme.fg(statusColor, value.runtime.status)} ${theme.fg("accent", value.spec.persona)} ${theme.fg("muted", value.spec.id)}`;
	text += ` · ${formatUsage(tokenTotal(value), value.runtime.usage.costUsd)}`;
	if (expanded && value.runtime.output) text += `\n${value.runtime.output}`;
	if (expanded && value.runtime.error) text += `\n${theme.fg("error", value.runtime.error)}`;
	return text;
}

function isGroup(value: DelegateRun | SubagentGroup): value is SubagentGroup {
	return "children" in value;
}

function tokenTotal(run: DelegateRun): number {
	return run.runtime.usage.inputTokens + run.runtime.usage.outputTokens + run.runtime.usage.cacheWriteTokens;
}

export function hasDelegatedWriteAuthorization(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch() as readonly unknown[];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : Array.isArray(content)
			? content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "").join(" ")
			: "";
		const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
		if (normalized.includes("?") || /\b(do not|don't|dont|never)\b.{0,80}\b(delegate|subagent|agent)\b/.test(normalized)) return false;
		const action = "(?:write|writing|edit|edits|implement|implementation|fix|change|changes|modify)";
		return new RegExp(`^(?:please\\s+)?(?:authorize|allow|delegate|have|let)\\b.{0,100}\\b(?:subagent|agent)\\b.{0,100}\\b${action}\\b[.!]*$`).test(normalized)
			|| new RegExp(`^(?:please\\s+)?delegate\\b.{0,100}\\b${action}\\b.{0,100}\\b(?:subagent|agent)\\b[.!]*$`).test(normalized);
	}
	return false;
}

function clampBytes(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value!), 262_144)) : 65_536;
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let tail = text.slice(-maxBytes);
	while (Buffer.byteLength(tail) > maxBytes) tail = tail.slice(1);
	return `[truncated from start]\n${tail}`;
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content.find((part) => part.type === "text")?.text ?? "";
}
