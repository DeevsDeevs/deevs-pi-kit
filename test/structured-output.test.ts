import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkSchema, closeAll, ensureEngine, launchWorkflow } from "../extensions/subagents/engine/index.ts";

const compiles = vi.hoisted(() => ({ count: 0 }));
vi.mock("typebox/compile", async (importOriginal) => {
	const original = await importOriginal<typeof import("typebox/compile")>();
	return { ...original, Compile: (...args: Parameters<typeof original.Compile>) => { compiles.count++; return original.Compile(...args); } };
});

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-so-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-kit-so-cwd-"));
const faux = createFauxCore({ provider: "faux", models: [{ id: "m" }] });
// SAFETY: the engine reads only these members of the context.
const ctx = {
	cwd,
	modelRegistry: { find: (_provider: string, id: string) => faux.getModel(id), getAvailable: () => [faux.getModel("m")], streamSimple: faux.streamSimple },
	sessionManager: { getSessionId: () => "s", getEntries: () => [] },
} as unknown as ExtensionContext;
const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
const call = (args: Parameters<typeof fauxToolCall>[1], id = "c") => fauxAssistantMessage(fauxToolCall("StructuredOutput", args, { id }), { stopReason: "toolUse" });
const NUDGE = "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.";

let runs = 0;
/** One workflow run whose single agent() call has the schema; resolves with its run record. */
async function run(responses: FauxResponseStep[]): Promise<{ status: string; result: unknown; error?: string }> {
	faux.setResponses(responses);
	const dir = mkdtempSync(join(tmpdir(), "pi-kit-so-run-"));
	const runId = `wf_so${++runs}xyz`;
	const source = `export const meta = { name: "so", description: "d" };\nreturn await agent("p", { schema: ${JSON.stringify(schema)} });`;
	await launchWorkflow(await ensureEngine(ctx), { taskId: `w${runs}`, runId, session: "s", toolUseId: "t", source, scriptPath: join(dir, "so.js"), cwd, dir, lead: { provider: "faux", id: "m", level: "off" }, startedAt: Date.now() }, "d");
	const record = join(dir, `${runId}.json`);
	return vi.waitFor(() => JSON.parse(readFileSync(record, "utf8")), { timeout: 10_000 });
}

afterAll(() => closeAll());

describe("StructuredOutput in a workflow agent()", () => {
	it("refuses a schema agent() cannot use before anything starts", async () => {
		expect(() => checkSchema(schema)).not.toThrow();
		expect(() => checkSchema({ type: "array", items: {} })).toThrow(/^agent\(\{schema\}\) received an unusable JSON Schema — .*The subagent was not started/);
		expect(() => checkSchema({ type: "object", properties: {}, required: ["n"] })).toThrow(/unusable JSON Schema — required names n,/);
		expect(() => checkSchema({ type: "object", properties: { s: { type: "string", pattern: "(" } } })).toThrow("agent({schema}) received an invalid JSON Schema");
	});

	it("compiles each schema once per process", () => {
		const fresh = { type: "object", properties: { once: { type: "string" } } };
		const before = compiles.count;
		checkSchema(fresh);
		checkSchema(structuredClone(fresh));
		expect(compiles.count - before).toBe(1);
	});

	it("ends the run at the first valid call and returns its validated object", async () => {
		const n = await run([call({ n: "x" }, "bad"), call({ n: "7" }), fauxAssistantMessage("never asked")]);
		expect([n.status, n.result]).toEqual(["completed", { n: 7 }]);
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("ends the run after the batch a valid call shares with other tools", async () => {
		const batch = fauxAssistantMessage([fauxToolCall("read", { path: cwd }, { id: "r" }), fauxToolCall("StructuredOutput", { n: 1 }, { id: "c" })], { stopReason: "toolUse" });
		let asked = false;
		const n = await run([batch, (_context, options) => {
			asked = !options?.signal?.aborted;
			return fauxAssistantMessage("never asked");
		}]);
		expect([n.status, n.result]).toEqual(["completed", { n: 1 }]);
		expect(asked).toBe(false);
	});

	it("nudges once, then throws CC's error when the agent still answers in text", async () => {
		let nudged = "";
		const n = await run([fauxAssistantMessage("plain"), (context) => {
			const last = context.messages.at(-1);
			nudged = last?.role === "user" && typeof last.content === "string" ? last.content : "";
			return fauxAssistantMessage("still plain");
		}]);
		expect(nudged).toBe(NUDGE);
		expect([n.status, n.error]).toEqual(["failed", "Error: agent({schema}): subagent completed without calling StructuredOutput (after in-conversation nudge)"]);
	});

	it("takes a call made after the nudge", async () => {
		const n = await run([fauxAssistantMessage("plain"), call({ n: 3 })]);
		expect([n.status, n.result]).toEqual(["completed", { n: 3 }]);
	});

	it("stops at the fifth failed call with CC's cap error", async () => {
		const n = await run([...[1, 2, 3, 4, 5].map((i) => call({ n: "x" }, `bad${i}`)), call({ n: 1 }, "late")]);
		expect(n.status).toBe("failed");
		expect(n.error).toMatch(/^Error: agent\(\{schema\}\): StructuredOutput retry cap \(5\) exceeded — 5 failed calls with no valid output — last StructuredOutput error: /);
	});
});

describe("a workflow agent()'s model names", () => {
	it("come from the project's pi-kit.json only when Pi trusted the project at launch", async () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ models: { fx: "faux/m" } }));
		const launch = async (trusted: boolean) => {
			faux.setResponses([fauxAssistantMessage("hi")]);
			const dir = mkdtempSync(join(tmpdir(), "pi-kit-so-run-"));
			const runId = `wf_trust${++runs}xyz`;
			const source = `export const meta = { name: "t", description: "d" };\nreturn await agent("p", { model: "fx" });`;
			await launchWorkflow(await ensureEngine(ctx), { taskId: `w${runs}`, runId, session: "s", toolUseId: "t", source, scriptPath: join(dir, "t.js"), cwd, trusted, dir, startedAt: Date.now() }, "d");
			const record = join(dir, `${runId}.json`);
			return (await vi.waitFor(() => JSON.parse(readFileSync(record, "utf8")), { timeout: 10_000 })).status;
		};
		expect([await launch(true), await launch(false)]).toEqual(["completed", "failed"]);
	});
});
