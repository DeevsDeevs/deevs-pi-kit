import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newWorkflowTaskId, tasks } from "../extensions/shared/tasks.ts";
import { checkSchema, closeAll, ensureEngine, launchWorkflow } from "../extensions/subagents/engine/index.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-so-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-kit-so-cwd-"));
const faux = createFauxCore({ provider: "faux", models: [{ id: "m" }] });
// SAFETY: the engine reads only these members of the context.
const ctx = {
	cwd,
	modelRegistry: { find: (_provider: string, id: string) => faux.getModel(id), streamSimple: faux.streamSimple },
	sessionManager: { getSessionId: () => "s" },
} as unknown as ExtensionContext;
const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
const call = (args: Parameters<typeof fauxToolCall>[1], id = "c") => fauxAssistantMessage(fauxToolCall("StructuredOutput", args, { id }), { stopReason: "toolUse" });
const NUDGE = "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.";

/** One workflow agent() with the schema; returns its object, or the message agent() threw. */
async function run(responses: FauxResponseStep[]) {
	faux.setResponses(responses);
	const dir = mkdtempSync(join(tmpdir(), "pi-kit-so-run-"));
	const taskId = newWorkflowTaskId();
	const source = `export const meta = { name: "so", description: "so" };\nreturn await agent("p", { schema: ${JSON.stringify(schema)} }).catch((error) => error.message);`;
	await launchWorkflow(await ensureEngine(ctx), { taskId, runId: "wf_so", session: "s", toolUseId: "t", source, scriptPath: join(dir, "so.js"), cwd, dir, lead: { provider: "faux", id: "m", level: "off" }, startedAt: Date.now() }, "so");
	await vi.waitFor(() => expect(tasks.find(taskId)?.status).toBe("completed"), { timeout: 10_000 });
	return JSON.parse(readFileSync(join(dir, "wf_so.json"), "utf8")).result;
}

afterAll(closeAll);

describe("StructuredOutput", () => {
	it("refuses a schema agent() cannot use before anything starts", () => {
		expect(() => checkSchema(schema)).not.toThrow();
		expect(() => checkSchema({ type: "array", items: {} })).toThrow(/^agent\(\{schema\}\) received an unusable JSON Schema — .*The subagent was not started/);
		expect(() => checkSchema({ type: "object", properties: {}, required: ["n"] })).toThrow(/unusable JSON Schema — required names n,/);
		expect(() => checkSchema({ type: "object", properties: { s: { type: "string", pattern: "(" } } })).toThrow("agent({schema}) received an invalid JSON Schema");
	});

	it("ends the run at the first valid call and returns its validated object", async () => {
		expect(await run([call({ n: "x" }, "bad"), call({ n: "7" }), fauxAssistantMessage("never asked")])).toEqual({ n: 7 });
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("ends the run after the batch a valid call shares with other tools", async () => {
		const batch = fauxAssistantMessage([fauxToolCall("read", { path: cwd }, { id: "r" }), fauxToolCall("StructuredOutput", { n: 1 }, { id: "c" })], { stopReason: "toolUse" });
		let asked = false;
		expect(await run([batch, (_context, options) => {
			asked = !options?.signal?.aborted;
			return fauxAssistantMessage("never asked");
		}])).toEqual({ n: 1 });
		expect(asked).toBe(false);
	});

	it("nudges once, then throws CC's error when the agent still answers in text", async () => {
		let nudged = "";
		const thrown = await run([fauxAssistantMessage("plain"), (context) => {
			const last = context.messages.at(-1);
			nudged = last?.role === "user" && typeof last.content === "string" ? last.content : "";
			return fauxAssistantMessage("still plain");
		}]);
		expect(nudged).toBe(NUDGE);
		expect(thrown).toBe("agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)");
	});

	it("takes a call made after the nudge", async () => {
		expect(await run([fauxAssistantMessage("plain"), call({ n: 3 })])).toEqual({ n: 3 });
	});

	it("stops at the fifth failed call with CC's cap error", async () => {
		expect(await run([...[1, 2, 3, 4, 5].map((i) => call({ n: "x" }, `bad${i}`)), call({ n: 1 }, "late")])).toMatch(/^agent\(\{schema\}\): StructuredOutput retry cap \(5\) exceeded — 5 failed calls with no valid output — last StructuredOutput error: /);
	});
});
