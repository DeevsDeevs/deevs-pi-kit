import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";
import subagentsExtension from "../extensions/subagents/index.ts";
import { agentTypesList, findAgentType, workerPrompt } from "../extensions/subagents/definitions.ts";

describe("Subagent extension surface", () => {
	it("registers Agent, Workflow, TaskStop, job_start, Monitor, SendMessage, ListAgents and /agents", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const pi = {
			registerTool(tool: { name: string }) { tools.push(tool.name); },
			registerCommand(name: string) { commands.push(name); },
			on() {},
		} as unknown as ExtensionAPI;
		subagentsExtension(pi);
		expect(tools).toEqual(["Agent", "Workflow", "TaskStop", "job_start", "Monitor", "SendMessage", "ListAgents"]);
		expect(commands).toEqual(["agents"]);
	});

	it("switches only a new session to the lead model; an unresolved default stays silent, a set lead warns once", async () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-lead-"));
		const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
		const start = async (loggedIn: boolean, assistant: boolean) => {
			const seen: string[] = [];
			let handler: ((event: object, ctx: object) => Promise<void>) | undefined;
			const pi = {
				registerTool() {}, registerCommand() {},
				on(name: string, fn: typeof handler) { if (name === "session_start") handler = fn; },
				setModel: async (model: { id: string }) => { seen.push(`set ${model.id}`); return true; },
			} as unknown as ExtensionAPI;
			subagentsExtension(pi);
			await handler!({ reason: "startup" }, {
				cwd: process.env.PI_CODING_AGENT_DIR,
				isProjectTrusted: () => true,
				modelRegistry: { getAll: () => [sol], getAvailable: () => (loggedIn ? [sol] : []), find: () => sol, isUsingOAuth: () => true },
				sessionManager: { getSessionId: () => "s", getEntries: () => (assistant ? [{ type: "message", message: { role: "assistant" } }] : []) },
				ui: { notify: (_text: string, level: string) => seen.push(level) },
			});
			return seen;
		};
		expect(await start(true, false)).toEqual(["set gpt-6.1-sol"]);
		expect(await start(false, false)).toEqual([]);
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "pi-kit.json"), JSON.stringify({ lead: "sol" }));
		expect(await start(false, false)).toEqual(["warning"]);
		expect(await start(false, false)).toEqual([]);
		expect(await start(true, true)).toEqual([]);
	});

	it("runs a project's saved workflow only when the project is trusted, and takes only a plain name", async () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-saved-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-kit-saved-cwd-"));
		mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "workflows", "mine.js"), "not a workflow");
		let workflow: { parameters: TSchema; execute: (id: string, params: object, signal: undefined, update: undefined, ctx: object) => Promise<unknown> } | undefined;
		subagentsExtension({ registerTool(tool: NonNullable<typeof workflow> & { name: string }) { if (tool.name === "Workflow") workflow = tool; }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
		const run = (trusted: boolean) => workflow!.execute("t", { name: "mine" }, undefined, undefined, { cwd, isProjectTrusted: () => trusted });
		await expect(run(false)).rejects.toThrow("No workflow named 'mine'");
		await expect(run(true)).rejects.toThrow(/meta/);
		const name = (workflow!.parameters as TObject).properties.name!;
		expect(["mine", "a.b-c_1", "../x", "a/b"].map((value) => Value.Check(name, value))).toEqual([true, true, false, false]);
	});

	it("matches agent types forgivingly and lists them on a miss", () => {
		expect(findAgentType(undefined).name).toBe("general-purpose");
		expect(findAgentType("General_Purpose").name).toBe("general-purpose");
		expect(findAgentType("Explore").name).toBe("explorer");
		expect(findAgentType("plan").name).toBe("architect");
		expect(findAgentType("logic hunter").name).toBe("logic-hunter");
		expect(findAgentType("Explore").tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(() => findAgentType("nobody")).toThrow(/^Agent type 'nobody' not found\. Available agents: general-purpose, .*\breviewer\b/);
		expect(agentTypesList()).toMatch(/\n- general-purpose: .* \(read, grep, find, ls, bash, edit, write\)\n- anti-slop: [^(]*\n/);
	});

	it("gives a worker the skill index without the lead's orchestration skills", () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-worker-"));
		const names = [...workerPrompt(findAgentType(undefined), process.env.PI_CODING_AGENT_DIR).matchAll(/<name>(.*)<\/name>/g)].map((m) => m[1]);
		expect(names).toContain("diagnose");
		expect(names.filter((name) => ["workflow-authoring", "collaborators", "background-tasks", "todos", "ask-user", "chain-system", "missions"].includes(name!))).toEqual([]);
	});
});
