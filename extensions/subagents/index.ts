import { existsSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadKitConfig, modelLabel, modelsTable, resolveModel, type ModelContext } from "../shared/models.ts";
import { newAgentId, tasks, type RosterEntry, type TaskNotification } from "../shared/tasks.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { createAgentWorktree, sharedCwdWarning } from "../shared/worktree.ts";
import { agentTypes, agentTypesSection, findAgentType, workerPrompt } from "./definitions.ts";
import { AGENT_SLOTS, closeAll, ensureEngine, launch, queuedAhead, reinstall, resumeSession, send, settle, stop, writerCwds, type Limits } from "./engine/index.ts";

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
	const modelContext = async (ctx: ExtensionContext): Promise<ModelContext> => ({
		config: await loadKitConfig(ctx.cwd, getAgentDir()),
		registry: ctx.modelRegistry,
		lead: ctx.model ? { model: ctx.model, level: pi.getThinkingLevel() } : undefined,
	});

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: AGENT_DESCRIPTION,
		promptSnippet: "Delegate a self-contained task to a background agent that reports back once.",
		parameters: AgentSchema,
		async execute(toolCallId, params: AgentParams, signal, _onUpdate, ctx) {
			const type = findAgentType(params.subagent_type);
			if (params.name && RESERVED_NAMES.has(params.name)) throw new Error(`The name '${params.name}' is reserved; pick another.`);
			const requested = resolve(ctx.cwd, params.cwd ?? ".");
			if (!existsSync(requested) || !statSync(requested).isDirectory()) throw new Error(`cwd ${requested} is not a directory.`);
			const resolved = resolveModel(params.model ?? type.model, await modelContext(ctx), type.effort);
			if (resolved.harness !== "pi") throw new Error(`${modelLabel(resolved)} runs as a Claude Code or Codex worker, which the kit does not start yet; pick a Pi model.`);
			const limits: Limits = { maxTurns: params.maxTurns, maxTokens: params.maxTokens, timeout: params.timeout };
			const foreground = params.run_in_background === false;
			const engine = await ensureEngine(ctx);
			const agentId = newAgentId();
			const worktree = (params.isolation ?? type.isolation) === "worktree" ? await createAgentWorktree({ cwd: requested, agentId, agentDir: getAgentDir() }) : undefined;
			const cwd = worktree ? join(worktree.path, relative(worktree.repoRoot, realpathSync(requested))) : requested;
			const writer = type.tools.includes("edit") || type.tools.includes("write");
			const sharesCwd = writer ? sharedCwdWarning(await writerCwds(engine), cwd) : undefined;
			const queued = queuedAhead();
			const { outputFile, done } = await launch(engine, {
				agentId,
				description: params.description,
				prompt: params.prompt,
				name: params.name,
				model: resolved.model,
				level: resolved.level,
				tools: type.tools,
				instructions: workerPrompt(type, cwd, worktree),
				cwd,
				writer,
				toolUseId: toolCallId,
				limits,
				foreground,
				worktree,
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

	pi.registerTool({
		name: "SendMessage",
		label: "SendMessage",
		description: [
			"Send a message to an agent you launched, by its agentId or name.",
			"A running agent gets it at its next tool round and folds it into its current work. An agent that finished, failed or that you stopped resumes with its full context under the same agentId and notifies again. An agent the user stopped is not resumed.",
		].join("\n"),
		promptSnippet: "Steer a running agent, or continue a finished one with its context.",
		parameters: Type.Object({
			to: Type.String({ description: "The agentId or name of the agent" }),
			message: Type.String({ description: "The message" }),
			summary: Type.Optional(Type.String({ description: "A 5-10 word preview of the message" })),
		}),
		async execute(toolCallId, params: { to: string; message: string }, _signal, _onUpdate, ctx) {
			const session = ctx.sessionManager.getSessionId();
			const entry = tasks.find(params.to, session);
			if (!entry || entry.kind !== "agent") {
				const known = tasks.list(session).filter((task) => task.kind === "agent").map((task) => task.name ?? task.id);
				throw new Error(`No agent named '${params.to}'. Known agents: ${known.join(", ") || "none"}`);
			}
			const outcome = await send(await ensureEngine(ctx), entry.id, params.message, toolCallId);
			if (outcome === "refused") throw new Error(`Agent "${params.to}" was stopped by the user and was not resumed. Ask the user before starting it again, or launch a new agent.`);
			const text = outcome === "steered" ? `Message queued for delivery to ${params.to} at its next tool round.` : `Resuming agent ${params.to}`;
			return { content: [{ type: "text" as const, text }], details: { agentId: entry.id, outcome } };
		},
	});

	pi.registerTool({
		name: "ListAgents",
		label: "ListAgents",
		description: "List this session's background tasks, each labelled by kind (agent, workflow, job, monitor, collaborator), with its id, name, status and description.",
		promptSnippet: "List background agents, workflows, jobs, monitors and collaborators.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const entries = tasks.list(ctx.sessionManager.getSessionId());
			return { content: [{ type: "text" as const, text: rosterLines(entries).join("\n") }], details: { count: entries.length } };
		},
	});

	pi.registerCommand("agents", {
		description: "Background tasks, agent types and models; /agents stop <id> stops a task, /agents attach <id> shows how to open it",
		handler: async (args, ctx) => {
			const [verb = "", id = ""] = args.trim().split(/\s+/);
			if (!verb) return showTextViewer(ctx, "Agents", overview(ctx, await modelContext(ctx)));
			if (verb !== "stop" && verb !== "attach") return ctx.ui.notify("Usage: /agents [stop <id> | attach <id>]", "warning");
			const entry = tasks.find(id, ctx.sessionManager.getSessionId());
			if (!entry) return ctx.ui.notify(`No task found with ID: ${id}`, "warning");
			if (verb === "attach") return ctx.ui.notify(entry.attach ?? `${entry.id} runs inside this Pi and has no session of its own to attach to.`, "info");
			if (entry.status !== "running") return ctx.ui.notify(`Task ${entry.id} is not running (status: ${entry.status})`, "warning");
			if (entry.kind === "agent") await stop(await ensureEngine(ctx), entry.id, "user");
			else await entry.stop?.();
			tasks.update(entry.id, { status: "killed" });
			ctx.ui.notify(`Stopped ${entry.id} (${entry.description})`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") await reinstall();
		await resumeSession(ctx).catch((error: unknown) => ctx.ui.notify(`Agents of this session did not resume: ${error instanceof Error ? error.message : String(error)}`, "error"));
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.agent_types = agentTypesSection();
	});
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await closeAll();
	});
}

function limitsLine(limits: Limits): string | undefined {
	const set = [limits.maxTurns && `maxTurns ${limits.maxTurns}`, limits.maxTokens && `maxTokens ${limits.maxTokens}`, limits.timeout && `timeout ${limits.timeout} ms`].filter(Boolean);
	return set.length ? `Limits: ${set.join(", ")}` : undefined;
}

function launchText(agentId: string, outputFile: string, model: string, limits: Limits, queued: boolean, sharedCwd: string | undefined): string {
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
		sharedCwd,
	].filter(Boolean).join("\n");
}

function foregroundText(agentId: string, n: TaskNotification, limits: Limits): string {
	return [
		n.result || "(Subagent completed but returned no output.)",
		`agentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)`,
		n.limited && `Limited: ${n.summary}`,
		limitsLine(limits),
		n.worktree && `worktreePath: ${n.worktree.path}\nworktreeBranch: ${n.worktree.branch}`,
		`<usage>subagent_tokens: ${n.usage?.subagentTokens ?? 0}\ntool_uses: ${n.usage?.toolUses ?? 0}\nduration_ms: ${n.usage?.durationMs ?? 0}</usage>`,
	].filter(Boolean).join("\n");
}

function rosterLines(entries: RosterEntry[]): string[] {
	return [
		`Tasks (${entries.length})`,
		...(entries.length ? entries.map((entry) => `${entry.kind.padEnd(12)} ${entry.id}${entry.name ? ` (${entry.name})` : ""} ${entry.status} · ${entry.description}`) : ["none"]),
	];
}

function overview(ctx: ExtensionContext, models: ModelContext): string {
	return [
		...rosterLines(tasks.list(ctx.sessionManager.getSessionId())),
		"",
		"Agent types",
		...agentTypes().map((type) => `- ${type.name}: ${type.tools.join(", ")}`),
		"",
		"Models",
		...modelsTable(models),
	].join("\n");
}
