// The orchestration tasks. Each runs on a history-free export of this public repo at a pinned commit, gets the
// same prompt under every config, and is judged structurally: the result JSON's shape and fields against ground
// truth the harness computes from the checkout, the hidden test's exit code, git state. Model prose is never read.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PIN = "4080d62";
export const RESULT = ".bench/result.json";

const SUFFIX = `

Rules for this run: no human is available, so never ask questions; decide yourself and finish. Do the work through subagents as the task says (your Agent or Workflow tools; I opt in to Workflow), and wait for every subagent you started before writing the result. Write the final result as one JSON document matching the schema to ${RESULT} (create the directory) with your file-writing tool, then reply DONE.`;

const tsFiles = (dir) => readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".ts"));
const isInt = (n) => Number.isInteger(n) && n >= 0;
const isStr = (s) => typeof s === "string" && s.length > 0;

const MODULES = ["arxiv", "ask-user", "chains", "codex-fast", "cron", "herdr-compat", "jobs", "notifier", "runtime", "shared", "subagents", "todos", "wiki"];

function summarize(repo, out) {
	const rows = Array.isArray(out?.modules) ? out.modules : [];
	const valid = rows.filter((r) => isStr(r.module) && isStr(r.purpose) && isInt(r.ts_files) && Array.isArray(r.tools) && r.tools.every(isStr));
	const byName = new Map(valid.map((r) => [r.module.replace(/^extensions\//, "").replace(/\/$/, ""), r]));
	const present = MODULES.filter((m) => byName.has(m));
	const exact = present.filter((m) => byName.get(m).ts_files === tsFiles(join(repo, "extensions", m)).length);
	const ok = present.length === MODULES.length && valid.length === rows.length;
	return { success: ok, expected: MODULES.length, present: present.length, valid: valid.length, rows: rows.length, ts_files_exact: exact.length };
}

const t2Prompt = `Summarize each of the ${MODULES.length} extension modules of this repository, one directory each under extensions/ (${MODULES.join(", ")}). Use one subagent per module, all launched in parallel; each reads only its own module.

Result schema: {"modules": [{"module": "<directory name>", "purpose": "<one sentence>", "ts_files": <integer: number of .ts files under extensions/<module>, recursively>, "tools": ["<name of every LLM tool the module registers with registerTool>"]}]} with exactly one entry per module.`;

const COLLABORATOR_FIXED = "/^[A-Za-z0-9][A-Za-z0-9._/*:[\\]-]{0,199}$/";
const COLLABORATOR_BUG = "/^[A-Za-z0-9][A-Za-z0-9._/*:-]{0,199}$/";

const HIDDEN_TEST = `import { describe, expect, it } from "vitest";
import { COLLABORATOR_MODEL } from "../extensions/runtime/schemas/common.ts";
describe("bench hidden: collaborator model syntax", () => {
	it("accepts bracketed context suffixes", () => {
		for (const m of ["fable[1m]", "opus[1m]", "claude:opus[1m]", "sonnet[200k]"]) expect(COLLABORATOR_MODEL.test(m), m).toBe(true);
	});
	it("keeps every other rule", () => {
		for (const m of ["opus", "openai-codex/gpt-5.5-sol", "anthropic/claude-*", "a".repeat(200)]) expect(COLLABORATOR_MODEL.test(m), m).toBe(true);
		for (const m of ["", "-opus", "[1m]", "op us", "a".repeat(201), "opus\\n"]) expect(COLLABORATOR_MODEL.test(m), JSON.stringify(m)).toBe(false);
	});
});
`;

const sh = (repo, cmd, args, timeout = 300_000) => {
	try { return { status: 0, out: execFileSync(cmd, args, { cwd: repo, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) }; }
	catch (e) { return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-4000) }; }
};

export const TASKS = {
	t1: {
		title: "multi-agent review finds a historical bug",
		// e020683 fixed it: messaging.inbox marked a 50-message page read before the response cap could drop it.
		commit: "e020683^",
		timeoutMin: 30,
		prompt: `Run a multi-agent code review of extensions/runtime/service/ (the service layer of the Runtime daemon, TypeScript). Split the directory into at least 3 slices, each reviewed by its own reviewer subagent in parallel, then have a separate subagent verify each candidate finding before you keep it. Report only correctness bugs (lost or corrupted data, wrong results, crashes, broken invariants), not style.

Result schema: {"findings": [{"file": "<repo-relative path>", "line": <integer>, "severity": "high" | "medium" | "low", "title": "<one line>"}]} with at most 10 findings, most severe first; an empty list if nothing survives verification.`,
		// The bug spans two sites: inbox() marks the page read (the fix's hunk), callMessaging() then swaps the oversized response for an error.
		sites: [
			{ file: "extensions/runtime/service/messaging.ts", from: 185, to: 225 },
			{ file: "extensions/runtime/service/protocol.ts", from: 112, to: 132 },
		],
		offlineCheck: true,
		check(repo, out) {
			const rows = Array.isArray(out?.findings) ? out.findings : [];
			const valid = rows.filter((r) => isStr(r.file) && Number.isInteger(r.line) && ["high", "medium", "low"].includes(r.severity) && isStr(r.title));
			const at = (r, s) => r.file.replace(/^\.\//, "") === s.file;
			const hit = valid.find((r) => TASKS.t1.sites.some((s) => at(r, s) && r.line >= s.from && r.line <= s.to));
			return {
				success: Boolean(hit) && valid.length === rows.length, findings: rows.length, valid: valid.length,
				fix_file_hit: valid.some((r) => at(r, TASKS.t1.sites[0])), hit_file: hit?.file ?? null, hit_severity: hit?.severity ?? null, hit_rank: hit ? valid.indexOf(hit) + 1 : null,
			};
		},
	},
	t2: { title: "parallel fan-out summary of 13 modules", commit: PIN, timeoutMin: 25, prompt: t2Prompt, check: summarize },
	t3: {
		title: "implement-and-review loop, test-backed",
		commit: PIN,
		timeoutMin: 35,
		node_modules: true,
		setup(repo) {
			const file = join(repo, "extensions/runtime/schemas/common.ts");
			const src = readFileSync(file, "utf8");
			if (!src.includes(COLLABORATOR_FIXED)) throw new Error("t3 setup: the fixed regex moved; update tasks.mjs");
			writeFileSync(file, src.replace(COLLABORATOR_FIXED, COLLABORATOR_BUG));
		},
		prompt: `Collaborator model names with a bracketed context-size suffix, such as fable[1m], opus[1m] or claude:opus[1m], are rejected by the Runtime's schemas (extensions/runtime/). Make them valid while every other rule of the model-name syntax stays as it is, and add a test for it. Work as an implement-and-review loop: one subagent implements the change, then a separate reviewer subagent reviews the diff; if the reviewer requests changes, an implementer addresses them and a reviewer reviews again, at most 3 review rounds. Before finishing, run the relevant tests with npx vitest run <files>.

Result schema: {"review_rounds": <integer: reviews performed>, "approved": <boolean: the last review approved>, "files_changed": ["<repo-relative path>"]}`,
		check(repo, out) {
			writeFileSync(join(repo, "test/bench-hidden.test.ts"), HIDDEN_TEST);
			const hidden = sh(repo, "npx", ["vitest", "run", "test/bench-hidden.test.ts"]);
			const changed = sh(repo, "git", ["status", "--porcelain"]).out.split("\n").map((l) => l.slice(3)).filter((f) => f.startsWith("test/") && f !== "test/bench-hidden.test.ts" && f.endsWith(".ts"));
			const suites = changed.length ? sh(repo, "npx", ["vitest", "run", ...changed]) : { status: null };
			const rounds = out?.review_rounds;
			const shaped = isInt(rounds) && typeof out?.approved === "boolean" && Array.isArray(out?.files_changed);
			return { success: hidden.status === 0 && suites.status !== 1 && shaped && out.approved && rounds >= 1 && rounds <= 3, hidden_test: hidden.status === 0, test_files_changed: changed.length, changed_tests_pass: suites.status === null ? null : suites.status === 0, review_rounds: rounds ?? null, approved: out?.approved ?? null, hidden_log: hidden.status === 0 ? undefined : hidden.out.slice(-1500) };
		},
	},
	t4: {
		title: "44-agent fan-out over test files",
		commit: PIN,
		timeoutMin: 40,
		prompt: null, // built from the checkout
		files: (repo) => readdirSync(join(repo, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`),
		check(repo, out) {
			const files = TASKS.t4.files(repo);
			const rows = Array.isArray(out?.files) ? out.files : [];
			const valid = rows.filter((r) => isStr(r.file) && isInt(r.tests) && isStr(r.subject));
			const byFile = new Map(valid.map((r) => [r.file.replace(/^\.\//, ""), r]));
			const present = files.filter((f) => byFile.has(f));
			const truth = (f) => (readFileSync(join(repo, f), "utf8").match(/^\s*(?:it|test)(?:\.(?:only|skip|todo|concurrent))?\(/gm) ?? []).length;
			const exact = present.filter((f) => byFile.get(f).tests === truth(f));
			return { success: present.length === files.length && valid.length === rows.length, expected: files.length, present: present.length, valid: valid.length, rows: rows.length, tests_exact: exact.length };
		},
	},
	t5: { title: "fan-out summary survives a lead restart", commit: PIN, timeoutMin: 30, prompt: t2Prompt, check: summarize, restart: { afterFirstAgentMs: 12_000 } },
};

export function promptFor(id, repo) {
	const task = TASKS[id];
	if (id !== "t4") return task.prompt + SUFFIX;
	const files = task.files(repo);
	return `For each of the ${files.length} test files below, launch one subagent (exactly ${files.length} subagents, as many in parallel as your tools allow) that reads only that file and reports how many test cases it declares (calls to it() or test(), including .skip/.only/.todo variants) and which repo-relative source module it mainly tests.

${files.join("\n")}

Result schema: {"files": [{"file": "<path as listed>", "tests": <integer>, "subject": "<repo-relative path of the main module under test>"}]} with exactly one entry per listed file.${SUFFIX}`;
}

export const RESUME_PROMPT = "The harness running you was killed and restarted in the middle of this task. Resume the same task from where it stopped, reusing finished work where your tools allow, and complete it exactly as originally specified.";
