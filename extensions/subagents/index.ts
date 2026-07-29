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
import { utf8Tail } from "../shared/bytes.ts";
import { FULL_SCREEN_OVERLAY } from "../shared/dashboard.ts";
import { AgentsDashboard } from "./ui.ts";

const TaskSchema = Type.Object({
	agent: Type.String({ description: "Curated Pi Kit persona name" }),
	task: Type.String({ description: "Focused bounded task" }),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the parent cwd" })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional narrowing using persona-local names such as safe_read, safe_list, and safe_search" })),
	allowWrite: Type.Optional(Type.Boolean({ description: "Explicitly enable edit/write for this run" })),
	wallMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000, description: "Hard wall-clock limit; defaults to 6 hours and is capped at 24 hours" })),
	turns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional provider-turn limit; omitted means unbounded" })),
	tokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional aggregate token limit; omitted means unbounded, with at most one provider-call overshoot when set" })),
	costUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Optional USD cost limit; omitted means unbounded, with at most one provider-call overshoot when set" })),
});

const SubagentSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Persona for a fresh single run" })),
	task: Type.Optional(Type.String({ description: "Task for a fresh or resumed single run" })),
	resume: Type.Optional(Type.String({ description: "Terminal run id whose persistent agent session should receive a new turn" })),
	background: Type.Optional(Type.Boolean({ description: "Return after start; default true. False waits for terminal settlement." })),
	cwd: Type.Optional(Type.String()),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional narrowing using persona-local names such as safe_read, safe_list, and safe_search" })),
	allowWrite: Type.Optional(Type.Boolean()),
	wallMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000, description: "Hard wall-clock limit; defaults to 6 hours and is capped at 24 hours" })),
	turns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional provider-turn limit; omitted means unbounded" })),
	tokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional aggregate token limit; omitted means unbounded" })),
	costUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Optional USD cost limit; omitted means unbounded" })),
	tasks: Type.Optional(Type.Array(TaskSchema, { description: "Independent tasks for one bounded parallel group", maxItems: 16 })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Parallel group concurrency" })),
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
		const runs = values.flatMap((value) => "children" in value ? value.children.flatMap((id) => {
			const run = service.executor.find(id);
			return run ? [run] : [];
		}) : [value]);
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
		latestCtx.ui.setStatus("subagents", activeRuns ? latestCtx.ui.theme?.fg("accent", `agents ${activeRuns}${activeGroups ? `/${activeGroups}` : ""}`) ?? `agents ${activeRuns}${activeGroups ? `/${activeGroups}` : ""}` : undefined);
	};
	const unsubscribe = service.executor.onChange(updateStatus);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Start or resume one curated Pi Kit persona, or run a bounded independent parallel group. Read-only unless allowWrite is explicit.",
		promptSnippet: "Delegate focused exploration, review, testing, architecture, or specialist work to owned Pi Kit personas.",
		promptGuidelines: [
			"Delegate liberally but not redundantly: prefer the smallest set of focused runs that answers the question over overlapping perspectives.",
			"Use fresh independent runs for review and refutation; resume only when continuity is required.",
			"Keep scope concrete. Omitted turn/token/cost limits are unbounded and wall time defaults to six hours; tighten only with a reason, never arbitrary tiny defaults.",
			"Never enable allowWrite unless the user explicitly requested delegated writes; Pi confirms each write-capable run in the TUI unless the user pre-authorized writes with /auto.",
			"Use subagent_wait instead of polling output.",
		],
		parameters: SubagentSchema,
		async execute(_toolCallId, params: SubagentStartRequest, signal, onUpdate, ctx) {
			setContext(ctx);
			if (signal?.aborted) throw signal.reason;
			const unsubscribeUpdate = service.executor.onChange((run) => onUpdate?.({ content: [{ type: "text", text: formatStart(run) }], details: run }));
			try {
				const result = await service.start(params, ctx);
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
				const resumed = await service.start({ resume: id, task, background: true }, context);
				await showTextViewer(context, "Subagent resumed", formatStart(resumed));
				return;
			}
			const target = action === "stop" ? id : action;
			if (!target && context.mode === "tui" && context.hasUI) {
				let unsubscribeDashboard: () => void = () => {};
				try {
					await context.ui.custom<void>((tui, theme, _keybindings, done) => {
						const render = () => tui.requestRender();
						unsubscribeDashboard = service.executor.onChange(render);
						return new AgentsDashboard(
							service,
							theme,
							() => done(undefined),
							render,
							() => Math.max(4, tui.terminal.rows - 2),
							(id) => void service.wait({ ids: [id], cancel: true }).then(() => { context.ui.notify(`Cancelled ${id}.`, "info"); render(); }).catch((error) => context.ui.notify(error instanceof Error ? error.message : String(error), "error")),
							(id) => { context.ui.notify(`Cleared ${service.clearTerminal(id)} record.`, "info"); render(); },
						);
					}, { overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
				} finally {
					unsubscribeDashboard();
				}
				return;
			}
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
		latestCtx?.ui.setStatus("subagents", undefined);
		latestCtx = undefined;
	});
}

function formatAgentsBrowser(service: SubagentService, id: string): string {
	const state = service.list();
	const personas = loadBuiltinAgents();
	if (id) {
		const run = state.runs.find((candidate) => candidate.spec.id === id);
		if (run) return `${formatWait(run, 65_536)}\n\nAgent: ${run.spec.agentId}\nGeneration: ${run.spec.generation}\nSession: ${run.runtime.sessionFile ?? "pending"}\nArtifacts: ${run.spec.artifactsDir}`;
		const group = state.groups.find((candidate) => candidate.id === id);
		if (group) return `${formatWait(group, 65_536)}\nLaunch failures:\n${group.launchFailures.map((failure) => `- ${failure}`).join("\n") || "- none"}`;
		const persona = personas.find((candidate) => candidate.name === id);
		if (persona) return `${persona.name}\n${persona.description}\n\nAccess: ${persona.write ? "write-capable" : "read-only"}\nTools: ${persona.tools.join(", ") || "none"}`;
		return `Unknown Subagent id or persona: ${id}`;
	}
	const active = state.runs.filter((run) => ["starting", "running", "stopping"].includes(run.runtime.status));
	const recent = state.runs.filter((run) => !active.includes(run)).slice(0, 4);
	const runLines = (run: DelegateRun): string[] => [
		`${run.runtime.status} ${run.spec.persona} · ${formatDuration((run.runtime.endedAt ?? Date.now()) - run.runtime.startedAt)} · $${run.runtime.usage.costUsd.toFixed(4)}`,
		`  ${run.spec.id} · ${browserTokens(run)} tok`,
	];
	const groups = state.groups.slice(0, 5).map((group) => `${group.status} ${group.id} · ${group.children.length} runs${group.pending.length ? ` · ${group.pending.length} pending` : ""}`);
	const personaLines = Array.from({ length: Math.ceil(personas.length / 3) }, (_, index) => personas.slice(index * 3, index * 3 + 3).map((persona) => persona.name).join(" | "));
	return [
		`Active (${active.length})`,
		...(active.length ? active.flatMap(runLines) : ["none"]),
		"",
		`Recent (${recent.length})`,
		...(recent.length ? recent.flatMap(runLines) : ["none"]),
		...(groups.length ? ["", "Groups", ...groups] : []),
		"",
		"Personas",
		...personaLines,
		"",
		"Details: /agents <id|persona>",
		"Cleanup: /agents clear",
	].join("\n");
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

function browserTokens(run: DelegateRun): string {
	const tokens = tokenTotal(run);
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}m` : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
}

function clampBytes(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value!), 262_144)) : 65_536;
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	return `[truncated from start]\n${utf8Tail(text, maxBytes)}`;
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content.find((part) => part.type === "text")?.text ?? "";
}
