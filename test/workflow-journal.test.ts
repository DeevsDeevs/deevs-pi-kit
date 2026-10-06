import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../extensions/subagents/workflow/meta.ts";
import { runWorkflow, type JsonValue, type WorkflowHost } from "../extensions/subagents/workflow/sandbox.ts";
import { canon, chainKey, CrashKeys, JournalReplay, parseJournal, type JournalRecord } from "../extensions/subagents/workflow/journal.ts";

const META = 'export const meta = { name: "t", description: "test" };\n';

describe("workflow journal", () => {
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");

	it("canonicalises keyed options like CC plus cwd", () => {
		expect(canon(undefined)).toBe("{}");
		expect(canon({ label: "x", phase: "p", effort: undefined })).toBe("{}");
		expect(canon({ label: "x", model: "m", cwd: "/r", schema: { b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 } } })).toBe('{"cwd":"/r","model":"m","schema":{"a":{"c":2,"d":[{"y":2,"z":1}]},"b":1}}');
	});

	it("chains v2 keys over prompt and options", () => {
		const first = chainKey("", "p", {});
		expect(first).toBe(`v2:${sha("\0p\0{}")}`);
		expect(chainKey(first, "q", { model: "m" })).toBe(`v2:${sha(`${first}\0q\0{"model":"m"}`)}`);
		expect(chainKey("", "p", { label: "relabelled", phase: "moved" })).toBe(first);
	});

	function journalOf(steps: Array<{ prompt: string; outcome: "result" | "failed" | "started" }>): JournalRecord[] {
		let previous = "";
		return [{ type: "launched" }, ...steps.flatMap(({ prompt, outcome }, index): JournalRecord[] => {
			const key = chainKey(previous, prompt, {});
			previous = key;
			const agentId = `a${index}`;
			const started: JournalRecord = { type: "started", key, agentId };
			if (outcome === "started") return [started];
			return [started, outcome === "result" ? { type: "result", key, agentId, result: `r:${prompt}` } : { type: "failed", key, agentId }];
		})];
	}

	const replayed = (records: JournalRecord[], prompts: string[]) => {
		const replay = new JournalReplay(records);
		return prompts.map((prompt) => (replay.next(prompt, {}).cached ? "cached" : "live"));
	};

	it("replays the longest unchanged prefix", () => {
		const done = journalOf(["p1", "p2", "p3"].map((prompt) => ({ prompt, outcome: "result" as const })));
		expect(replayed(done, ["p1", "p2", "p3"])).toEqual(["cached", "cached", "cached"]);
		expect(replayed(done, ["p1", "edited", "p3"])).toEqual(["cached", "live", "live"]);
		expect(replayed(done, ["p1", "p2", "p3", "p4"])).toEqual(["cached", "cached", "cached", "live"]);
	});

	it("ends the prefix at a failed call but not at one killed in flight", () => {
		const failed = journalOf([{ prompt: "p1", outcome: "result" }, { prompt: "p2", outcome: "failed" }, { prompt: "p3", outcome: "result" }]);
		expect(replayed(failed, ["p1", "p2", "p3"])).toEqual(["cached", "live", "live"]);
		const killed = journalOf([{ prompt: "p1", outcome: "result" }, { prompt: "p2", outcome: "started" }, { prompt: "p3", outcome: "result" }]);
		expect(replayed(killed, ["p1", "p2", "p3"])).toEqual(["cached", "live", "cached"]);
	});

	it("hands out cached results as copies", () => {
		const records: JournalRecord[] = [{ type: "result", key: chainKey("", "p", {}), agentId: "a1", result: { list: [1] } }];
		const first = new JournalReplay(records).next("p", {});
		if (first.cached && first.result !== null && typeof first.result === "object" && !Array.isArray(first.result)) first.result.list = [];
		expect(new JournalReplay(records).next("p", {})).toMatchObject({ cached: true, result: { list: [1] } });
	});

	it("parses journal lines and skips torn or unknown ones", () => {
		const text = [
			'{"type":"launched"}',
			'{"type":"started","key":"k","agentId":"a1","label":"x"}',
			'{"type":"result","key":"k","agentId":"a1","result":"done"}',
			'{"type":"failed","key":"k2"}',
			'{"type":"restoring"}',
			"not json",
			'{"type":"result","key":"k3","agentId":"a3","res',
		].join("\n");
		expect(parseJournal(text)).toEqual([
			{ type: "launched" },
			{ type: "started", key: "k", agentId: "a1" },
			{ type: "result", key: "k", agentId: "a1", result: "done" },
		]);
	});

	it("keys the crash map by prompt and options plus occurrence", () => {
		const keys = new CrashKeys();
		const base = sha("p\0{}");
		expect([keys.next("p", { label: "one" }), keys.next("p", { label: "two" }), keys.next("q", {}), keys.next("p", { model: "m" })]).toEqual([
			`${base}#0`,
			`${base}#1`,
			`${sha("q\0{}")}#0`,
			`${sha('p\0{"model":"m"}')}#0`,
		]);
	});

	it("composes with the sandbox so an edited script re-runs only from the edit", async () => {
		const records: JournalRecord[] = [{ type: "launched" }];
		const journaled = (live: string[]): WorkflowHost => {
			const replay = new JournalReplay(records);
			return {
				emit: () => {},
				agent: async (prompt, options) => {
					const step = replay.next(prompt, options);
					if (step.cached) return step.result;
					live.push(prompt);
					const agentId = `a${records.length}`;
					records.push({ type: "started", key: step.key, agentId, label: options.label });
					const result: JsonValue = `r:${prompt}`;
					records.push({ type: "result", key: step.key, agentId, result });
					return result;
				},
			};
		};
		const script = (second: string) => parseWorkflow(`${META}const [a, b] = await parallel([() => agent('one'), () => agent('${second}')]);\nreturn [a, b, await agent('three ' + b)];`);
		const firstRun: string[] = [];
		expect(await runWorkflow(script("two"), journaled(firstRun))).toEqual(["r:one", "r:two", "r:three r:two"]);
		const sameRun: string[] = [];
		expect(await runWorkflow(script("two"), journaled(sameRun))).toEqual(["r:one", "r:two", "r:three r:two"]);
		const editedRun: string[] = [];
		expect(await runWorkflow(script("TWO"), journaled(editedRun))).toEqual(["r:one", "r:TWO", "r:three r:TWO"]);
		expect([firstRun, sameRun, editedRun]).toEqual([["one", "two", "three r:two"], [], ["TWO", "three r:TWO"]]);
	});
});
