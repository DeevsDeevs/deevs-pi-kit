interface CompactStats {
	lines: number;
	jsonEvents: number;
	parseFailures: number;
	skippedVerboseEvents: number;
}

interface CompactState extends CompactStats {
	entries: string[];
	seenToolStarts: Set<string>;
	seenToolEnds: Set<string>;
	latestAssistantText: string;
}

const MAX_ENTRIES = 40;
const MAX_ENTRY_CHARS = 360;

export function compactAgentProcessLog(content: string, maxBytes: number): string {
	const state: CompactState = {
		lines: 0,
		jsonEvents: 0,
		parseFailures: 0,
		skippedVerboseEvents: 0,
		entries: [],
		seenToolStarts: new Set(),
		seenToolEnds: new Set(),
		latestAssistantText: "",
	};

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		state.lines++;
		const jsonText = extractJsonText(line);
		if (!jsonText) {
			state.parseFailures++;
			pushEntry(state, `raw: ${oneLine(line)}`);
			continue;
		}
		try {
			const event = JSON.parse(jsonText) as Record<string, unknown>;
			state.jsonEvents++;
			compactEvent(event, state);
		} catch {
			state.parseFailures++;
			pushEntry(state, `raw: ${oneLine(line)}`);
		}
	}

	const lines = [
		"[compact subagent process log]",
		"Verbose JSON stream, token deltas, tool deltas, and model reasoning were omitted.",
		"Use agent_logs with raw:true only when you need the full backing-process log.",
		`Read ${state.lines} line(s), parsed ${state.jsonEvents} JSON event(s), skipped ${state.skippedVerboseEvents} verbose event(s), ${state.parseFailures} raw/unparsed line(s).`,
	];
	if (state.latestAssistantText) lines.push("", `Latest assistant text: ${clip(oneLine(state.latestAssistantText), MAX_ENTRY_CHARS)}`);
	lines.push("", "Recent activity:");
	if (state.entries.length) lines.push(...state.entries.map((entry) => `- ${entry}`));
	else lines.push("- No compactable activity found.");
	return truncateBytes(lines.join("\n"), maxBytes);
}

function compactEvent(event: Record<string, unknown>, state: CompactState): void {
	const type = String(event.type ?? "");
	if (type === "session") {
		const cwd = typeof event.cwd === "string" ? ` cwd=${event.cwd}` : "";
		pushEntry(state, `session started${cwd}`);
		return;
	}
	if (type === "agent_start") {
		pushEntry(state, "agent started");
		return;
	}
	if (type === "turn_start") {
		pushEntry(state, "turn started");
		return;
	}
	if (type === "turn_end") {
		pushEntry(state, "turn ended");
		return;
	}
	if (type === "tool_execution_start") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : `${state.jsonEvents}`;
		if (state.seenToolStarts.has(id)) return;
		state.seenToolStarts.add(id);
		pushEntry(state, `tool start: ${toolSummary(event)}`);
		return;
	}
	if (type === "tool_execution_end") {
		const id = typeof event.toolCallId === "string" ? event.toolCallId : `${state.jsonEvents}`;
		if (state.seenToolEnds.has(id)) return;
		state.seenToolEnds.add(id);
		pushEntry(state, `tool end: ${toolSummary(event)}${resultSummary(event)}`);
		return;
	}
	if (type === "message_end") {
		const message = asRecord(event.message);
		const role = typeof message?.role === "string" ? message.role : "";
		if (role === "assistant") {
			const text = textContent(message);
			if (text) {
				state.latestAssistantText = text;
				pushEntry(state, `assistant: ${clip(oneLine(text), MAX_ENTRY_CHARS)}`);
			} else {
				state.skippedVerboseEvents++;
			}
			return;
		}
		if (role === "toolResult") {
			state.skippedVerboseEvents++;
			return;
		}
		state.skippedVerboseEvents++;
		return;
	}
	if (type === "message_update") {
		const update = asRecord(event.assistantMessageEvent);
		const updateType = typeof update?.type === "string" ? update.type : "";
		if (updateType === "toolcall_end") {
			const toolCall = asRecord(update.toolCall);
			const id = typeof toolCall?.id === "string" ? toolCall.id : `${state.jsonEvents}`;
			if (!state.seenToolStarts.has(id)) {
				state.seenToolStarts.add(id);
				pushEntry(state, `tool call: ${toolCallSummary(toolCall)}`);
			}
			return;
		}
		const partial = asRecord(update?.partial);
		const text = partial ? textContent(partial) : "";
		if (text) state.latestAssistantText = text;
		state.skippedVerboseEvents++;
		return;
	}
	if (type === "error") {
		pushEntry(state, `error: ${clip(JSON.stringify(event), MAX_ENTRY_CHARS)}`);
		return;
	}
	state.skippedVerboseEvents++;
}

function extractJsonText(line: string): string | null {
	if (line.startsWith("{")) return line;
	const marker = "] ";
	const index = line.indexOf(marker);
	if (index >= 0) {
		const rest = line.slice(index + marker.length).trim();
		if (rest.startsWith("{")) return rest;
	}
	return null;
}

function toolSummary(event: Record<string, unknown>): string {
	const name = typeof event.toolName === "string" ? event.toolName : "tool";
	return `${name}${argsSummary(asRecord(event.args))}`;
}

function toolCallSummary(toolCall: Record<string, unknown> | null): string {
	if (!toolCall) return "tool";
	const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
	return `${name}${argsSummary(asRecord(toolCall.arguments))}`;
}

function argsSummary(args: Record<string, unknown> | null): string {
	if (!args) return "";
	if (typeof args.command === "string") return ` command=${quote(args.command)}`;
	if (typeof args.path === "string") return ` path=${quote(args.path)}`;
	const text = JSON.stringify(args);
	return text && text !== "{}" ? ` args=${clip(text, 180)}` : "";
}

function resultSummary(event: Record<string, unknown>): string {
	const result = asRecord(event.result);
	if (!result) return "";
	const content = Array.isArray(result.content) ? result.content : [];
	const text = content.map((part) => typeof asRecord(part)?.text === "string" ? asRecord(part)!.text : "").filter(Boolean).join("\n");
	return text ? ` -> ${clip(oneLine(text), 220)}` : "";
}

function textContent(message: Record<string, unknown>): string {
	const content = Array.isArray(message.content) ? message.content : [];
	return content.map((part) => {
		const item = asRecord(part);
		if (!item || item.type !== "text") return "";
		return typeof item.text === "string" ? item.text : "";
	}).filter(Boolean).join("\n").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pushEntry(state: CompactState, entry: string): void {
	state.entries.push(clip(entry, MAX_ENTRY_CHARS));
	if (state.entries.length > MAX_ENTRIES) state.entries.shift();
}

function quote(value: string): string {
	return JSON.stringify(clip(oneLine(value), 220));
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let tail = text.slice(-maxBytes);
	while (Buffer.byteLength(tail) > maxBytes) tail = tail.slice(1);
	return `[truncated from start]\n${tail}`;
}
