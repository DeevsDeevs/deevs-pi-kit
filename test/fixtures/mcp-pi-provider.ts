import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Deterministic model only. Pi's Agent loop, tool wrappers, persistence, MCP child
// and Runtime socket/store remain real; no credentials or network model are used.
export default function proofProvider(pi: ExtensionAPI): void {
	pi.registerCommand("proof-enable-legacy", { description: "Test-only collision fixture", handler: async () => { pi.registerCommand("runtime", { description: "Test-only legacy command", handler: async () => {} }); } });
	pi.registerProvider("mcp-proof", {
		api: "mcp-proof", baseUrl: "http://unused.invalid", apiKey: "test-only",
		models: [{ id: "proof", name: "Proof", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1)!;
			const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
			if (last.role === "user") {
				const text = typeof last.content === "string" ? last.content : last.content.filter(block => block.type === "text").map(block => block.text).join("");
				const call = JSON.parse(text) as { name: string; arguments: Record<string, string> };
				output.content = [{ type: "toolCall", id: randomUUID(), ...call }];
				output.stopReason = "toolUse";
			} else {
				const skill = readFileSync(new URL("../../skills/collaborator-messaging/SKILL.md", import.meta.url), "utf8");
				output.content = [{ type: "text", text: JSON.stringify({ tools: context.tools?.map(tool => tool.name), sharedSkill: context.systemPrompt?.includes(skill) }) }];
			}
			stream.push({ type: "start", partial: output });
			const block = output.content[0]!;
			if (block.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: output });
			} else if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: output });
			}
			stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
			stream.end();
			return stream;
		},
	});
}
