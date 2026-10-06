import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadKitConfig, modelLabel, resolveLead, resolveModel } from "../shared/models.ts";
import { tasks, type TaskNotification } from "../shared/tasks.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { agentTypes, agentTypesSection, findAgentType, workerPrompt } from "./definitions.ts";
import { AGENT_SLOTS, closeAll, ensureEngine, launch, queuedAhead, reinstall, resumeSession, settle, writersIn, type Limits } from "./engine/index.ts";

const FOREGROUND_MS = 120_000;
const RESERVED_NAMES = new Set(["main", "user", "system"]);
const ONLY_ON_REQUEST = "Set ONLY when the user explicitly asks for this limit; omitted means none.";

const AgentSchema = Type.Object({
	description: Type.String({ description: "A short (3-5 word) description of the task" }),
	prompt: Type.String({ description: "The task for the agent to perform" }),
	subagent_type: Type.Optional(Type.String({ description: "The agent type; general-purpose when omitted" })),
	model: Type.Optional(Type.String({ description: "Omit normally: the agent runs your model and thinking level. Otherwise a configured name (astra, luna, opus) or provider/id[:level]; pass a model the user named exactly" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Default true: return at once and get a notification when the agent finishes. false waits for the result, for at most 2 minutes" })),
	name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", description: "A name to address the agent by; a later agent with the same name takes it over" })),
	isolation: Type.Optional(Type.Literal("worktree", { description: "Run in a fresh git worktree of the repo" })),
	cwd: Type.Optional(Type.String({ description: "Working directory, for one repo inside a multi-repo parent folder; defaults to yours" })),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1, description: `Model turns before the agent stops. ${ONLY_ON_REQUEST}` })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1, description: `Tokens before the agent stops. ${ONLY_ON_REQUEST}` })),
	timeout: Type.Optional(Type.Integer({ minimum: 1_000, description: `Milliseconds before the agent stops. ${ONLY_ON_REQUEST}` })),
});
type AgentParams = Static<typeof AgentSchema>;

const AGENT_DESCRIPTION = [
	"Launch an agent that works on a task by itself, with its own context and tools, and reports back once.",
	"",
	"Agents run in the background by default: the call returns at once and a <task-notification> arrives in your conversation when the agent finishes. Do not poll, sleep or read its output file while it runs; keep working or answer the user. Do not do the same work yourself in parallel, and do not report a result before its notification arrives.",
	"Launch independent agents in one message with several Agent calls so they run at the same time. Set run_in_background: false only when you cannot go on without the answer.",
	"",
	"The agent starts with none of your context. Write the prompt as a complete brief: the goal, what you already know, the files and constraints involved, and what to return. Say whether it should change code or only research. Never delegate your own understanding: synthesize what agents report before acting on it.",
].join("\n");

export default function subagentsExtension(pi: ExtensionAPI): void {
	tasks.install(pi);

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: AGENT_DESCRIPTION,
		promptSnippet: "Delegate a self-contained task to a background agent that reports back once.",
		parameters: AgentSchema,
		async execute(toolCallId, params: AgentParams, signal, _onUpdate, ctx) {
			const type = findAgentType(params.subagent_type);
			if (params.name && RESERVED_NAMES.has(params.name)) throw new Error(`The name '${params.name}' is reserved; pick another.`);
			if ((params.isolation ?? type.isolation) === "worktree") throw new Error("Worktree isolation is not available yet; run without isolation.");
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd ${cwd} is not a directory.`);
			const level = pi.getThinkingLevel();
			const resolved = resolveModel(params.model ?? type.model, {
				config: await loadKitConfig(ctx.cwd, getAgentDir()),
				registry: ctx.modelRegistry,
				lead: ctx.model ? { model: ctx.model, level } : undefined,
			}, type.effort);
			if (resolved.harness !== "pi") throw new Error(`${modelLabel(resolved)} runs as a Claude Code or Codex worker, which the kit does not start yet; pick a Pi model.`);
			const limits: Limits = { maxTurns: params.maxTurns, maxTokens: params.maxTokens, timeout: params.timeout };
			const foreground = params.run_in_background === false;
			const engine = await ensureEngine(ctx);
			const writer = type.tools.includes("edit") || type.tools.includes("write");
			const sharesCwd = writer && await writersIn(engine, cwd) > 0;
			const queued = queuedAhead();
			const { agentId, outputFile, done } = await launch(engine, {
				description: params.description,
				prompt: params.prompt,
				name: params.name,
				model: resolved.model,
				level: resolved.level,
				tools: type.tools,
				instructions: workerPrompt(type, cwd),
				cwd,
				writer,
				toolUseId: toolCallId,
				limits,
				foreground,
			});
			const launched = launchText(agentId, outputFile, modelLabel(resolved), limits, queued, sharesCwd);
			if (!done) return { content: [{ type: "text" as const, text: launched }], details: { agentId, outputFile, status: "async_launched" } };
			const outcome = await settle(agentId, done, FOREGROUND_MS, signal);
			if (outcome === "background") return { content: [{ type: "text" as const, text: launched }], details: { agentId, outputFile, status: "async_launched" } };
			if (outcome === "aborted") {
				await tasks.find(agentId)?.stop?.();
				throw new Error(`Agent "${params.description}" was stopped`);
			}
			if (outcome.status !== "completed") throw new Error([outcome.summary, outcome.result].filter(Boolean).join("\n"));
			return { content: [{ type: "text" as const, text: foregroundText(agentId, outcome, limits) }], details: { agentId, outputFile, status: outcome.status } };
		},
	});

	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description: "Stop a running background task: an agent, by its agentId or name, or a job, by its id.",
		promptSnippet: "Stop a background agent or job that is no longer needed.",
		parameters: Type.Object({ task_id: Type.String({ description: "The id or name of the task to stop" }) }),
		async execute(_toolCallId, params: { task_id: string }, _signal, _onUpdate, ctx) {
			const entry = tasks.find(params.task_id, ctx.sessionManager.getSessionId());
			if (!entry) throw new Error(`No task found with ID: ${params.task_id}`);
			if (entry.status !== "running" || !entry.stop) throw new Error(`Task ${entry.id} is not running (status: ${entry.status})`);
			await entry.stop();
			tasks.update(entry.id, { status: "killed" });
			return { content: [{ type: "text" as const, text: `Successfully stopped task: ${entry.id} (${entry.description})` }], details: { taskId: entry.id, kind: entry.kind } };
		},
	});

	pi.registerCommand("agents", {
		description: "List this session's background agents and jobs, and the agent types",
		handler: async (_args, ctx) => showTextViewer(ctx, "Agents", rosterText(ctx)),
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") await reinstall();
		else await useLeadModel(pi, ctx).catch((error: unknown) => ctx.ui.notify(`The lead stays on Pi's model: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		await resumeSession(ctx).catch((error: unknown) => ctx.ui.notify(`Agents of this session did not resume: ${error instanceof Error ? error.message : String(error)}`, "error"));
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.agent_types = agentTypesSection();
	});
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await closeAll();
	});
}

/** A new session (no assistant message yet, no --model or --provider) switches to the newest match of pi-kit.json's `lead`. */
async function useLeadModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (process.argv.includes("--model") || process.argv.includes("--provider")) return;
	if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant")) return;
	const lead = resolveLead({ config: await loadKitConfig(ctx.cwd, getAgentDir()), registry: ctx.modelRegistry });
	if (!lead) return;
	if (!await pi.setModel(lead.model)) throw new Error(`${lead.model.provider} is not logged in.`);
	if (lead.level) pi.setThinkingLevel(lead.level);
}

function limitsLine(limits: Limits): string | undefined {
	const set = [limits.maxTurns && `maxTurns ${limits.maxTurns}`, limits.maxTokens && `maxTokens ${limits.maxTokens}`, limits.timeout && `timeout ${limits.timeout} ms`].filter(Boolean);
	return set.length ? `Limits: ${set.join(", ")}` : undefined;
}

function launchText(agentId: string, outputFile: string, model: string, limits: Limits, queued: boolean, sharesCwd: boolean): string {
	return [
		"Async agent launched successfully.",
		`agentId: ${agentId} (internal ID; to continue this agent, use SendMessage with to: '${agentId}')`,
		"The agent works in the background and you will be notified when it finishes. Until then you know nothing about its result: do not guess or report it; continue other work or answer the user.",
		"Do not duplicate its work or edit the files it is working on.",
		`output_file: ${outputFile}`,
		"Do not read or tail output_file; it is written when the agent finishes. If the user asks for progress, say the agent is still running.",
		`Model: ${model}`,
		limitsLine(limits),
		queued && `Queued: ${AGENT_SLOTS} agents are running; this one starts when a slot frees.`,
		sharesCwd && 'For parallel code-writing agents, dispatch each with isolation: "worktree".',
	].filter(Boolean).join("\n");
}

function foregroundText(agentId: string, n: TaskNotification, limits: Limits): string {
	return [
		n.result || "(Subagent completed but returned no output.)",
		`agentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)`,
		n.limited && `Limited: ${n.summary}`,
		limitsLine(limits),
		`<usage>subagent_tokens: ${n.usage?.subagentTokens ?? 0}\ntool_uses: ${n.usage?.toolUses ?? 0}\nduration_ms: ${n.usage?.durationMs ?? 0}</usage>`,
	].filter(Boolean).join("\n");
}

function rosterText(ctx: ExtensionContext): string {
	const entries = tasks.list(ctx.sessionManager.getSessionId());
	return [
		`Tasks (${entries.length})`,
		...(entries.length ? entries.map((entry) => `${entry.status.padEnd(9)} ${entry.kind.padEnd(5)} ${entry.id}${entry.name ? ` (${entry.name})` : ""} · ${entry.description}`) : ["none"]),
		"",
		"Agent types",
		...agentTypes().map((type) => `- ${type.name}: ${type.tools.join(", ")}`),
	].join("\n");
}
