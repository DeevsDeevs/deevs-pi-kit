import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newAgentId } from "../extensions/shared/tasks.ts";
import { closeAll, ensureEngine, launch, send } from "../extensions/subagents/engine/index.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-send-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-kit-send-cwd-"));
const faux = createFauxCore({ provider: "faux", models: [{ id: "m" }] });
// SAFETY: the engine reads only these members of the context.
const ctx = {
	cwd,
	modelRegistry: { find: (_provider: string, id: string) => faux.getModel(id), streamSimple: faux.streamSimple },
	sessionManager: { getSessionId: () => "s" },
} as unknown as ExtensionContext;

afterAll(closeAll);

describe("SendMessage to an agent", () => {
	it("steers a message sent before the prompt is placed in right after it, and reports once", async () => {
		const asked: string[] = [];
		const answer = (text: string): FauxResponseStep => (context) => {
			asked.push(context.messages.flatMap((message) => (message.role === "user" && typeof message.content === "string" ? [message.content] : [])).join("|"));
			return fauxAssistantMessage(text);
		};
		faux.setResponses([answer("first"), answer("second")]);
		const engine = await ensureEngine(ctx);
		const agentId = newAgentId();
		const { done } = await launch(engine, { agentId, description: "d", prompt: "task", model: faux.getModel(), tools: ["read"], instructions: "", cwd, writer: false, toolUseId: "t", limits: {}, foreground: true });
		expect(await send(engine, agentId, "steer", "t2")).toBe("steered");
		const report = await done!;
		expect([report.status, report.result]).toEqual(["completed", "second"]);
		expect(asked.at(-1)).toContain("steer");
	});
});
