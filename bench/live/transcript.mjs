import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const CODEX_SESSIONS = join(homedir(), ".codex", "sessions");
const WAKE_PREFIX = "Mail from ";
const PI_MAIL_ENTRY = "deevs.hosted-runtime.messaging-mail.v1";

/**
 * Where a collaborator's own transcript lives, from what Herdr reports for it.
 * Claude: a per-cwd project directory whose name is the cwd with every /, . and _ turned into -, plus <sessionId>.jsonl.
 * Codex: the rollout file under ~/.codex/sessions/<y>/<m>/<d>/ whose name ends with the thread id Herdr reports.
 * Pi: agent_session.value is already the session file path.
 */
export function transcriptPath(driver, agentSession, cwd) {
	if (driver === "pi") return agentSession;
	if (driver === "claude-code") {
		return join(CLAUDE_PROJECTS, cwd.replaceAll(/[/._]/g, "-"), `${agentSession}.jsonl`);
	}
	if (!existsSync(CODEX_SESSIONS)) return undefined;
	const suffix = `-${agentSession}.jsonl`;
	const match = readdirSync(CODEX_SESSIONS, { recursive: true })
		.find(entry => String(entry).endsWith(suffix) && String(entry).includes("rollout-"));
	return match ? join(CODEX_SESSIONS, String(match)) : undefined;
}

/**
 * Herdr often never learns a native agent's session id, so fall back to the newest transcript the
 * driver wrote for that cwd after the collaborator launched.
 */
export function discoverTranscript(driver, cwd, since, exclude = []) {
	if (driver === "claude-code") {
		const directory = join(CLAUDE_PROJECTS, cwd.replaceAll(/[/._]/g, "-"));
		if (!existsSync(directory)) return undefined;
		const candidates = readdirSync(directory)
			.filter(name => name.endsWith(".jsonl"))
			.map(name => join(directory, name))
			.filter(path => statSync(path).mtimeMs >= since && !exclude.includes(path));
		return newest(candidates);
	}
	if (driver !== "codex" || !existsSync(CODEX_SESSIONS)) return undefined;
	const rollouts = readdirSync(CODEX_SESSIONS, { recursive: true })
		.filter(entry => String(entry).endsWith(".jsonl") && String(entry).includes("rollout-"))
		.map(entry => join(CODEX_SESSIONS, String(entry)))
		.filter(path => statSync(path).mtimeMs >= since && !exclude.includes(path) && sessionCwd(path) === cwd);
	return newest(rollouts);
}

function newest(paths) {
	return paths.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function sessionCwd(path) {
	try { return JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]).payload?.cwd; } catch { return undefined; }
}

/** One transcript as timestamped entries: assistant turns with usage, tool calls, and the daemon's wake prompts. */
export function loadTranscript(driver, path) {
	if (!path || !existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	const rows = [];
	for (const line of lines) {
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (driver === "claude-code") claudeEntry(entry, rows);
		else if (driver === "codex") codexEntry(entry, rows);
		else piEntry(entry, rows);
	}
	return dedupeUsage(rows);
}

function claudeEntry(entry, rows) {
	const at = Date.parse(entry.timestamp ?? "");
	if (!Number.isFinite(at)) return;
	if (entry.type === "user" && typeof entry.message?.content === "string" && entry.message.content.startsWith(WAKE_PREFIX)) {
		rows.push({ at, kind: "wake", text: entry.message.content });
		return;
	}
	if (entry.type !== "assistant") return;
	const usage = entry.message?.usage ?? {};
	const tools = (entry.message?.content ?? []).filter(block => block?.type === "tool_use").map(block => block.name);
	rows.push({
		at,
		kind: "assistant",
		id: entry.message?.id,
		model: entry.message?.model,
		input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
		output: usage.output_tokens ?? 0,
		tools,
	});
}

function codexEntry(entry, rows) {
	const at = Date.parse(entry.timestamp ?? "");
	if (!Number.isFinite(at)) return;
	if (entry.type === "turn_context") {
		rows.push({ at, kind: "model", model: entry.payload?.model });
		return;
	}
	if (entry.type === "token_usage_record") {
		const usage = entry.payload?.usage ?? {};
		rows.push({ at, kind: "assistant", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, tools: [] });
		return;
	}
	if (entry.type !== "response_item") return;
	const payload = entry.payload ?? {};
	if (payload.type === "message" && payload.role === "user") {
		const text = (payload.content ?? []).map(part => part?.text ?? "").join(" ");
		if (text.trimStart().startsWith(WAKE_PREFIX)) rows.push({ at, kind: "wake", text });
		return;
	}
	// This Codex routes MCP through its exec tool, so the called mail tools are named inside the call body.
	if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
		const body = `${payload.name ?? ""} ${payload.arguments ?? payload.input ?? ""}`;
		const named = [...body.matchAll(/collaborator_(peers|inbox|send|reply)/g)].map(hit => `collaborator_${hit[1]}`);
		rows.push({ at, kind: "assistant", input: 0, output: 0, tools: named.length ? [...new Set(named)] : [payload.name ?? "tool"] });
	}
}

function piEntry(entry, rows) {
	const at = Date.parse(entry.timestamp ?? "");
	if (!Number.isFinite(at)) return;
	if (entry.customType === PI_MAIL_ENTRY) {
		rows.push({ at, kind: "wake", text: PI_MAIL_ENTRY });
		return;
	}
	if (entry.type !== "message" || entry.message?.role !== "assistant") return;
	const usage = entry.message.usage ?? {};
	rows.push({
		at,
		kind: "assistant",
		id: entry.id,
		model: entry.message.model,
		input: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
		output: usage.output ?? 0,
		tools: (entry.message.content ?? []).filter(block => block?.type === "toolCall").map(block => block.name),
	});
}

/** Claude writes one entry per content block of the same message, all carrying that message's whole usage. */
function dedupeUsage(rows) {
	const counted = new Set();
	return rows.map((row) => {
		if (row.kind !== "assistant" || !row.id) return row;
		if (counted.has(row.id)) return { ...row, input: 0, output: 0 };
		counted.add(row.id);
		return row;
	});
}

export function within(rows, from, to) {
	return rows.filter(row => row.at >= from && row.at <= to);
}

export function countWakes(rows, from, to) {
	return within(rows, from, to).filter(row => row.kind === "wake").length;
}

export function transcriptModel(rows) {
	return rows.find(row => row.model)?.model;
}
