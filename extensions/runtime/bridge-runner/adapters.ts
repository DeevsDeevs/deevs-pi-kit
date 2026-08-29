import { fileURLToPath } from "node:url";
import { BRIDGE_RUNNER_MAX_BODY_BYTES, type BridgeDriver, type BridgeDriverFrame, type BridgeWorkerSpec } from "./types.ts";
import { BridgeJsonlError, parseClosedJson } from "./jsonl.ts";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));

interface BridgeDriverExecution {
	command: string;
	args: string[];
	stdin: string;
	env: Record<string, string>;
}

interface BridgeDriverAdapter {
	build(spec: BridgeWorkerSpec): BridgeDriverExecution;
	decode(line: string): BridgeDriverFrame | undefined;
}

const fake: BridgeDriverAdapter = {
	build(spec) {
		return { command: process.execPath, args: ["--experimental-strip-types", FAKE_CLI, spec.turnId, spec.sessionId ?? ""], stdin: spec.body, env: { LC_ALL: "C", BRIDGE_FAKE_DRIVER: "1" } };
	},
	decode(line) {
		const item = parseClosedJson(line, ["type", "sessionId", "text", "status", "body", "sessionAdvance"]);
		if (item.type === "session") return { type: "session", sessionId: bounded(item.sessionId, "session ID", 200) };
		if (item.type === "text") return { type: "text", text: boundedString(item.text, "text", BRIDGE_RUNNER_MAX_BODY_BYTES) };
		if (item.type === "terminal") {
			if (item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") throw new BridgeJsonlError("Fake driver terminal status is invalid.");
			if (item.sessionAdvance !== "none" && item.sessionAdvance !== "committed" && item.sessionAdvance !== "uncertain") throw new BridgeJsonlError("Fake driver session advance state is invalid.");
			return { type: "terminal", status: item.status, body: boundedString(item.body, "terminal body", BRIDGE_RUNNER_MAX_BODY_BYTES), sessionAdvance: item.sessionAdvance, ...(item.sessionId === undefined ? {} : { sessionId: bounded(item.sessionId, "session ID", 200) }) };
		}
		throw new BridgeJsonlError("Fake driver frame type is invalid.");
	},
};

const claudeCode: BridgeDriverAdapter = {
	build(spec) {
		if (!spec.profile || !spec.sessionId) throw new BridgeJsonlError("Claude Code requires a profile and session ID.");
		const tools = spec.profile === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write";
		const permissionMode = spec.profile === "read-only" ? "dontAsk" : "acceptEdits";
		const args = ["-p", "--output-format", "stream-json", "--verbose", "--safe-mode", "--permission-mode", permissionMode, "--tools", tools, ...(spec.model ? ["--model", spec.model] : []), ...(!spec.resumeSession && spec.persona ? ["--append-system-prompt", spec.persona.prompt] : []), ...(spec.resumeSession ? ["--resume", spec.sessionId] : ["--session-id", spec.sessionId])];
		return { command: "claude", args, stdin: spec.body, env: bridgeProcessEnvironment() };
	},
	decode(line) {
		const item = jsonObject(line, "Claude Code frame");
		if (item.type === "system" && item.subtype === "init") return { type: "session", sessionId: bounded(item.session_id, "Claude Code session ID", 200) };
		if (item.type !== "result") return undefined;
		const sessionId = bounded(item.session_id, "Claude Code result session ID", 200);
		const completed = item.is_error === false && item.subtype === "success" && item.terminal_reason === "completed";
		const cancelled = item.terminal_reason === "cancelled";
		return { type: "terminal", status: completed ? "completed" : cancelled ? "cancelled" : "failed", body: boundedString(item.result ?? (cancelled ? "Claude Code turn cancelled." : "Claude Code turn failed."), "Claude Code result", BRIDGE_RUNNER_MAX_BODY_BYTES), sessionAdvance: "committed", sessionId };
	},
};

const codex: BridgeDriverAdapter = {
	build(spec) {
		if (!spec.profile) throw new BridgeJsonlError("Codex requires a profile.");
		const shared = ["--json", "--ignore-rules", "--ignore-user-config", "--strict-config", ...(spec.model ? ["--model", spec.model] : []), ...(spec.persona ? ["--config", `developer_instructions=${JSON.stringify(spec.persona.prompt)}`] : [])];
		const args = ["--ask-for-approval", "never", "--sandbox", spec.profile, "exec", ...(spec.resumeSession ? ["resume", bounded(spec.sessionId, "Codex session ID", 200)] : []), ...shared, "-"];
		return { command: "codex", args, stdin: spec.body, env: bridgeProcessEnvironment() };
	},
	decode(line) {
		const item = jsonObject(line, "Codex frame");
		if (item.type === "thread.started") return { type: "session", sessionId: bounded(item.thread_id, "Codex thread ID", 200) };
		if (item.type === "item.completed") {
			const content = record(item.item);
			return content?.type === "agent_message" ? { type: "text", text: boundedString(content.text, "Codex agent message", BRIDGE_RUNNER_MAX_BODY_BYTES) } : undefined;
		}
		if (item.type === "turn.completed") return { type: "terminal", status: "completed", body: "", sessionAdvance: "committed" };
		if (item.type === "turn.failed") return { type: "terminal", status: "failed", body: boundedString(record(item.error)?.message ?? "Codex turn failed.", "Codex error", BRIDGE_RUNNER_MAX_BODY_BYTES), sessionAdvance: "committed" };
		return undefined;
	},
};

const REGISTRY: Record<BridgeDriver, BridgeDriverAdapter> = { fake, "claude-code": claudeCode, codex };

export function bridgeDriver(key: BridgeDriver): BridgeDriverAdapter { return REGISTRY[key]; }

export function bridgeProcessEnvironment(): Record<string, string> {
	const result: Record<string, string> = { LC_ALL: "C", LANG: "C", NO_COLOR: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" };
	for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NIX_SSL_CERT_FILE"] as const) if (process.env[key]) result[key] = process.env[key]!;
	return result;
}

function jsonObject(line: string, name: string): Record<string, unknown> {
	let value: unknown;
	try { value = JSON.parse(line); } catch { throw new BridgeJsonlError(`${name} is not valid JSON.`); }
	const item = record(value);
	if (!item || typeof item.type !== "string") throw new BridgeJsonlError(`${name} is not an object with a type.`);
	return item;
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function bounded(value: unknown, name: string, max: number): string { const result = boundedString(value, name, max); if (!result.trim()) throw new BridgeJsonlError(`${name} is empty.`); return result; }
function boundedString(value: unknown, name: string, max: number): string { if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new BridgeJsonlError(`${name} exceeds ${max} bytes.`); return value; }
