// Claude Code and Codex workers: their argv, and their JSON event streams read into progress. Imports nothing from Pi,
// so the polygon runs the real CLIs with exactly this argv.
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type CliHarness = "claude" | "codex";
type JsonValue = JsonObject[string];

export interface CliWorker {
	harness: CliHarness;
	model: string;
	/** Claude takes CC's effort as resolved; Codex maps Pi's level onto its own. */
	level?: string;
	cwd: string;
	instructions: string;
	/** Pi tool names the agent type allows; Claude gets the rest as `--disallowedTools`. */
	tools: string[];
	writer: boolean;
	schema?: JsonObject;
	/** Holds Codex's schema file and last message. */
	dir: string;
}

export interface CliProgress {
	sessionId?: string;
	toolUses: number;
	tokens: number;
	/** The last assistant text; the answer once the run ends. */
	text: string;
	structured?: JsonValue;
	/** A run the CLI itself reported as failed. */
	error?: string;
	log: string[];
}

const Text = Type.Optional(Type.String());
const Count = Type.Optional(Type.Number());
const Content = Type.Union([Type.String(), Type.Array(Type.Object({ text: Text }))]);
const ClaudeBlock = Type.Object({ type: Type.String(), text: Text, name: Text, input: Type.Optional(Type.Unknown()), is_error: Type.Optional(Type.Boolean()), content: Type.Optional(Content) });
const ClaudeEvent = Type.Object({
	type: Type.String(),
	subtype: Text,
	session_id: Text,
	message: Type.Optional(Type.Object({ content: Type.Union([Type.String(), Type.Array(ClaudeBlock)]) })),
	result: Text,
	is_error: Type.Optional(Type.Boolean()),
	structured_output: Type.Optional(Type.Unknown()),
	usage: Type.Optional(Type.Object({ input_tokens: Count, output_tokens: Count, cache_read_input_tokens: Count, cache_creation_input_tokens: Count })),
});
const CodexItem = Type.Object({ type: Type.String(), text: Text, command: Text, aggregated_output: Text, exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])), status: Text });
const CodexEvent = Type.Object({
	type: Type.String(),
	thread_id: Text,
	item: Type.Optional(CodexItem),
	usage: Type.Optional(Type.Object({ input_tokens: Count, output_tokens: Count })),
	error: Type.Optional(Type.Object({ message: Type.String() })),
	message: Text,
});
const SchemaObject = Type.Object({ properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())), required: Type.Optional(Type.Array(Type.String())) });
const AnyObject = Type.Object({});

const GUARD_HOOK = `node ${JSON.stringify(fileURLToPath(new URL("../../shared/guard-hook.mjs", import.meta.url)))}`;
const NO_WORKER_TOOLS = ["Agent", "Workflow", "AskUserQuestion", "ScheduleWakeup", "CronCreate", "SendUserMessage"];
const CLAUDE_TOOLS = { read: ["Read"], grep: ["Grep"], find: ["Glob"], ls: [], bash: ["Bash"], edit: ["Edit", "NotebookEdit"], write: ["Write"] };
const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

export const schemaFile = (worker: CliWorker): string => `${worker.dir}/schema.json`;
export const lastMessageFile = (worker: CliWorker): string => `${worker.dir}/last.txt`;

/** The command line of one run; `resume` continues that CLI session instead of starting one. */
export function cliArgv(worker: CliWorker, resume?: string): string[] {
	if (worker.harness === "claude") {
		const disallowed = Object.entries(CLAUDE_TOOLS).filter(([tool]) => !worker.tools.includes(tool)).flatMap(([, names]) => names);
		return [
			"-p", "--verbose", "--output-format", "stream-json",
			...(resume ? ["--resume", resume] : []),
			"--permission-mode", "bypassPermissions", "--permission-prompts", "none",
			"--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: GUARD_HOOK }] }] } }),
			"--append-system-prompt", worker.instructions,
			"--disallowedTools", [...disallowed, ...NO_WORKER_TOOLS].join(","),
			...(worker.schema ? ["--json-schema", JSON.stringify(worker.schema)] : []),
			"--model", worker.model,
			...(worker.level ? ["--effort", worker.level] : []),
		];
	}
	const effort = worker.level === "max" ? "xhigh" : worker.level === "off" ? undefined : worker.level;
	// `exec resume` has no -s, -a or -C: the sandbox goes in through -c and the cwd through the spawn.
	const common = [
		"--json", "-m", worker.model,
		"-c", "approval_policy=never", "-c", `sandbox_mode=${worker.writer ? "workspace-write" : "read-only"}`,
		...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
		"-c", `hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command=${JSON.stringify(GUARD_HOOK)}}]}]`, "--dangerously-bypass-hook-trust",
		"--skip-git-repo-check",
		...(worker.schema ? ["--output-schema", schemaFile(worker)] : []),
		"-o", lastMessageFile(worker),
	];
	if (resume) return ["exec", "resume", resume, ...common, "-"];
	return ["exec", "-C", worker.cwd, "-c", `developer_instructions=${JSON.stringify(worker.instructions)}`, ...common, "-"];
}

/** Codex's `--output-schema` is strict: closed objects whose keys are all required, so an optional key becomes `T | null`. */
export function strictify(schema: JsonValue): JsonValue {
	if (Array.isArray(schema) || !Value.Check(AnyObject, schema)) return schema;
	// SAFETY: AnyObject admits only non-array objects, and a JsonValue object is a JsonObject.
	const out: JsonObject = { ...schema as JsonObject };
	if (out.items !== undefined) out.items = strictify(out.items);
	const objectSchema: Static<typeof SchemaObject> = Value.Check(SchemaObject, out) ? out : {};
	if (!objectSchema.properties) return out;
	const required = new Set(objectSchema.required ?? []);
	// SAFETY: the properties of a JsonObject are JsonValues.
	const properties = Object.entries(objectSchema.properties as JsonObject);
	out.properties = Object.fromEntries(properties.map(([key, value]) => [key, required.has(key) ? strictify(value) : { anyOf: [strictify(value), { type: "null" }] }]));
	out.required = properties.map(([key]) => key);
	out.additionalProperties = false;
	return out;
}

/** Undoes `strictify` on an answer: the nulls that stand for omitted optional keys are dropped. */
export function dropNulls(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(dropNulls);
	if (value === null || !Value.Check(AnyObject, value)) return value;
	// SAFETY: AnyObject admits only non-array objects, and a JsonValue object is a JsonObject.
	return Object.fromEntries(Object.entries(value as JsonObject).flatMap(([key, item]) => (item === null ? [] : [[key, dropNulls(item)]])));
}

export function newProgress(): CliProgress {
	return { toolUses: 0, tokens: 0, text: "", log: [] };
}

/** Folds one line of a worker's JSON stream into `progress`; anything that is not a known event is skipped. */
export function readEvent(harness: CliHarness, progress: CliProgress, line: string): void {
	let event: JsonValue;
	try { event = JSON.parse(line); } catch { return; }
	if (harness === "claude" && Value.Check(ClaudeEvent, event)) readClaude(progress, event);
	if (harness === "codex" && Value.Check(CodexEvent, event)) readCodex(progress, event);
}

function readClaude(progress: CliProgress, event: Static<typeof ClaudeEvent>): void {
	progress.sessionId ??= event.session_id;
	const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
	for (const block of blocks) {
		if (event.type === "assistant" && block.type === "tool_use") {
			progress.toolUses++;
			progress.log.push(`→ ${block.name} ${JSON.stringify(block.input).slice(0, 300)}`);
		}
		if (event.type === "assistant" && block.type === "text" && block.text) {
			progress.text = block.text;
			progress.log.push(block.text);
		}
		if (event.type === "user" && block.type === "tool_result") progress.log.push(`← ${block.is_error ? "error " : ""}${textOf(block.content).slice(0, 300)}`);
	}
	if (event.type !== "result") return;
	if (event.result !== undefined) progress.text = event.result;
	// SAFETY: structured_output comes from JSON.parse.
	const structured = event.structured_output as JsonValue | undefined;
	if (structured !== undefined) progress.structured = structured;
	const usage = event.usage ?? {};
	progress.tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
	if (event.is_error) progress.error = event.result || event.subtype || "error";
}

function readCodex(progress: CliProgress, event: Static<typeof CodexEvent>): void {
	if (event.type === "thread.started") progress.sessionId ??= event.thread_id;
	const { item } = event;
	if (event.type === "item.completed" && item?.type === "agent_message" && item.text !== undefined) {
		progress.text = item.text;
		progress.log.push(item.text);
	}
	if (event.type === "item.completed" && item && CODEX_TOOL_ITEMS.has(item.type)) {
		progress.toolUses++;
		progress.log.push(`→ ${item.type} ${item.command ?? ""}`);
		progress.log.push(`← ${item.status === "failed" || (item.exit_code ?? 0) !== 0 ? "error " : ""}${(item.aggregated_output ?? "").slice(0, 300)}`);
	}
	if (event.type === "turn.completed") progress.tokens += (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0);
	if (event.type === "turn.failed") progress.error = event.error?.message ?? "the turn failed";
	// Codex also streams retry notices as `error` events, so only a failed turn or the exit code fails the run.
	if (event.type === "error" && event.message) progress.log.push(`[error] ${event.message}`);
}

function textOf(content: Static<typeof Content> | undefined): string {
	return Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : content ?? "";
}
