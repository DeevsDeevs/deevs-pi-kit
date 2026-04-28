import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SubagentManager } from "./manager.ts";
import type { AgentClearInput, AgentLogsInput, AgentParallelStartInput, AgentReadInput, AgentStartInput, AgentStatusInput, AgentStopInput } from "./types.ts";

const ChainContextSchema = Type.Object({
	chain: Type.String({ description: "Chain name to load from .chains before starting the subagent" }),
	branch: Type.Optional(Type.String({ description: "Branch name; defaults to main unless link is provided" })),
	link: Type.Optional(Type.String({ description: "Specific link filename; defaults to latest" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum chain context bytes to include" })),
	mode: Type.Optional(Type.String({ description: "latest for one link, pack for compact parent/recent/search context" })),
	includeParents: Type.Optional(Type.Number({ description: "Parent links to include in pack mode" })),
	recentLinks: Type.Optional(Type.Number({ description: "Recent sibling links to summarize in pack mode" })),
	searchQuery: Type.Optional(Type.String({ description: "Optional query to include matching/relevant snippets in pack mode" })),
	searchMode: Type.Optional(Type.String({ description: "lookup for ranked results, text for exact text, regex for regex; default lookup" })),
	maxSearchMatches: Type.Optional(Type.Number({ description: "Maximum search matches to include in pack mode" })),
	compact: Type.Optional(Type.Boolean({ description: "Use compact section extraction for included links" })),
});

const AgentTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	allowWrite: Type.Optional(Type.Boolean()),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	chainContext: Type.Optional(ChainContextSchema),
});

const AgentListSchema = Type.Object({
	includeDisabled: Type.Optional(Type.Boolean()),
	query: Type.Optional(Type.String()),
	tag: Type.Optional(Type.String()),
});

const AgentStartSchema = Type.Object({
	agent: Type.String({ description: "Built-in agent name, e.g. explorer, reviewer, tester" }),
	task: Type.String({ description: "Focused task for the subagent" }),
	cwd: Type.Optional(Type.String()),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
	model: Type.Optional(Type.String({ description: "Model override; must be allowed in /agents:settings" })),
	tools: Type.Optional(Type.Array(Type.String())),
	allowWrite: Type.Optional(Type.Boolean({ description: "Explicitly allow edit/write tools for this run" })),
	timeoutMs: Type.Optional(Type.Number()),
	maxBytes: Type.Optional(Type.Number()),
	chainContext: Type.Optional(ChainContextSchema),
});

const AgentParallelStartSchema = Type.Object({
	tasks: Type.Array(AgentTaskSchema),
	concurrency: Type.Optional(Type.Number()),
	failFast: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Number()),
	maxBytesPerAgent: Type.Optional(Type.Number()),
});

const AgentReadSchema = Type.Object({
	id: Type.String({ description: "Run id a_... or group id g_..." }),
	afterSeq: Type.Optional(Type.Number()),
	waitMs: Type.Optional(Type.Number()),
	maxBytes: Type.Optional(Type.Number()),
	stream: Type.Optional(StringEnum(["combined", "stdout", "stderr"] as const)),
	raw: Type.Optional(Type.Boolean()),
});

const AgentStatusSchema = Type.Object({
	id: Type.Optional(Type.String()),
	includeCompleted: Type.Optional(Type.Boolean()),
});

const AgentStopSchema = Type.Object({
	id: Type.String({ description: "Run id a_... or group id g_..." }),
	signal: Type.Optional(StringEnum(["SIGINT", "SIGTERM", "SIGKILL"] as const)),
	timeoutMs: Type.Optional(Type.Number()),
});

const AgentLogsSchema = Type.Object({
	id: Type.String({ description: "Run id a_... or group id g_..." }),
	source: Type.Optional(StringEnum(["result", "task", "system-prompt", "metadata", "combined", "stdout", "stderr"] as const)),
	maxBytes: Type.Optional(Type.Number()),
	raw: Type.Optional(Type.Boolean({ description: "Return unfiltered raw process logs for combined/stdout/stderr; default is compact" })),
});

const AgentClearSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Terminal run id or group id to clear" })),
	allCompleted: Type.Optional(Type.Boolean()),
	deleteArtifacts: Type.Optional(Type.Boolean()),
});

export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
	pi.registerTool({
		name: "agent_list",
		label: "List Agents",
		description: "List curated Deevs staff subagents available for background delegation.",
		promptSnippet: "List available staff subagents and when to use them.",
		promptGuidelines: ["Use this when choosing the right subagent persona for a task."],
		parameters: AgentListSchema,
		async execute(_toolCallId, params) {
			const agents = manager.listAgents(params);
			return { content: [{ type: "text", text: formatAgents(agents) }], details: { agents } };
		},
	});

	pi.registerTool({
		name: "agent_start",
		label: "Start Agent",
		description: "Start one curated subagent as a managed background job.",
		promptSnippet: "Start a background subagent and return its run id and backing process id.",
		promptGuidelines: [
			"Use explorer for non-trivial reconnaissance before editing.",
			"Subagents are background jobs; use agent_status/agent_read/agent_logs to inspect them.",
			"Use chainContext or call chain_context first when a subagent needs durable chain context.",
			"Do not set allowWrite unless the user explicitly requested writes.",
		],
		parameters: AgentStartSchema,
		async execute(_toolCallId, params: AgentStartInput, signal, _onUpdate, ctx) {
			const result = await manager.start(params, ctx, signal);
			return { content: [{ type: "text", text: formatStart(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "agent_parallel_start",
		label: "Start Agent Group",
		description: "Start a parallel background group of curated subagents.",
		promptSnippet: "Run independent staff-agent perspectives in parallel.",
		promptGuidelines: ["Use for independent review/test/anti-slop perspectives; default concurrency is 3.", "Each task may include chainContext for a bounded, parent-loaded chain handoff."],
		parameters: AgentParallelStartSchema,
		async execute(_toolCallId, params: AgentParallelStartInput, signal, _onUpdate, ctx) {
			const result = await manager.startParallel(params, ctx, signal);
			return { content: [{ type: "text", text: formatParallelStart(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "agent_read",
		label: "Read Agent",
		description: "Read a subagent run or parallel group.",
		promptSnippet: "Read friendly output from a subagent run/group; raw mode returns backing process chunks.",
		promptGuidelines: ["Use raw:true only when debugging process output parsing."],
		parameters: AgentReadSchema,
		async execute(_toolCallId, params: AgentReadInput, signal) {
			const result = await manager.read(params, signal);
			return { content: [{ type: "text", text: result.output || "(no output)" }], details: result };
		},
	});

	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "List active/recent subagent runs and groups.",
		promptSnippet: "Check whether background subagents are still running and see recent statuses.",
		promptGuidelines: ["Use before reading if you need to know what finished."],
		parameters: AgentStatusSchema,
		async execute(_toolCallId, params: AgentStatusInput) {
			const result = manager.status(params);
			return { content: [{ type: "text", text: manager.formatStatus(params) }], details: result };
		},
	});

	pi.registerTool({
		name: "agent_stop",
		label: "Stop Agent",
		description: "Stop a subagent run or all running children in a group.",
		promptSnippet: "Stop a running background subagent or parallel group.",
		promptGuidelines: ["Use this rather than shell kill for subagent jobs."],
		parameters: AgentStopSchema,
		async execute(_toolCallId, params: AgentStopInput) {
			const result = await manager.stop(params);
			return { content: [{ type: "text", text: `Stopped ${result.stopped.length} run(s). status=${result.status}` }], details: result };
		},
	});

	pi.registerTool({
		name: "agent_logs",
		label: "Agent Logs",
		description: "Read subagent artifacts or compact backing process logs.",
		promptSnippet: "Inspect result.md, task.md, system-prompt.md, metadata.json, or compact process-log activity for a subagent.",
		promptGuidelines: ["Use this when agent_read is insufficient or prompt/task/debug artifacts matter.", "For combined/stdout/stderr, raw:false/default returns compact activity; use raw:true only when debugging log parsing."],
		parameters: AgentLogsSchema,
		async execute(_toolCallId, params: AgentLogsInput) {
			const result = await manager.logs(params);
			const header = result.path ? `${result.source}: ${result.path}` : result.source;
			return { content: [{ type: "text", text: `${header}\n\n${result.content || "(empty)"}` }], details: result };
		},
	});

	pi.registerTool({
		name: "agent_clear",
		label: "Clear Agent",
		description: "Clear completed subagent run/group records and optionally artifacts.",
		promptSnippet: "Clear terminal subagent records, optionally deleting artifacts.",
		promptGuidelines: ["Do not clear running subagents; stop them first."],
		parameters: AgentClearSchema,
		async execute(_toolCallId, params: AgentClearInput) {
			const result = await manager.clear(params);
			return { content: [{ type: "text", text: `Cleared ${result.cleared.length} subagent record(s).` }], details: result };
		},
	});
}

function formatAgents(agents: ReturnType<SubagentManager["listAgents"]>): string {
	if (agents.length === 0) return "No agents found.";
	return agents.map((agent) => `${agent.name} - ${agent.description} [tools=${agent.tools.join(",")}; write=${agent.write ? "yes" : "no"}]`).join("\n");
}

function formatStart(result: { id: string; procId: string | null; agent: string; status: string; artifactsDir: string }): string {
	return `Started ${result.agent} ${result.id} [${result.status}] proc=${result.procId ?? "none"}\nArtifacts: ${result.artifactsDir}`;
}

function formatParallelStart(result: { groupId: string; status: string; runs: Array<{ id: string; procId: string | null; agent: string; status: string }> }): string {
	const lines = [`Started parallel group ${result.groupId} [${result.status}]`];
	for (const run of result.runs) lines.push(`- ${run.agent} ${run.id} [${run.status}] proc=${run.procId ?? "pending"}`);
	return lines.join("\n");
}
