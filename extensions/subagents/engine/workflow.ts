// Workflow runs over durable: the run task, its agent() calls through the global throttle with the crash map, and the
// StructuredOutput tool and hook a schema call installs.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { LEVELS, modelContext, resolveModel, type ModelContext } from "../../shared/models.ts";
import { newAgentId, tasks, workflowDiagnostics, workflowRecovery, workflowSummary, type TaskNotification, type TaskStatus } from "../../shared/tasks.ts";
import { finishAgentWorktree, type AgentWorktree } from "../../shared/worktree.ts";
import { workerPrompt, workflowAgentType } from "../definitions.ts";
import { parseWorkflow } from "../workflow/meta.ts";
import { driveWorkflow, framePrompt, newProgress, runRecord, usage, type AgentRunner, type CallOutcome, type Progress } from "../workflow/run.ts";
import type { AgentOptions, JsonValue } from "../workflow/sandbox.ts";
import { decoded, json, post } from "./background.ts";
import { cliAnswer, CONTINUE, newProgress as newCliProgress, spawnWorker, type CliWorker } from "./cli.ts";
import { acquire, BACKGROUND, cliWorker, CTX, failure, host, placeAgent, release, scan, text, totalTokens, transcriptLog, type ConversationId, type Ctx, type D, type Engine, type Kit, type WorkflowsDoc } from "./host.ts";

const ObjectRoot = Type.Object({ type: Type.Literal("object"), properties: Type.Record(Type.String(), Type.Unknown()), required: Type.Optional(Type.Array(Type.String())) });
const STRUCTURED_OUTPUT = "StructuredOutput";
const STRUCTURED_OUTPUT_CAP = 5;
const NUDGE = "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.";
/** A Workflow run: the script, its snapshot of the user's request and the lead's model, all fixed at launch. */
export interface WorkflowInput {
	taskId: string;
	runId: string;
	session: string;
	toolUseId: string;
	source: string;
	scriptPath: string;
	args?: JsonValue;
	cwd: string;
	/** Whether Pi trusted the project at launch, so agent() reads its pi-kit.json `models`; absent on runs launched before it existed. */
	trusted?: boolean;
	/** The transcript dir: journal.jsonl, progress.jsonl, `<runId>.json` and each agent's transcript. */
	dir: string;
	request?: string;
	lead?: { provider: string; id: string; level: ModelThinkingLevel };
	startedAt: number;
}
export interface WorkflowRecord {
	runId: string;
	description: string;
	startedAt: number;
	status: TaskStatus;
	durableTaskId?: Durable.TaskId;
	/** The schemas its agent() calls use, installed again after a reopen. */
	schemas?: Durable.JsonObject[];
}
/** The crash map: one per agent() call, keyed by prompt, options and occurrence; written with the call's conversation, then with its outcome, whose `worktree` is the one kept. */
export type CallRecord = Partial<CallOutcome> & { agentId: string; conversationId?: ConversationId; cli?: CliWorker; sessionId?: string; isolated?: AgentWorktree };
type WorkflowRuntime = Durable.TaskRuntime<WorkflowInput, { phase: "run" }, null, object>;

const checkedSchemas = new Set<string>();

/** Throws CC's error for a schema that `agent()` refuses before anything starts; each schema compiles once per process. */
export function checkSchema(schema: Durable.JsonObject): void {
	const key = JSON.stringify(schema);
	if (checkedSchemas.has(key)) return;
	try {
		Compile(schema);
	} catch {
		throw new Error("agent({schema}) received an invalid JSON Schema");
	}
	const unusable = (why: string) => new Error(`agent({schema}) received an unusable JSON Schema — ${why}. The subagent was not started — fix the schema and call agent() again.`);
	if (!Value.Check(ObjectRoot, schema)) throw unusable("its root must be {type: 'object', properties: {...}}, with required a list of property names");
	const missing = (schema.required ?? []).filter((key) => !Object.hasOwn(schema.properties, key));
	if (missing.length) throw unusable(`required names ${missing.join(", ")}, which properties lacks`);
	checkedSchemas.add(key);
}

/** One extension per distinct schema, shared by the agents of one `agent()` call site: the tool, and the hook that ends a run. */
function schemaExtension(D: D, session: string, schema: Durable.JsonObject): Durable.Extension {
	const tool = D.defineTool({
		name: STRUCTURED_OUTPUT,
		description: "Return your final answer by calling this tool exactly once; its parameters are the required shape. If a call is rejected, read the error and call it again with a corrected shape. After a successful call, end your turn.",
		// SAFETY: checkSchema compiled this JSON Schema; pi-ai validates calls against raw JSON Schema as it does TypeBox.
		parameters: schema as TSchema,
		replay: "safe",
		// SAFETY: pi-ai validated `args` against an object schema, so they are a JSON object.
		execute: async (args) => ({ content: [{ type: "text", text: "Structured output provided successfully" }], details: args as Durable.JsonObject, control: { terminate: true } }),
	});
	// `terminate` ends a run only when every call of the batch asks for it; a valid call batched with other tools, or the
	// cap's last failed call, ends it here: the request waits until the abort reaches this generation, so it is never sent.
	const end = D.hook(D.GenerationTask, {
		beforeRequest: async ({ messages }, api, context) => {
			const calls = structuredCalls(messages);
			const signal = context.abortSignal;
			if (signal && (calls.some((call) => !call.isError) || calls.length >= STRUCTURED_OUTPUT_CAP)) {
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
					abortRun(session, api.conversationId).catch(() => resolve());
				});
			}
			return undefined;
		},
	});
	return D.defineExtension({ name: `pi-kit.schema.${createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16)}`, tools: [tool], hooks: [end] });
}

/** Running workflows need their StructuredOutput again after a reopen or /reload. */
export function installSchemas(D: D, registry: Durable.Registry, session: string, records: Record<string, WorkflowRecord>): void {
	const used = Object.values(records).flatMap((record) => (record.status === "running" ? record.schemas ?? [] : []));
	for (const schema of new Map(used.map((schema) => [JSON.stringify(schema), schema])).values()) registry.install(schemaExtension(D, session, schema));
}

/** Installs a checked schema's StructuredOutput extension once per process. */
export function useSchema(D: D, engine: Engine, schema: Durable.JsonObject): Durable.Extension {
	const extension = schemaExtension(D, engine.session, schema);
	if (!engine.registry.snapshot().extension(extension.name)) engine.registry.install(extension);
	return extension;
}

async function abortRun(session: string, conversationId: ConversationId): Promise<void> {
	const engine = await host.engines.get(session);
	await (await engine?.harness.conversation(conversationId, CTX))?.abort(CTX);
}

const structuredCalls = (messages: readonly Message[]) => messages.flatMap((message) => (message.role === "toolResult" && message.toolName === STRUCTURED_OUTPUT ? [message] : []));

/** `output` is the first valid call's object, as pi-ai validated it; `failed` holds each rejected call's error text. */
function structuredResult(transcript: readonly Durable.EntryRecord[]) {
	const calls = structuredCalls(transcript.flatMap((entry) => entry.model ?? []));
	const failed = calls.filter((call) => call.isError).map((call) => call.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"));
	return { output: calls.find((call) => !call.isError)?.details, failed };
}

/** CC's errors that make `agent()` throw: the failed-call cap, or no call even after the nudge. */
function structuredFailure(result: { failed: string[] }, settled: Durable.SettledSubmissionRecord | undefined): string | undefined {
	if (result.failed.length >= STRUCTURED_OUTPUT_CAP) return `agent({schema}): StructuredOutput retry cap (${STRUCTURED_OUTPUT_CAP}) exceeded — ${result.failed.length} failed calls with no valid output — last StructuredOutput error: ${result.failed.at(-1)!.slice(0, 600)}`;
	if (settled?.status === "done") return "agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)";
	return undefined;
}

export const workflowRecords = (doc: WorkflowsDoc | undefined) => decoded<Record<string, WorkflowRecord>>(doc?.workflows) ?? {};
const callRecord = (doc: Readonly<Durable.JsonObject> | undefined) => (doc?.conversationId === undefined && doc?.cli === undefined ? undefined : decoded<CallRecord>(doc));

export async function launchWorkflow(engine: Engine, input: WorkflowInput, description: string): Promise<void> {
	const { kit, root } = engine;
	const record: WorkflowRecord = { runId: input.runId, description, startedAt: input.startedAt, status: "running" };
	await root.commit(async (tx) => {
		record.durableTaskId = await tx.createTask(kit.Workflow, input, BACKGROUND);
		(await tx.doc(kit.Workflows, root.id)).workflows[input.taskId] = json(record);
	}, CTX);
	registerWorkflow(engine, input.taskId, record);
}

/** Live progress of a session's workflow runs since this Pi started. */
export function workflowProgress(session: string): Progress[] {
	return [...host.workflows.values()].filter((progress) => progress.session === session);
}

export function registerWorkflow(engine: Engine, id: string, record: WorkflowRecord): void {
	const stopRun = async () => {
		if (record.durableTaskId !== undefined) await engine.harness.abortTask(record.durableTaskId, CTX);
	};
	tasks.register({ id, kind: "workflow", name: record.runId, description: record.description, status: record.status, ownerSession: engine.session, startedAt: record.startedAt, stop: stopRun });
}

function trackProgress(input: WorkflowInput): Progress {
	const progress = host.workflows.get(input.taskId) ?? newProgress({ taskId: input.taskId, runId: input.runId, session: input.session, meta: parseWorkflow(input.source).meta, startedAt: input.startedAt });
	host.workflows.set(input.taskId, progress);
	return progress;
}

/** A finished run stays on /agents until 20 newer runs have finished. */
function pruneProgress(): void {
	const finished = [...host.workflows].filter(([, progress]) => progress.status !== "running");
	for (const [id] of finished.slice(0, -20)) host.workflows.delete(id);
}

type WorkflowDocs = Pick<Kit, "Outbox" | "Workflows" | "Calls" | "tools">;

export async function runWorkflowTask(D: D, docs: WorkflowDocs, input: WorkflowInput, runtime: WorkflowRuntime, context: Ctx): Promise<void> {
	const engine = (await host.engines.get(input.session))!;
	const workflow = parseWorkflow(input.source);
	const progress = trackProgress(input);
	let result: JsonValue | undefined;
	let error: string | undefined;
	try {
		result = await driveWorkflow(workflow, input.args, input.dir, callRunner(D, docs, engine, input, runtime, context), progress, runtime.signal);
	} catch (thrown) {
		if (runtime.signal.aborted) throw thrown;
		error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
	}
	const status = error === undefined ? "completed" : "failed";
	progress.status = status;
	pruneProgress();
	const durationMs = Date.now() - input.startedAt;
	const outputFile = join(input.dir, `${input.runId}.json`);
	await writeFile(outputFile, runRecord({ progress, script: input.source, scriptPath: input.scriptPath, args: input.args, result, error, defaultModel: input.lead && `${input.lead.provider}/${input.lead.id}`, durationMs })).catch(() => {});
	const n: TaskNotification = {
		notificationId: `${input.taskId}:${String(runtime.taskId)}`,
		taskId: input.taskId,
		kind: "workflow",
		ownerSession: input.session,
		toolUseId: input.toolUseId,
		outputFile,
		status,
		summary: workflowSummary(workflow.meta.description, status, error),
		...(status === "completed"
			? { result: JSON.stringify(result ?? null), diagnostics: workflowDiagnostics(input.dir, input.scriptPath, input.runId) }
			: { recovery: workflowRecovery(input.dir, input.scriptPath, input.runId) }),
		failures: progress.failures.length ? progress.failures.join("\n").slice(0, 40_000) : undefined,
		usage: usage(progress, durationMs),
	};
	await runtime.commit(async (tx) => {
		post(await tx.doc(docs.Outbox, runtime.conversationId), n);
		const record = workflowRecords(await tx.doc(docs.Workflows, runtime.conversationId))[input.taskId];
		if (record) record.status = status;
		return { status: "terminal", outcome: { status: "completed", result: null } };
	}, context);
	tasks.update(input.taskId, { status });
	await tasks.notify(n);
}

/** TaskStop: the owned agents are aborted first; the run record says `killed`, and no notification follows, as in CC. */
export async function abortWorkflowTask(docs: WorkflowDocs, input: WorkflowInput, runtime: WorkflowRuntime, context: Ctx): Promise<void> {
	const progress = trackProgress(input);
	progress.status = "killed";
	pruneProgress();
	await writeFile(join(input.dir, `${input.runId}.json`), runRecord({ progress, script: input.source, scriptPath: input.scriptPath, args: input.args, result: undefined, durationMs: Date.now() - input.startedAt })).catch(() => {});
	await runtime.commit(async (tx) => {
		const record = workflowRecords(await tx.doc(docs.Workflows, runtime.conversationId))[input.taskId];
		if (record) record.status = "killed";
		return { status: "terminal", outcome: { status: "aborted" } };
	}, context);
	tasks.update(input.taskId, { status: "killed" });
}

/**
 * agent() over durable: a slot of the global throttle, then a conversation the run owns, answered once even across a Pi exit.
 * A `claude:` or `codex:` model runs as that CLI instead; its session id is kept on the call, so a rerun after a crash resumes it.
 */
function callRunner(D: D, docs: WorkflowDocs, engine: Engine, input: WorkflowInput, runtime: WorkflowRuntime, context: Ctx): AgentRunner {
	const instructions = new Map<string, string>();
	const member = (key: string) => `${input.taskId}:${key}`;
	const read = async (key: string) => callRecord(await runtime.snapshot(docs.Calls, runtime.conversationId, member(key), context));
	const save = (key: string, agentId: string, fields: CallRecord | CallOutcome) => runtime.commit(async (tx) => {
		Object.assign(await tx.doc(docs.Calls, runtime.conversationId, member(key), agentId), json(fields));
		return undefined;
	}, context);
	let creating = Promise.resolve();
	// The run's pi-kit.json and Codex catalog are read once, at its first agent() call.
	let models: Promise<ModelContext> | undefined;
	const create = async (key: string, options: AgentOptions): Promise<CallRecord> => {
		const type = workflowAgentType(options.agentType);
		const resolved = resolveModel(options.model ?? type.model, await (models ??= workflowModels(input)), LEVELS.find((level) => level === options.effort) ?? type.effort);
		const agentId = newAgentId();
		const at = await placeAgent(type, resolved, resolve(input.cwd, options.cwd ?? "."), agentId, options.isolation);
		const { worktree, cwd } = at;
		if (resolved.harness !== "pi") {
			const call: CallRecord = { agentId, isolated: worktree, cli: cliWorker(engine, type, resolved, at, agentId, options.schema) };
			await save(key, agentId, call);
			return call;
		}
		const structured = options.schema && useSchema(D, engine, options.schema);
		const prompt = `${type.name}\0${cwd}`;
		// Context files and skills are read once per type and directory, not once per agent.
		if (!instructions.has(prompt)) instructions.set(prompt, workerPrompt(type, cwd, worktree));
		let call: CallRecord | undefined;
		await runtime.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
			await D.configure(tx, conversation.id, {
				model: { provider: resolved.model.provider, modelId: resolved.model.id },
				thinkingLevel: resolved.level,
				extensions: structured ? [engine.kit.extension, structured] : [engine.kit.extension],
				tools: [...type.tools.map((name) => docs.tools[name]), ...(structured?.tools ?? [])],
				instructions: instructions.get(prompt),
				cwd,
			});
			const record = workflowRecords(await tx.doc(docs.Workflows, runtime.conversationId))[input.taskId];
			if (record && options.schema && !record.schemas?.some((schema) => JSON.stringify(schema) === JSON.stringify(options.schema))) record.schemas = [...record.schemas ?? [], options.schema];
			call = { agentId, conversationId: conversation.id, isolated: worktree };
			Object.assign(await tx.doc(docs.Calls, runtime.conversationId, member(key), agentId), json(call));
			return undefined;
		}, context);
		return call!;
	};
	const askPi = async (key: string, call: CallRecord, prompt: string, schema: AgentOptions["schema"]): Promise<{ outcome: CallOutcome; log: string }> => {
		const structured = schema && useSchema(D, engine, schema);
		const conversation = (await engine.harness.conversation(call.conversationId!, context))!;
		const ask = async (content: string, requestId: string) => (await conversation.submit({ type: "input", content, requestId }, context)).wait(context);
		const first = await ask(prompt, `workflow:${key}`);
		const settled = structured && first.status === "done" && !structuredResult(await scan(conversation, context)).output ? await ask(NUDGE, `workflow:${key}:nudge`) : first;
		const transcript = await scan(conversation, context);
		const so = structured ? structuredResult(transcript) : undefined;
		const structuredError = so && !so.output ? structuredFailure(so, settled) : undefined;
		const answer = text(transcript.filter((entry) => entry.kind === "pi.assistant").at(-1)?.model?.[0]);
		const outcome: CallOutcome = {
			agentId: call.agentId,
			status: (so ? so.output : settled.status === "done") ? "done" : "failed",
			// SAFETY: pi-ai validated the call's arguments as JSON; only the readonly marker differs.
			result: so ? (so.output as JsonValue | undefined) ?? null : settled.status === "done" ? answer : null,
			tokens: totalTokens(await runtime.snapshot(D.UsageDoc, call.conversationId!, context)),
			toolUses: transcript.filter((entry) => entry.kind === "pi.tool-result").length,
		};
		if (outcome.status === "failed") outcome.error = structuredError ?? failure(settled);
		if (structuredError) outcome.structuredError = structuredError;
		return { outcome, log: `${transcriptLog(transcript)}\n\n${answer}\n` };
	};
	const askCli = async (key: string, call: CallRecord, prompt: string): Promise<{ outcome: CallOutcome; log: string }> => {
		const worker = call.cli!;
		const progress = newCliProgress();
		const run = call.sessionId ? { resume: call.sessionId, prompt: CONTINUE } : { prompt };
		const exit = await spawnWorker({ agentId: call.agentId, worker }, engine.dir, run, progress, runtime.signal, host.workers, (sessionId) => save(key, call.agentId, { agentId: call.agentId, sessionId }));
		const answer = await cliAnswer(worker, exit, progress);
		const outcome: CallOutcome = { agentId: call.agentId, status: answer.ok ? "done" : "failed", result: answer.ok ? (worker.schema ? answer.structured ?? null : answer.text) : null, tokens: progress.tokens, toolUses: progress.toolUses };
		if (!answer.ok) outcome.error = answer.error;
		if (worker.schema && !answer.ok && exit.code === 0 && progress.error === undefined) outcome.structuredError = "agent({schema}): subagent completed without calling StructuredOutput";
		return { outcome, log: `${progress.log.join("\n")}\n\n${answer.text}\n` };
	};
	return {
		async stored(key) {
			const call = await read(key);
			if (!call) return undefined;
			if (!call.status) return "live";
			return { agentId: call.agentId, status: call.status, result: call.result ?? null, error: call.error, structuredError: call.structuredError, tokens: call.tokens ?? 0, toolUses: call.toolUses ?? 0, worktree: call.worktree };
		},
		async run(key, prompt, options, start) {
			if (options.schema) checkSchema(options.schema);
			const held = await acquire(key);
			try {
				if (!held || runtime.signal.aborted) throw new Error("Workflow aborted");
				// One agent starts per event-loop pass: sixteen starting at once would stall the lead.
				const mine = creating.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
				creating = mine;
				await mine;
				const call = await read(key) ?? await create(key, options);
				start(call.agentId);
				const framed = framePrompt(input.request, prompt);
				const { outcome, log } = call.cli ? await askCli(key, call, framed) : await askPi(key, call, framed, options.schema);
				if (runtime.signal.aborted) throw new Error("Workflow aborted");
				const kept = call.isolated && existsSync(call.isolated.path) ? await finishAgentWorktree(call.isolated).catch(() => call.isolated) : undefined;
				if (kept) outcome.worktree = { path: kept.path, branch: kept.branch };
				await writeFile(join(input.dir, `agent-${call.agentId}.md`), log).catch(() => {});
				await save(key, call.agentId, outcome);
				return outcome;
			} finally {
				if (held) release();
			}
		},
	};
}

async function workflowModels(input: WorkflowInput): Promise<ModelContext> {
	const registry = host.models!;
	const model = input.lead && registry.find(input.lead.provider, input.lead.id);
	return modelContext({ cwd: input.cwd, isProjectTrusted: () => input.trusted === true, modelRegistry: registry }, model && input.lead ? { model, level: input.lead.level } : undefined);
}
