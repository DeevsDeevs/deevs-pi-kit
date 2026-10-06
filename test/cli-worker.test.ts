import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliArgv, dropNulls, newProgress, readEvent, strictify, type CliHarness, type CliWorker } from "../extensions/subagents/engine/cli.ts";

// Streams and help texts recorded by the polygon's claude-worker and codex-worker scenarios against the real CLIs.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/cli/${name}`, import.meta.url), "utf8");
const SCHEMA = { type: "object", properties: { verdict: { type: "string", enum: ["ok", "bad"] }, note: { type: "string" } }, required: ["verdict"] };
const worker = (harness: CliHarness, overrides: Partial<CliWorker> = {}): CliWorker => ({ harness, model: "m", cwd: "/repo", instructions: "notes", tools: ["read", "grep", "find", "ls", "bash"], writer: false, dir: "/run", ...overrides });
const read = (harness: CliHarness, stream: string) => {
	const progress = newProgress();
	for (const line of stream.split("\n")) readEvent(harness, progress, line);
	return progress;
};
const flags = (argv: string[]) => argv.filter((arg) => /^--?[a-zA-Z]/.test(arg));

describe("CLI worker argv", () => {
	it("gives Claude bypassed permissions, the guard hook, the type's denied tools, schema and effort", () => {
		const argv = cliArgv(worker("claude", { schema: SCHEMA, level: "xhigh" }));
		expect(argv.slice(0, 4)).toEqual(["-p", "--verbose", "--output-format", "stream-json"]);
		expect(argv).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions", "--permission-prompts", "none", "--model", "m", "--effort", "xhigh", "--json-schema", JSON.stringify(SCHEMA)]));
		expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Edit,NotebookEdit,Write,Agent,Workflow,AskUserQuestion,ScheduleWakeup,CronCreate,SendUserMessage");
		expect(argv[argv.indexOf("--settings") + 1]).toContain("guard-hook.mjs");
		expect(cliArgv(worker("claude"), "sid")).toEqual(expect.arrayContaining(["--resume", "sid"]));
	});

	it("keeps Codex's sandbox on exec resume, which takes no -C, -s or -a", () => {
		const start = cliArgv(worker("codex", { writer: true, level: "max", schema: SCHEMA }));
		expect(start.slice(0, 3)).toEqual(["exec", "-C", "/repo"]);
		expect(start).toEqual(expect.arrayContaining(["-c", "approval_policy=never", "-c", "sandbox_mode=workspace-write", "-c", "model_reasoning_effort=xhigh", "--output-schema", "/run/schema.json", "-o", "/run/last.txt", "--dangerously-bypass-hook-trust"]));
		const resume = cliArgv(worker("codex"), "thread");
		expect(resume.slice(0, 3)).toEqual(["exec", "resume", "thread"]);
		expect(resume).toEqual(expect.arrayContaining(["-c", "sandbox_mode=read-only"]));
		expect(resume.some((arg) => ["-C", "-s", "-a"].includes(arg))).toBe(false);
		expect(resume.at(-1)).toBe("-");
	});

	it("uses only flags the recorded CLI releases document", () => {
		const claude = fixture("claude-help.txt");
		for (const flag of flags(cliArgv(worker("claude", { schema: SCHEMA, level: "high" }), "sid"))) expect(claude, flag).toMatch(new RegExp(`(^|[ ,])${flag}\\b`, "m"));
		const exec = fixture("codex-exec-help.txt");
		for (const flag of flags(cliArgv(worker("codex", { schema: SCHEMA, level: "high" })).slice(1))) expect(exec, flag).toMatch(new RegExp(`(^|[ ,])${flag}\\b`, "m"));
		const resume = fixture("codex-exec-resume-help.txt");
		for (const flag of flags(cliArgv(worker("codex", { schema: SCHEMA }), "thread").slice(3))) expect(resume, flag).toMatch(new RegExp(`(^|[ ,])${flag}\\b`, "m"));
	});
});

describe("strictify", () => {
	it("closes objects, requires every key and makes optional ones nullable, at every depth", () => {
		const nested = { type: "object", properties: { items: { type: "array", items: SCHEMA } }, required: [] };
		expect(strictify(nested)).toEqual({
			type: "object", required: ["items"], additionalProperties: false,
			properties: { items: { anyOf: [{ type: "array", items: { ...SCHEMA, required: ["verdict", "note"], additionalProperties: false, properties: { verdict: SCHEMA.properties.verdict, note: { anyOf: [{ type: "string" }, { type: "null" }] } } } }, { type: "null" }] } },
		});
		expect(dropNulls({ verdict: "ok", note: null, list: [{ a: null, b: 1 }] })).toEqual({ verdict: "ok", list: [{ b: 1 }] });
	});
});

describe("CLI streams", () => {
	it("reads Claude's session, tool uses, tokens and structured_output", () => {
		const first = read("claude", fixture("claude-schema.jsonl"));
		expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(first.toolUses).toBe(2);
		expect(first.tokens).toBeGreaterThan(0);
		expect(first.structured).toEqual({ verdict: "ok" });
		expect(first.error).toBeUndefined();
		const resumed = read("claude", fixture("claude-resume.jsonl"));
		expect(resumed.sessionId).toBe(first.sessionId);
		expect(resumed.text).toBe("[polygon:d2] resumed");
	});

	it("reads Codex's thread, commands and answer, and skips its warning items", () => {
		const progress = read("codex", fixture("codex-schema.jsonl"));
		expect(progress.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(progress.toolUses).toBe(1);
		expect(progress.tokens).toBeGreaterThan(0);
		expect(dropNulls(JSON.parse(progress.text))).toEqual({ verdict: "ok" });
		expect(progress.error).toBeUndefined();
	});

	it("fails a run only on a failed result or turn", () => {
		const claude = newProgress();
		readEvent("claude", claude, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" }));
		expect(claude.error).toBe("error_during_execution");
		const codex = newProgress();
		readEvent("codex", codex, JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }));
		expect(codex.error).toBeUndefined();
		readEvent("codex", codex, JSON.stringify({ type: "turn.failed", error: { message: "quota" } }));
		expect(codex.error).toBe("quota");
		readEvent("codex", codex, "not json");
	});
});
