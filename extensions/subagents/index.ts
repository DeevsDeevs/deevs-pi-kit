import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { getAgentDir, isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardBashCall, guardShell, loadGuardConfig } from "../shared/guard.ts";
import { loadKitConfig, modelLabel, modelsTable, readCodexCatalog, resolveLead, resolveModel, type ModelContext } from "../shared/models.ts";
import { agentForegroundResult, agentLaunchedResult, newAgentId, newBackgroundTaskId, newWorkflowRunId, newWorkflowTaskId, taskNotRunningResult, taskStoppedResult, tasks, workflowLaunchedResult, type RosterEntry } from "../shared/tasks.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { createAgentWorktree, finishAgentWorktree, gitTopLevel, sharesCwd } from "../shared/worktree.ts";
import { remindSilentTurns } from "./silent-turns.ts";
import { promptWorkflow, WORKFLOW_DESCRIPTION, WORKFLOW_FIELDS, WORKFLOW_SNIPPET } from "./workflow-prompt.ts";
import { agentTypes, agentTypesSection, findAgentType, workerPrompt } from "./definitions.ts";
import { nextFire } from "./engine/background.ts";
import { formatLocalTime, parseCron } from "./engine/cron.ts";
import { closeAll, ensureEngine, launch, launchWorkflow, queuedAhead, reinstall, resumeSession, send, settle, startJob, startMonitor, stop, workflowProgress, writerCwds, type Limits } from "./engine/index.ts";
import { lookAtPath, lookAtUrl } from "./engine/watch.ts";
import { parseWorkflow } from "./workflow/meta.ts";
import type { Progress } from "./workflow/run.ts";

const FOREGROUND_MS = 120_000;
/** A longer request is not relayed to workflow agents: a cut one could mislead them. */
const MAX_REQUEST_CHARS = 4_000;
const AUTHORING_HINT = "Load the `workflow-authoring` skill for the script format, fix the script, and retry.";
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
	"subagent_type picks one of the agent types listed in your system prompt; general-purpose when omitted. When you already know the file or symbol, use read, grep or find yourself: agents are for open questions across the code and for work that matches a type.",
	"",
	"- By default an agent runs in the background: the call returns at once and a <task-notification> arrives in your conversation when the agent finishes. Do not poll, sleep or read its output file meanwhile; keep working or answer the user.",
	"- Use run_in_background: false only if your next step cannot start without the answer and nothing else useful can happen meanwhile.",
	"- Do not race: until the notification arrives you know nothing of the result, so never guess or pre-write it, and do not redo the agent's work yourself. If the user asks, say it is still running.",
	"- Launch independent agents in one message with several Agent calls so they run at the same time.",
	"- The user never sees the report: tell them what matters in it. A report says what the agent meant to do; when it changed code, look at the change before calling the work done.",
	"- SendMessage to an agentId or name continues that agent with its context; a new Agent call starts from nothing.",
	"- A type sets the model, effort and tools; `model` overrides them for this call.",
	"- isolation: \"worktree\" puts the agent in its own worktree and branch: an unchanged one is removed, a changed one is kept and its path and branch reported. Give each parallel writer one.",
	"",
	"The agent has seen none of this conversation. Brief it like a capable colleague who just walked in: the goal and why it matters, what you know or have ruled out, the files and constraints involved, and the form and length of answer you want. Say whether it should change code or only research. For a lookup, hand over the exact command; for an investigation, hand over the question rather than a list of steps. Never delegate understanding: instead of \"fix it based on your findings\", name the paths, lines and change you want, and synthesize what agents report before you act on it.",
].join("\n");

const WorkflowSchema = Type.Object({
	script: Type.Optional(Type.String({ description: WORKFLOW_FIELDS.script })),
	scriptPath: Type.Optional(Type.String({ description: WORKFLOW_FIELDS.scriptPath })),
	name: Type.Optional(Type.String({ description: WORKFLOW_FIELDS.name })),
	args: Type.Optional(Type.Any({ description: WORKFLOW_FIELDS.args })),
	resumeFromRunId: Type.Optional(Type.String({ pattern: "^wf_[a-z0-9-]{6,}$", description: WORKFLOW_FIELDS.resumeFromRunId })),
});
type WorkflowParams = Static<typeof WorkflowSchema>;

const JobSchema = Type.Object({
	command: Type.String({ description: "The shell command to run" }),
	description: Type.String({ description: "A short description of what it does, shown in the notification" }),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to yours" })),
	timeout: Type.Optional(Type.Integer({ minimum: 1_000, description: `Milliseconds before the command is killed. ${ONLY_ON_REQUEST}` })),
});
type JobParams = Static<typeof JobSchema>;

const MonitorSchema = Type.Object({
	description: Type.String({ description: "What is watched; shown in every event" }),
	command: Type.Optional(Type.String({ description: "Script; each stdout line is an event, exit ends the watch" })),
	path: Type.Optional(Type.String({ description: "Folder or file" })),
	url: Type.Optional(Type.String({ description: "http(s) URL, polled with GET" })),
	cron: Type.Optional(Type.String({ description: "5-field cron, local time" })),
	prompt: Type.Optional(Type.String({ description: "With cron: what each fire delivers" })),
	every: Type.Optional(Type.Number({ description: "Seconds between probes: path 2 (min 1), url 60 (min 30)" })),
	once: Type.Optional(Type.Boolean({ description: "End after the first event" })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, description: `Expiry. ${ONLY_ON_REQUEST}` })),
});
type MonitorParams = Static<typeof MonitorSchema>;

const MONITOR_DESCRIPTION = [
	"Watch something in the background and get a <task-notification> per event while you keep working. An event is not the user's reply.",
	"Sources, exactly one: command (each stdout line is an event, lines within 200 ms arrive together; exit ends the watch with its code; stderr only reaches the output file, so add 2>&1 when failures matter), path (a folder's added, changed and removed files, or a file's new lines), url (a status or body change), cron with prompt (a local-time timer that delivers the prompt when you are idle).",
	"For \"tell me when X\", use a command that exits once X holds (`until test -e out/done; do sleep 1; done`) or once: true. Scripts must flush each line (grep --line-buffered), survive a failed probe (`curl ... || true`), and match failures as well as success: silence is not success. Floods are rate limited, then stopped.",
	"Watches survive /reload and pause while Pi is closed. On reopen a path or url watch reports what changed meanwhile as one caught_up event, an overdue cron fires once, and a command runs again from the top.",
].join("\n");

export default function subagentsExtension(pi: ExtensionAPI): void {
	tasks.install(pi);
	const modelContext = async (ctx: ExtensionContext): Promise<ModelContext> => ({
		config: await loadKitConfig(ctx.cwd, getAgentDir()),
		registry: ctx.modelRegistry,
		lead: ctx.model ? { model: ctx.model, level: pi.getThinkingLevel() } : undefined,
		codex: readCodexCatalog(process.env.CODEX_HOME || join(homedir(), ".codex")),
	});
	remindSilentTurns(pi);
	// The request that started the current turn, snapshotted by Workflow at launch; a later side question never reaches its agents.
	let request: string | undefined;
	pi.on("input", (event) => {
		if (event.streamingBehavior === undefined && event.source !== "extension") request = event.text;
	});
	let widget: NodeJS.Timeout | undefined;
	promptWorkflow(pi);

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: AGENT_DESCRIPTION,
		promptSnippet: "Delegate a self-contained task to a background agent that reports back once.",
		parameters: AgentSchema,
		async execute(toolCallId, params: AgentParams, signal, _onUpdate, ctx) {
			const type = findAgentType(params.subagent_type);
			if (params.name && RESERVED_NAMES.has(params.name)) throw new Error(`The name '${params.name}' is reserved; pick another.`);
			const requested = directory(ctx.cwd, params.cwd);
			const resolved = resolveModel(params.model ?? type.model, await modelContext(ctx), type.effort);
			const limits: Limits = { maxTurns: params.maxTurns, maxTokens: params.maxTokens, timeout: params.timeout };
			if (resolved.harness !== "pi" && limitsText(limits)) throw new Error(`maxTurns, maxTokens and timeout apply to Pi models only; ${modelLabel(resolved)} runs as a CLI worker.`);
			const foreground = params.run_in_background === false;
			const engine = await ensureEngine(ctx);
			const agentId = newAgentId();
			const writer = type.tools.includes("edit") || type.tools.includes("write");
			// Claude workers bypass permissions, so every writer in a repository gets its own worktree.
			const isolate = (params.isolation ?? type.isolation) === "worktree" || resolved.harness === "claude" && writer && await gitTopLevel(requested) !== undefined;
			const worktree = isolate ? await createAgentWorktree({ cwd: requested, agentId, agentDir: getAgentDir() }) : undefined;
			const cwd = worktree ? join(worktree.path, relative(worktree.repoRoot, realpathSync(requested))) : requested;
			const shared = writer && sharesCwd(await writerCwds(engine), cwd);
			const queued = queuedAhead();
			const base = { agentId, description: params.description, prompt: params.prompt, name: params.name, cwd, writer, toolUseId: toolCallId, foreground, worktree };
			let started: Awaited<ReturnType<typeof launch>>;
			try {
				started = await launch(engine, resolved.harness === "pi"
					? { ...base, model: resolved.model, level: resolved.level, tools: type.tools, instructions: workerPrompt(type, cwd, worktree), limits }
					: { ...base, cli: { harness: resolved.harness, model: resolved.model, level: resolved.level, cwd, instructions: workerPrompt(type, cwd, worktree, true), tools: type.tools, writer, dir: join(engine.dir, "cli", agentId) } });
			} catch (error) {
				if (worktree) await finishAgentWorktree(worktree).catch(() => undefined);
				throw error;
			}
			const { outputFile, done } = started;
			const launched = agentLaunchedResult({ agentId, outputFile, model: modelLabel(resolved), limits: limitsText(limits), queued, sharesCwd: shared });
			if (!done) return { content: [{ type: "text" as const, text: launched }], details: { agentId, outputFile, status: "async_launched" } };
			const outcome = await settle(agentId, done, FOREGROUND_MS, signal);
			if (outcome === "background") return { content: [{ type: "text" as const, text: launched }], details: { agentId, outputFile, status: "async_launched" } };
			if (outcome === "aborted") {
				await tasks.find(agentId)?.stop?.();
				throw new Error(`Agent "${params.description}" was stopped`);
			}
			if (outcome.status !== "completed") throw new Error([outcome.summary, outcome.result].filter(Boolean).join("\n"));
			const text = agentForegroundResult({ text: outcome.result ?? "", agentId, limited: outcome.limited && outcome.summary, limits: limitsText(limits), worktree: outcome.worktree, usage: { subagentTokens: outcome.usage?.subagentTokens ?? 0, toolUses: outcome.usage?.toolUses ?? 0, durationMs: outcome.usage?.durationMs ?? 0 } });
			return { content: [{ type: "text" as const, text }], details: { agentId, outputFile, status: outcome.status } };
		},
	});

	pi.registerTool({
		name: "Workflow",
		label: "Workflow",
		description: WORKFLOW_DESCRIPTION,
		promptSnippet: WORKFLOW_SNIPPET,
		parameters: WorkflowSchema,
		async execute(toolCallId, params: WorkflowParams, _signal, _onUpdate, ctx) {
			const { source, scriptPath } = await workflowSource(params, ctx.cwd);
			let meta;
			try {
				({ meta } = parseWorkflow(source));
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${AUTHORING_HINT}`);
			}
			const session = ctx.sessionManager.getSessionId();
			const resumed = params.resumeFromRunId;
			if (resumed && tasks.find(resumed, session)?.status === "running") throw new Error(`Workflow run ${resumed} is still running; stop it with TaskStop before resuming it.`);
			const home = join(getAgentDir(), "pi-kit", "workflows", createHash("sha256").update(realpathSync(ctx.cwd)).digest("hex").slice(0, 16));
			const runId = resumed ?? newWorkflowRunId();
			const dir = join(home, runId);
			if (resumed && !existsSync(join(dir, "journal.jsonl"))) throw new Error(`No journal found for workflow run ${resumed} in this project; call Workflow again without resumeFromRunId.`);
			const file = scriptPath ?? join(home, "scripts", `${meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${runId}.js`);
			await mkdir(dir, { recursive: true });
			if (!scriptPath) {
				await mkdir(dirname(file), { recursive: true, mode: 0o700 });
				await writeFile(file, source, { mode: 0o600 });
			}
			if (!resumed) await appendFile(join(dir, "journal.jsonl"), `${JSON.stringify({ type: "launched" })}\n`);
			const taskId = newWorkflowTaskId();
			await launchWorkflow(await ensureEngine(ctx), {
				taskId,
				runId,
				session,
				toolUseId: toolCallId,
				source,
				scriptPath: file,
				args: coerceArgs(params.args),
				cwd: ctx.cwd,
				dir,
				request: request !== undefined && request.length <= MAX_REQUEST_CHARS ? request : undefined,
				lead: ctx.model && { provider: ctx.model.provider, id: ctx.model.id, level: pi.getThinkingLevel() },
				startedAt: Date.now(),
			}, meta.description);
			const text = workflowLaunchedResult({ taskId, summary: meta.description, transcriptDir: dir, scriptPath: file, runId });
			return { content: [{ type: "text" as const, text }], details: { taskId, runId, scriptPath: file, transcriptDir: dir, status: "async_launched" } };
		},
	});

	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description: "Stop a running background task: an agent, by its agentId or name; a workflow, by its task id (w…) or run id (wf_…), with no notification after; or a job or monitor, by its id.",
		promptSnippet: "Stop a background agent, job or monitor that is no longer needed.",
		parameters: Type.Object({ task_id: Type.String({ description: "The id or name of the task to stop" }) }),
		async execute(_toolCallId, params: { task_id: string }, _signal, _onUpdate, ctx) {
			const entry = tasks.find(params.task_id, ctx.sessionManager.getSessionId());
			if (!entry) throw new Error(`No task found with ID: ${params.task_id}`);
			if (entry.status !== "running" || !entry.stop) throw new Error(taskNotRunningResult(entry.id, entry.status));
			const stopped = await entry.stop();
			if (tasks.find(entry.id)?.status === "running") tasks.update(entry.id, { status: "killed" });
			const text = taskStoppedResult(entry.id, entry.description, stopped?.worktree ? [stopped.worktree] : []);
			return { content: [{ type: "text" as const, text }], details: { taskId: entry.id, kind: entry.kind } };
		},
	});

	pi.registerTool({
		name: "job_start",
		label: "job_start",
		description: "Run a shell command in the background. The call returns at once with the job id and its output file; a <task-notification> arrives when the command exits, with its exit code. Read the output file with read; stop the job with TaskStop. A job lives in this Pi: it survives /reload, and if Pi closes first it is killed and reported as interrupted. Servers, watchers and REPLs that must outlive Pi belong in Herdr.",
		promptSnippet: "Run a command in the background and get notified when it exits.",
		parameters: JobSchema,
		async execute(toolCallId, params: JobParams, _signal, _onUpdate, ctx) {
			const cwd = directory(ctx.cwd, params.cwd);
			const blocked = guardShell(params.command, { cwd, root: ctx.cwd, config: loadGuardConfig(ctx.cwd) });
			if (blocked) throw new Error(blocked);
			const id = newBackgroundTaskId();
			const outputFile = await startJob(await ensureEngine(ctx), { id, command: params.command, description: params.description, cwd, toolUseId: toolCallId, timeout: params.timeout });
			const text = [
				`Command running in background with ID: ${id}. Output is being written to: ${outputFile}`,
				"You will be notified when it exits. Do not poll, sleep or wait for it; keep working, and read the output file once the notification arrives.",
				params.timeout && `Timeout: ${params.timeout} ms`,
			].filter(Boolean).join("\n");
			return { content: [{ type: "text" as const, text }], details: { taskId: id, outputFile } };
		},
	});

	pi.registerTool({
		name: "Monitor",
		label: "Monitor",
		description: MONITOR_DESCRIPTION,
		promptSnippet: "Watch a command's output, a folder, a URL or a cron timer, and get notified on each event.",
		parameters: MonitorSchema,
		async execute(_toolCallId, params: MonitorParams, signal, _onUpdate, ctx) {
			const sources = (["command", "path", "url", "cron"] as const).filter((key) => params[key] !== undefined);
			if (sources.length !== 1) throw new Error("Give exactly one of command, path, url or cron.");
			const source = sources[0]!;
			if ((source === "cron") !== (params.prompt !== undefined)) throw new Error("prompt goes with cron, and cron needs a prompt.");
			const every = (params.every ?? (source === "url" ? 60 : 2)) * 1000;
			if (every < (source === "url" ? 30_000 : 1_000)) throw new Error(`every must be at least ${source === "url" ? 30 : 1} seconds for ${source}.`);
			const cwd = ctx.cwd;
			let target = params[source]!;
			let look: Awaited<ReturnType<typeof lookAtPath>> | Awaited<ReturnType<typeof lookAtUrl>> | undefined;
			let baseline: string | undefined;
			if (source === "command") {
				const blocked = guardShell(target, { cwd, config: loadGuardConfig(cwd) });
				if (blocked) throw new Error(blocked);
			} else if (source === "cron") {
				const next = nextFire(parseCron(target).raw, Date.now());
				if (next === Infinity) throw new Error(`Cron expression ${JSON.stringify(target)} has no fire within five years.`);
				baseline = `next fire ${formatLocalTime(next)}`;
			} else if (source === "path") {
				target = resolve(cwd, target);
				look = await lookAtPath(target, undefined);
			} else {
				if (!/^https?:\/\//.test(target)) throw new Error("url must start with http:// or https://.");
				look = await lookAtUrl(target, undefined, signal ?? new AbortController().signal);
			}
			baseline ??= look?.baseline;
			const id = newBackgroundTaskId();
			const outputFile = await startMonitor(await ensureEngine(ctx), { id, description: params.description, cwd, source, target, prompt: params.prompt, every, once: params.once ?? false, timeoutMs: params.timeout_ms, seen: look?.seen });
			const until = params.timeout_ms ? `it expires after ${Math.round(params.timeout_ms / 1000)}s`
				: params.once ? "its first event or TaskStop"
				: source === "command" ? "the script exits or you stop it with TaskStop"
				: "you stop it with TaskStop";
			const text = `Monitor started (task ${id}${baseline ? `; ${baseline}` : ""}). It runs until ${until}. You will be notified on each event. Keep working; do not poll or sleep. An event is not the user's reply.`;
			return { content: [{ type: "text" as const, text }], details: { taskId: id, outputFile, baseline } };
		},
	});

	pi.registerTool({
		name: "SendMessage",
		label: "SendMessage",
		description: [
			"Send a message to an agent you launched, by its agentId or name.",
			"A running agent gets it at its next tool round and folds it into its current work; a running Claude or Codex worker gets it when its current run ends. An agent that finished, failed or that you stopped resumes with its full context under the same agentId and notifies again. An agent the user stopped is not resumed.",
		].join("\n"),
		promptSnippet: "Steer a running agent, or continue a finished one with its context.",
		parameters: Type.Object({
			to: Type.String({ description: "The agentId or name of the agent" }),
			message: Type.String({ description: "The message" }),
			summary: Type.Optional(Type.String({ description: "A 5-10 word preview of the message" })),
		}),
		async execute(toolCallId, params: { to: string; message: string }, _signal, _onUpdate, ctx) {
			const session = ctx.sessionManager.getSessionId();
			const entry = tasks.find(params.to, session, "agent");
			if (!entry) {
				const known = tasks.list(session).filter((task) => task.kind === "agent").map((task) => task.name ?? task.id);
				throw new Error(`No agent named '${params.to}'. Known agents: ${known.join(", ") || "none"}`);
			}
			const outcome = await send(await ensureEngine(ctx), entry.id, params.message, toolCallId);
			if (outcome === "refused") throw new Error(`Agent "${params.to}" was stopped by the user and was not resumed. Start a new agent for this work only if the user explicitly asks for it.`);
			const text = outcome === "steered" ? `Message queued for delivery to ${params.to} at its next tool round.`
				: outcome === "queued" ? `Message queued for delivery to ${params.to} when its current run ends.`
				: `Resuming agent ${params.to}`;
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
			if (tasks.find(entry.id)?.status === "running") tasks.update(entry.id, { status: "killed" });
			ctx.ui.notify(`Stopped ${entry.id} (${entry.description})`, "info");
		},
	});

	pi.on("tool_call", (event, ctx) => isToolCallEventType("bash", event) ? guardBashCall(event.input.command, ctx.cwd) : undefined);
	pi.on("session_start", async (event, ctx) => {
		clearInterval(widget);
		let shown = "";
		widget = setInterval(() => {
			const lines = runningWorkflows(ctx).map(widgetLine);
			if (lines.join("\n") === shown) return;
			shown = lines.join("\n");
			ctx.ui.setWidget("workflows", lines.length ? lines : undefined);
		}, 1_000);
		widget.unref();
		if (event.reason === "reload") await reinstall();
		else await useLeadModel(pi, ctx).catch((error) => ctx.ui.notify(`The lead stays on Pi's model: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		await resumeSession(ctx).catch((error) => ctx.ui.notify(`Agents of this session did not resume: ${error instanceof Error ? error.message : String(error)}`, "error"));
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.agent_types = agentTypesSection();
	});
	pi.on("session_shutdown", async (event) => {
		clearInterval(widget);
		if (event.reason === "quit") await closeAll();
	});
}

/** `scriptPath`, then `name`, then `script`; only a scriptPath is run from its own file, the others get a persisted copy. */
async function workflowSource(params: WorkflowParams, cwd: string): Promise<{ source: string; scriptPath?: string }> {
	if (params.scriptPath) {
		const scriptPath = resolve(cwd, params.scriptPath);
		const source = await readFile(scriptPath, "utf8").catch(() => undefined);
		if (source === undefined) throw new Error(`Cannot read the workflow script ${scriptPath}.`);
		return { source, scriptPath };
	}
	if (params.name) {
		for (const dir of [join(cwd, ".pi", "workflows"), join(getAgentDir(), "workflows")]) {
			const source = await readFile(join(dir, `${params.name}.js`), "utf8").catch(() => undefined);
			if (source !== undefined) return { source };
		}
		throw new Error(`No workflow named '${params.name}' in .pi/workflows or ~/.pi/agent/workflows.`);
	}
	if (params.script) return { source: params.script };
	throw new Error("Workflow needs a script, a scriptPath or a name.");
}

/** `args` given as a JSON string of an object or array is parsed, as CC does. */
function coerceArgs(args: WorkflowParams["args"]): WorkflowParams["args"] {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- args arrive untyped from the model: this is their decoding boundary.
	if (!(typeof args === "string" && /^\s*[[{]/.test(args))) return args;
	try {
		return JSON.parse(args);
	} catch {
		return args;
	}
}

function runningWorkflows(ctx: ExtensionContext): Progress[] {
	try {
		return workflowProgress(ctx.sessionManager.getSessionId()).filter((progress) => progress.status === "running");
	} catch {
		return [];
	}
}

function widgetLine(progress: Progress): string {
	const count = (state: string) => progress.agents.filter((agent) => agent.state === state).length;
	const failed = count("error");
	const tokens = progress.agents.reduce((sum, agent) => sum + agent.tokens, 0);
	return `${progress.meta.name} ${progress.taskId} · ${progress.phase ?? "-"} · ${count("start")} running, ${count("done")}/${progress.agents.length} done${failed ? `, ${failed} failed` : ""} · ${tokens} tokens · ${age(Date.now() - progress.startedAt)}`;
}

/** The /agents view of a run: one row per agent() call with its phase, label, state, tokens and age. */
function workflowLines(progress: Progress): string[] {
	const now = Date.now();
	return [
		"",
		`Workflow ${progress.taskId} (${progress.runId}) ${progress.status} · ${progress.meta.description}`,
		...progress.agents.map((agent) => `  ${agent.phase ?? "-"} · ${agent.label} · ${agent.state}${agent.cached ? " (cached)" : ""} · ${agent.tokens} tokens · ${age(now - (agent.startedAt ?? agent.queuedAt))}`),
	];
}

function age(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
	return ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;
}

function directory(base: string, cwd: string | undefined): string {
	const requested = resolve(base, cwd ?? ".");
	if (!existsSync(requested) || !statSync(requested).isDirectory()) throw new Error(`cwd ${requested} is not a directory.`);
	return requested;
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

function limitsText(limits: Limits): string | undefined {
	const set = [limits.maxTurns && `maxTurns ${limits.maxTurns}`, limits.maxTokens && `maxTokens ${limits.maxTokens}`, limits.timeout && `timeout ${limits.timeout} ms`].filter(Boolean);
	return set.length ? set.join(", ") : undefined;
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
		...workflowProgress(ctx.sessionManager.getSessionId()).flatMap(workflowLines),
		"",
		"Agent types",
		...agentTypes().map((type) => `- ${type.name}: ${type.tools.join(", ")}`),
		"",
		"Models",
		...modelsTable(models),
	].join("\n");
}
