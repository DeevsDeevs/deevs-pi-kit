import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "./manager.ts";
import type {
	ClearProcessInput,
	ListProcessInput,
	LogsProcessInput,
	ReadProcessInput,
	SignalProcessInput,
	StartProcessInput,
	WriteProcessInput,
} from "./types.ts";

const WatchSchema = Type.Object({
	pattern: Type.String({ description: "Text or regex pattern to watch for" }),
	mode: Type.Optional(StringEnum(["substring", "regex"] as const)),
	stream: Type.Optional(StringEnum(["stdout", "stderr", "both"] as const)),
	repeat: Type.Optional(Type.Boolean()),
	triggerTurn: Type.Optional(Type.Boolean()),
});

const StartSchema = Type.Object({
	name: Type.String({ description: "Short human-readable process name" }),
	command: Type.Optional(Type.String({ description: "Shell command to run via bash -lc" })),
	argv: Type.Optional(Type.Array(Type.String(), { description: "Direct argv form; argv[0] is executable" })),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current project" })),
	waitMs: Type.Optional(Type.Number({ description: "Initial wait for output/exit, capped by config" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum output bytes to return" })),
	backend: Type.Optional(StringEnum(["pipe", "pty", "tmux"] as const)),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment overlay" })),
	persistent: Type.Optional(Type.Boolean()),
	alertOnExit: Type.Optional(Type.Boolean()),
	alertOnFailure: Type.Optional(Type.Boolean()),
	alertOnReady: Type.Optional(Type.Boolean()),
	watches: Type.Optional(Type.Array(WatchSchema)),
});

const ReadSchema = Type.Object({
	id: Type.String({ description: "Process ID" }),
	afterSeq: Type.Optional(Type.Number({ description: "Read output chunks after this sequence" })),
	waitMs: Type.Optional(Type.Number({ description: "Long-poll wait for new output" })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum output bytes to return" })),
	stream: Type.Optional(StringEnum(["stdout", "stderr", "combined"] as const)),
});

const WriteSchema = Type.Object({
	id: Type.String({ description: "Process ID" }),
	input: Type.String({ description: "Bytes/text to write; include newline if needed" }),
	end: Type.Optional(Type.Boolean({ description: "Close stdin after writing" })),
});

const SignalSchema = Type.Object({
	id: Type.String({ description: "Process ID" }),
	signal: StringEnum(["SIGINT", "SIGTERM", "SIGKILL"] as const),
	tree: Type.Optional(Type.Boolean({ description: "Signal the whole process group; default true" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wait for terminal state after signal" })),
});

const ListSchema = Type.Object({
	includeExited: Type.Optional(Type.Boolean()),
	includePersistent: Type.Optional(Type.Boolean()),
});

const LogsSchema = Type.Object({
	id: Type.String({ description: "Process ID" }),
	stream: Type.Optional(StringEnum(["stdout", "stderr", "combined"] as const)),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum log tail bytes to return" })),
});

const ClearSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Terminal process ID to clear" })),
	allExited: Type.Optional(Type.Boolean({ description: "Clear all terminal process records" })),
	deleteLogs: Type.Optional(Type.Boolean({ description: "Delete log files for cleared records" })),
});

export function registerProcessTools(pi: ExtensionAPI, manager: ProcessManager): void {
	pi.registerTool({
		name: "proc_start",
		label: "Start Process",
		description: "Start a managed background process. Use this instead of shell backgrounding with &/nohup/disown.",
		promptSnippet: "Start a managed background process and return its id plus initial output.",
		promptGuidelines: [
			"Use proc_start for long-running commands, dev servers, watches, and commands the agent needs to inspect later.",
			"Do not use bash backgrounding with &, nohup, disown, or setsid; use proc_start instead.",
		],
		parameters: StartSchema,
		async execute(_toolCallId, params: StartProcessInput, signal, _onUpdate, ctx) {
			const result = await manager.start(params, ctx, signal);
			return {
				content: [{ type: "text", text: formatStartResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "proc_read",
		label: "Read Process",
		description: "Read buffered output from a managed process by cursor/sequence number.",
		promptSnippet: "Read new output from a managed background process by process id and afterSeq cursor.",
		promptGuidelines: ["Use proc_read with afterSeq to inspect incremental background process output without re-reading old logs."],
		parameters: ReadSchema,
		async execute(_toolCallId, params: ReadProcessInput, signal) {
			const result = await manager.readWait(params, signal);
			return {
				content: [{ type: "text", text: formatReadResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "proc_list",
		label: "List Processes",
		description: "List managed background processes.",
		promptSnippet: "List managed background processes and their status.",
		promptGuidelines: ["Use proc_list when you need to find process IDs or check whether background work is still running."],
		parameters: ListSchema,
		async execute(_toolCallId, params: ListProcessInput) {
			const processes = manager.list(params);
			return {
				content: [{ type: "text", text: processes.length ? processes.map((p) => `${p.id} [${p.status}] ${p.name}`).join("\n") : "No managed processes." }],
				details: { processes },
			};
		},
	});

	pi.registerTool({
		name: "proc_write",
		label: "Write Process",
		description: "Write text to a managed process stdin.",
		promptSnippet: "Write input to a managed background process stdin.",
		promptGuidelines: ["Use proc_write to answer prompts or send commands to a running managed process; include newline when needed."],
		parameters: WriteSchema,
		async execute(_toolCallId, params: WriteProcessInput) {
			const process = manager.write(params);
			return {
				content: [{ type: "text", text: `Wrote to ${process.id}. stdinOpen=${process.stdinOpen}` }],
				details: { process },
			};
		},
	});

	pi.registerTool({
		name: "proc_signal",
		label: "Signal Process",
		description: "Send SIGINT, SIGTERM, or SIGKILL to a managed process, usually to its process group.",
		promptSnippet: "Stop or interrupt a managed background process by process id.",
		promptGuidelines: ["Use proc_signal instead of shell kill when stopping a process created by proc_start."],
		parameters: SignalSchema,
		async execute(_toolCallId, params: SignalProcessInput) {
			const process = await manager.signal(params);
			return {
				content: [{ type: "text", text: `${process.id} is ${process.status}` }],
				details: { process },
			};
		},
	});

	pi.registerTool({
		name: "proc_logs",
		label: "Process Logs",
		description: "Return bounded disk log file paths and sizes for a managed process.",
		promptSnippet: "Get log file paths for a managed background process.",
		promptGuidelines: ["Use proc_logs when buffered proc_read output is insufficient and disk logging is available."],
		parameters: LogsSchema,
		async execute(_toolCallId, params: LogsProcessInput) {
			const logs = await manager.logs(params);
			return {
				content: [{ type: "text", text: logs ? formatLogs(logs) : "No logs for this process." }],
				details: { logs },
			};
		},
	});

	pi.registerTool({
		name: "proc_clear",
		label: "Clear Process",
		description: "Clear terminal managed process records. Running processes are never cleared.",
		promptSnippet: "Clear exited managed process records.",
		promptGuidelines: ["Use proc_clear only for exited/signaled/failed process records; stop running processes with proc_signal first."],
		parameters: ClearSchema,
		async execute(_toolCallId, params: ClearProcessInput) {
			const result = await manager.clear(params);
			return {
				content: [{ type: "text", text: `Cleared ${result.cleared.length} process record(s).` }],
				details: result,
			};
		},
	});
}

function formatLogs(logs: Awaited<NonNullable<ReturnType<ProcessManager["logs"]>>>): string {
	const header = [
		`stream:   ${logs.stream}`,
		`combined: ${logs.logFile}`,
		`stdout:   ${logs.stdoutLogFile}`,
		`stderr:   ${logs.stderrLogFile}`,
		`bytes:    ${logs.bytesWritten}/${logs.maxBytes}${logs.truncated ? " truncated" : ""}`,
		`tail:     ${logs.contentBytes} bytes${logs.truncatedFromStart ? " (truncated from start)" : ""}`,
	].join("\n");
	return logs.content ? `${header}\n\n${logs.content}` : `${header}\n\n(no log output)`;
}

function formatStartResult(result: Awaited<ReturnType<ProcessManager["start"]>>): string {
	return [`Started ${result.process.id} [${result.process.status}] ${result.process.name}`, formatReadResult(result.output)].join("\n");
}

function formatReadResult(result: Awaited<ReturnType<ProcessManager["readWait"]>>): string {
	const header = `${result.id} [${result.status}] nextSeq=${result.nextSeq} earliestSeq=${result.earliestSeq}`;
	const warning = result.droppedBeforeSeq !== null ? `\n[older output dropped before seq ${result.droppedBeforeSeq}]` : "";
	const body = result.chunks.map((chunk) => chunk.text).join("");
	const suffix = result.truncated ? "\n[read truncated by maxBytes]" : "";
	return body.length > 0 ? `${header}${warning}\n${body}${suffix}` : `${header}${warning}\n(no buffered output)`;
}
