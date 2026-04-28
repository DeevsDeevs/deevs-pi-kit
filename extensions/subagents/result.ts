import type { Message } from "@mariozechner/pi-ai";
import type { ReadResult } from "../processes/types.ts";

export interface ExtractedAgentOutput {
	finalOutput: string;
	warning?: string;
	messages: Message[];
}

export interface LiveAgentOutput {
	visibleOutput: string;
	messages: Message[];
	warning?: string;
}

export function extractFinalOutputFromRead(result: ReadResult): ExtractedAgentOutput {
	const parsed = parseStdoutEvents(result);
	const finalOutput = getFinalOutput(parsed.messages);
	if (finalOutput) return { finalOutput, messages: parsed.messages, warning: parsed.parseFailures > 0 ? `${parsed.parseFailures} non-JSON stdout line(s) ignored.` : undefined };

	if (parsed.latestAssistantText) {
		return {
			finalOutput: parsed.latestAssistantText,
			messages: parsed.messages,
			warning: parsed.parseFailures > 0 ? `${parsed.parseFailures} non-JSON stdout line(s) ignored; using latest assistant text.` : "No final assistant message event found; using latest assistant text.",
		};
	}

	const fallback = result.chunks.map((chunk) => chunk.text).join("").trim();
	return {
		finalOutput: fallback,
		messages: parsed.messages,
		warning: fallback ? "Could not parse final assistant JSON message; using combined output tail." : "No final assistant output found.",
	};
}

export function extractLiveOutputFromRead(result: ReadResult): LiveAgentOutput {
	const parsed = parseStdoutEvents(result);
	const finalOutput = getFinalOutput(parsed.messages);
	if (finalOutput) return { visibleOutput: finalOutput, messages: parsed.messages, warning: parsed.parseFailures > 0 ? `${parsed.parseFailures} non-JSON stdout line(s) ignored.` : undefined };

	const partialText = parsed.latestAssistantText.trim();
	if (partialText) return { visibleOutput: `${partialText}\n\n[partial assistant output]`, messages: parsed.messages };

	const stderr = result.chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("").trim();
	if (stderr) return { visibleOutput: `No final assistant output yet. Recent stderr:\n${stderr}`, messages: parsed.messages };

	return {
		visibleOutput: "No final assistant output yet. Use agent_logs source=combined for compact activity, or raw:true only when debugging the raw JSON stream.",
		messages: parsed.messages,
	};
}

function parseStdoutEvents(result: ReadResult): { messages: Message[]; latestAssistantText: string; parseFailures: number } {
	const raw = result.chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("");
	const messages: Message[] = [];
	let latestAssistantText = "";
	let parseFailures = 0;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { type?: string; message?: Message; assistantMessageEvent?: { partial?: Message } };
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) messages.push(event.message);
			if (event.message?.role === "assistant") latestAssistantText = getTextContent(event.message) || latestAssistantText;
			const partial = event.assistantMessageEvent?.partial;
			if (partial?.role === "assistant") latestAssistantText = getTextContent(partial) || latestAssistantText;
		} catch {
			parseFailures++;
		}
	}

	return { messages, latestAssistantText, parseFailures };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = getTextContent(message);
		if (text) return text;
	}
	return "";
}

function getTextContent(message: Message): string {
	return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}
