import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../extensions/subagents/workflow/meta.ts";
import { driveWorkflow, framePrompt, newProgress, usage, type AgentRunner, type CallOutcome } from "../extensions/subagents/workflow/run.ts";

const SCRIPT = parseWorkflow([
	'export const meta = { name: "t", description: "test" };',
	"const [a, b] = await parallel([() => agent('one'), () => agent('two')]);",
	"return [a, b, await agent('three')];",
].join("\n"));

/** A crash map in memory: `run` answers `r:<prompt>`, or fails a prompt listed in `failing`. */
function fakeRunner(failing: string[] = []) {
	const map = new Map<string, CallOutcome | "live">();
	const asked: string[] = [];
	const runner: AgentRunner = {
		stored: async (key) => map.get(key),
		run: async (key, prompt, _options, start) => {
			asked.push(prompt);
			start(`a${asked.length}`);
			const outcome: CallOutcome = failing.includes(prompt)
				? { agentId: `a${asked.length}`, status: "failed", result: null, error: "boom", tokens: 1, toolUses: 0 }
				: { agentId: `a${asked.length}`, status: "done", result: `r:${prompt}`, tokens: 1, toolUses: 2 };
			map.set(key, outcome);
			return outcome;
		},
	};
	return { runner, map, asked };
}

async function drive(dir: string, runner: AgentRunner) {
	const progress = newProgress({ taskId: "w1", runId: "wf_1", session: "s", meta: SCRIPT.meta, startedAt: 0 });
	const result = await driveWorkflow(SCRIPT, undefined, dir, runner, progress, new AbortController().signal);
	return { result, progress, journal: readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

describe("workflow run driver", () => {
	it("journals each call and turns a failed agent into null with a failure line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wf-run-"));
		const { runner } = fakeRunner(["two"]);
		const { result, progress, journal } = await drive(dir, runner);
		expect(result).toEqual(["r:one", null, "r:three"]);
		expect(journal.map((record) => record.type).sort()).toEqual(["failed", "result", "result", "started", "started", "started"]);
		expect(progress.failures).toEqual(["[two] failed: boom"]);
		expect(usage(progress, 5)).toEqual({ agentCount: 3, agentsDone: 2, agentsError: 1, agentsSkipped: 0, agentsEmptyResult: 0, subagentTokens: 3, toolUses: 4, durationMs: 5 });
	});

	it("answers a rerun after a crash from the crash map, failures included, and rejoins a live call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wf-run-"));
		const first = fakeRunner(["two"]);
		await drive(dir, first.runner);
		const third = [...first.map.keys()].at(-1)!;
		first.map.set(third, "live");
		first.asked.length = 0;
		const { result, journal } = await drive(dir, first.runner);
		expect(result).toEqual(["r:one", null, "r:three"]);
		expect(first.asked).toEqual(["three"]);
		expect(journal.filter((record) => record.type === "started")).toHaveLength(3);
	});

	it("replays the journal's unchanged prefix on a resumed run, with no crash map", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wf-run-"));
		await drive(dir, fakeRunner().runner);
		const resumed = fakeRunner();
		const { result, progress } = await drive(dir, resumed.runner);
		expect(result).toEqual(["r:one", "r:two", "r:three"]);
		expect(resumed.asked).toEqual([]);
		expect(progress.agents.map((row) => row.cached)).toEqual([true, true, true]);
	});

	it("frames the snapshotted request before the computed task, every line indented", () => {
		expect(framePrompt("fix it\nplease", "POLYGON {}").split("\n")).toEqual([
			expect.stringMatching(/^\[Workflow harness — user request\] /),
			"  fix it",
			"  please",
			"",
			expect.stringMatching(/^\[Workflow harness — computed task\] /),
			"  POLYGON {}",
		]);
		expect(framePrompt(undefined, "task")).toMatch(/^\[Workflow harness — computed task\] [^\n]*\n {2}task$/);
	});
});
