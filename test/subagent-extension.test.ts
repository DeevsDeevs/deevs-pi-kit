import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getEncoding } from "js-tiktoken";
import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";
import { jobLaunchedResult } from "../extensions/shared/tasks.ts";
import subagentsExtension from "../extensions/subagents/index.ts";
import { agentTypesList, findAgentType, WORKING_RULES, workerPrompt } from "../extensions/subagents/definitions.ts";
import { AUTONOMY_REMINDERS } from "../extensions/subagents/workflow-prompt.ts";

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

	it("briefs agents and workflow agents that write code with the task's requirement text word for word", () => {
		let agent = "";
		subagentsExtension({ registerTool(tool: { name: string; description: string }) { if (tool.name === "Agent") agent = tool.description; }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
		const skill = readFileSync(join(import.meta.dirname, "../skills/workflow-authoring/SKILL.md"), "utf8");
		for (const text of [agent, skill]) expect(text).toMatch(/For code (it|an agent) writes, paste the task's requirement text (into its prompt )?word for word; never paraphrase a spec\./);
	});

	it("asks for a job_start timeout on builds and tests, as print mode's job result does, while Agent limits stay on request only", () => {
		const params: Record<string, TObject> = {};
		subagentsExtension({ registerTool(tool: { name: string; parameters: TObject }) { params[tool.name] = tool.parameters; }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
		const timeout = (tool: string) => (params[tool]!.properties.timeout as TSchema & { description: string }).description;
		expect(timeout("job_start")).toMatch(/Set one for builds and tests; in print or json mode Pi waits only for jobs that have one/);
		expect(timeout("job_start")).not.toMatch(/ONLY/);
		expect(jobLaunchedResult("b1", "/out", undefined, true)).toMatch(/waits only for .*jobs started with a timeout/);
		expect(timeout("Agent")).toMatch(/ONLY when the user asks/);
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

	it("leaves the lead's bash timeout to the call, since Pi kills a command at its timeout", () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-kit-bash-"));
		const handlers: Record<string, (event: object, ctx: object) => unknown> = {};
		subagentsExtension({ registerTool() {}, registerCommand() {}, on(name: string, fn: (event: object, ctx: object) => unknown) { handlers[name] = fn; } } as unknown as ExtensionAPI);
		const inputs = [{ command: "make" }, { command: "make", timeout: 3000 }];
		for (const input of inputs) handlers.tool_call!({ toolName: "bash", input }, { cwd: process.env.PI_CODING_AGENT_DIR });
		expect(inputs).toEqual([{ command: "make" }, { command: "make", timeout: 3000 }]);
		expect(handlers.tool_result).toBeUndefined();
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
		expect(names.filter((name) => ["workflow-authoring", "collaborators", "background-tasks", "todos", "ask-user", "chain-system"].includes(name!))).toEqual([]);
	});

	it("gives the Pi lead (as Agent tool guidelines) every working rule and Pi workers the shared ones, each yielding to the user's and the project's instructions, and a Claude or Codex worker none", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kit-verify-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		let agent: { name: string; promptGuidelines?: string[] } | undefined;
		subagentsExtension({ registerTool(tool: NonNullable<typeof agent>) { if (tool.name === "Agent") agent = tool; }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
		expect(agent?.promptGuidelines).toEqual(WORKING_RULES);
		const [precedence, finish, output, scope, tests, timeout, report] = WORKING_RULES;
		expect(precedence).toMatch(/user's and the project's own instructions take precedence/);
		expect(finish).toMatch(/within your turn[\s\S]*to wait for agents, workflows and timed jobs[\s\S]*When the user asked for action, a plan/);
		expect(output).toMatch(/deliverable the task names \(a file or binary at a path, a commit, a branch\) work first, committed when it is a commit, before any review, delegated side work or long run/);
		expect(AUTONOMY_REMINDERS.full).toContain(output);
		expect(scope).toMatch(/Add no new modules, vendored code or dependencies unless the task asks for them/);
		expect(tests).toMatch(/If the project has none, create one outside the project tree, for example under \/tmp \(uv venv or python -m venv\)/);
		expect(report).toMatch(/what changed, how you verified it, and what remains/);
		const worker = workerPrompt(findAgentType("reviewer"), dir);
		for (const rule of [precedence, scope, tests, timeout]) expect(worker.split(rule!)).toHaveLength(2);
		for (const rule of [finish, output, report]) expect(worker).not.toContain(rule);
		expect(workerPrompt(findAgentType(undefined), dir).split(tests!)).toHaveLength(2);
		expect(workerPrompt(findAgentType(undefined), dir, undefined, true)).not.toContain(tests);
		expect(getEncoding("o200k_base").encode(WORKING_RULES.map((rule) => `- ${rule}`).join("\n")).length).toBeLessThanOrEqual(315);
	});
});
