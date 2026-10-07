import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_CHARS, parseWorkflow } from "../extensions/subagents/workflow/meta.ts";
import { runWorkflow, type AgentOptions, type WorkflowEvent, type WorkflowHost } from "../extensions/subagents/workflow/sandbox.ts";

const META = 'export const meta = { name: "t", description: "test" };\n';

function mockHost(overrides: Partial<WorkflowHost> = {}) {
	const events: WorkflowEvent[] = [];
	const calls: Array<{ prompt: string; options: AgentOptions }> = [];
	const host: WorkflowHost = {
		agent: async (prompt, options) => {
			calls.push({ prompt, options });
			return `r:${prompt}`;
		},
		emit: (event) => events.push(event),
		...overrides,
	};
	const messages = (type: "log" | "failure") => events.flatMap((event) => (event.type === type ? [event.message] : []));
	return { host, events, calls, messages };
}

async function run(body: string, overrides: Partial<WorkflowHost> = {}) {
	const mock = mockHost(overrides);
	const result = await runWorkflow(parseWorkflow(META + body), mock.host);
	return { result, ...mock };
}

async function failure(body: string, overrides: Partial<WorkflowHost> = {}): Promise<Error> {
	const error = await run(body, overrides).then(() => undefined, (reason: Error) => reason);
	if (!error) throw new Error("expected the workflow to fail");
	return error;
}

function metaError(source: string): string {
	try {
		parseWorkflow(source);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a meta error");
}

describe("workflow meta", () => {
	it("parses a pure literal meta and keeps the body", () => {
		const source = [
			"// leading comment",
			"/* block */ export const meta = {",
			"  name: 'review', // trailing",
			'  "description": `Check \\u0041 and \\x42`,',
			"  whenToUse: 'audits',",
			"  phases: [{ title: 'Scan', detail: 'find', model: 'opus' }, { detail: 'no title' }, 'loose', { title: 'Fix', detail: 3 }],",
			"  weight: -1.5, flags: [true, false, null],",
			"};",
			"",
			"return 1;",
		].join("\n");
		const parsed = parseWorkflow(source);
		expect(parsed.meta).toEqual({
			name: "review",
			description: "Check A and B",
			whenToUse: "audits",
			phases: [{ title: "Scan", detail: "find", model: "opus" }, { title: "Fix" }],
		});
		expect(parsed.body).toBe("return 1;");
		expect(parsed.bodyLine).toBe(10);
	});

	it("rejects scripts with CC's error first lines", () => {
		const meta = (literal: string) => `export const meta = ${literal};\nreturn 1;`;
		expect(metaError("const x = 1;\nexport const meta = { name: 'a', description: 'b' };")).toBe("`export const meta = { name, description, phases }` must be the FIRST statement in the script");
		expect(metaError("return 1;")).toContain("must be the FIRST statement");
		expect(metaError(meta("{ name: NAME, description: 'd' }"))).toBe("meta must be a pure literal: non-literal node type in meta: Identifier");
		expect(metaError(meta("{ name: make(), description: 'd' }"))).toBe("meta must be a pure literal: non-literal node type in meta: CallExpression");
		expect(metaError(meta("{ name: `a${b}`, description: 'd' }"))).toBe("meta must be a pure literal: template interpolation not allowed in meta");
		expect(metaError(meta("{ ...base, description: 'd' }"))).toBe("meta must be a pure literal: only plain properties allowed in meta");
		expect(metaError(meta("{ [key]: 'a', description: 'd' }"))).toBe("meta must be a pure literal: computed keys not allowed in meta");
		expect(metaError(meta("{ name() {}, description: 'd' }"))).toBe("meta must be a pure literal: methods/accessors not allowed in meta");
		expect(metaError(meta("{ get name() { return 'a' } }"))).toBe("meta must be a pure literal: methods/accessors not allowed in meta");
		expect(metaError(meta("{ __proto__: {}, name: 'a' }"))).toBe("meta must be a pure literal: reserved key name not allowed in meta: __proto__");
		expect(metaError(meta("{ name: 'a', description: 'd', phases: [, {}] }"))).toBe("meta must be a pure literal: sparse arrays not allowed");
		expect(metaError(meta("{ name: 'a', description: 'd', phases: [...list] }"))).toBe("meta must be a pure literal: spread not allowed in meta");
		expect(metaError(meta("{ name: 'a' + 'b', description: 'd' }"))).toMatch(/^meta must be a pure literal: /);
		expect(metaError(meta("{ name: !0, description: 'd' }"))).toBe("meta must be a pure literal: only negative-number unary allowed in meta");
		expect(metaError(meta("{ description: 'd' }"))).toBe("meta.name must be a non-empty string");
		expect(metaError(meta("{ name: 'a', description: '' }"))).toBe("meta.description must be a non-empty string");
		expect(metaError(meta("{ name: 'a\n', description: 'd' }"))).toMatch(/^Script parse error: unterminated string in meta\. Workflow scripts must be plain JavaScript/);
		expect(metaError(`${META}${" ".repeat(MAX_SCRIPT_CHARS)}`)).toBe("Script exceeds 524288 bytes");
	});

	it("rejects a body that is not plain JavaScript before anything runs", () => {
		const message = metaError(`${META}const count: number = 1;\nreturn count;`);
		expect(message).toMatch(/^Script parse error: /);
		expect(message).toContain("Workflow scripts must be plain JavaScript");
		expect(metaError(`${META}with (args) {}`)).toMatch(/^Script parse error: /);
	});
});

describe("workflow sandbox", () => {
	it("runs parallel thunks in call order and returns results in slot order", async () => {
		const delays = [30, 20, 10, 0];
		const order: string[] = [];
		const { result } = await run("return await parallel([0, 1, 2, 3].map((i) => () => agent('p' + i)));", {
			agent: async (prompt) => {
				order.push(prompt);
				await new Promise((resolve) => setTimeout(resolve, delays[Number(prompt.slice(1))]));
				return `r:${prompt}`;
			},
		});
		expect(order).toEqual(["p0", "p1", "p2", "p3"]);
		expect(result).toEqual(["r:p0", "r:p1", "r:p2", "r:p3"]);
	});

	it.each([0, 2, 4])("turns a failed parallel slot at position %i into null without rejecting", async (seed) => {
		const { result, messages } = await run("return await parallel([0, 1, 2, 3, 4].map((i) => () => agent('p' + i)));", {
			agent: async (prompt) => {
				if (prompt === `p${seed}`) throw new Error(`boom ${seed}`);
				return prompt;
			},
		});
		expect(result).toEqual(["p0", "p1", "p2", "p3", "p4"].map((prompt, index) => (index === seed ? null : prompt)));
		expect(messages("failure")).toEqual([`parallel[${seed}] failed: boom ${seed}`]);
	});

	it.each([0, 2, 3])("fails the run when the script throws at position %i", async (seed) => {
		const mock = mockHost();
		const parsed = parseWorkflow(`${META}for (let i = 0; i < 4; i++) {\n  if (i === ${seed}) throw new Error('seeded ' + i);\n  await agent('p' + i);\n}`);
		const error = await runWorkflow(parsed, mock.host).then(() => undefined, (reason: Error) => reason);
		expect(error?.message).toBe(`seeded ${seed}`);
		expect(error?.stack).toContain("workflow.js:3");
		expect(mock.calls).toHaveLength(seed);
	});

	it("lets a script catch an agent error and keeps null failures as values", async () => {
		const { result } = await run("let caught; try { await agent('bad') } catch (e) { caught = e.name + ': ' + e.message }\nreturn [caught, await agent('skip')];", {
			agent: async (prompt) => {
				if (prompt === "bad") throw new TypeError("schema rejected");
				return null;
			},
		});
		expect(result).toEqual(["TypeError: schema rejected", null]);
	});

	it("runs pipeline stages per item without a barrier and stops an item on null or throw", async () => {
		let releaseA1 = () => {};
		const a1 = new Promise<void>((resolve) => {
			releaseA1 = resolve;
		});
		const order: string[] = [];
		const { result, messages } = await run(
			"return await pipeline([0, 1, 2, 3], (i) => agent('a' + i), (value, item, index) => agent('b' + index + ':' + item));",
			{
				agent: async (prompt) => {
					order.push(prompt);
					if (prompt === "a1") await a1;
					if (prompt === "b0:0") releaseA1();
					if (prompt === "a2") return null;
					if (prompt === "b3:3") throw new Error("stage broke");
					return prompt;
				},
			},
		);
		expect(result).toEqual(["b0:0", "b1:1", null, null]);
		expect(order).not.toContain("b2:2");
		expect(order.indexOf("b0:0")).toBeLessThan(order.indexOf("b1:1"));
		expect(messages("failure")).toEqual(["pipeline[3] failed: stage broke"]);
	});

	it("rejects misuse of parallel and pipeline with CC's messages", async () => {
		const caught = (expression: string) => `try { await ${expression} } catch (e) { return e.message }`;
		expect((await run(caught("parallel(() => agent('x'))"))).result).toBe("parallel() expects an array of functions");
		expect((await run(caught("parallel([agent('x')])"))).result).toBe("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
		expect((await run(caught("pipeline('x', (v) => v)"))).result).toBe("pipeline() expects an array as the first argument");
		expect((await run(caught("pipeline([1], 'stage')"))).result).toBe("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
		expect((await run("return [await parallel([]), await pipeline([])];")).result).toEqual([[], []]);
	});

	it("passes a schema through and hands the structured result back to the script", async () => {
		const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
		const seen: AgentOptions[] = [];
		const { result } = await run(`const r = await agent('judge', { schema: ${JSON.stringify(schema)} });\nreturn r.verdict + '!';`, {
			agent: async (_prompt, options) => {
				seen.push(options);
				return { verdict: "pass" };
			},
		});
		expect(seen[0]?.schema).toEqual(schema);
		expect(result).toBe("pass!");
	});

	it("fills label and phase, keeps known options and logs ignored ones", async () => {
		const { calls, events, messages } = await run(
			[
				"phase('Scan');",
				"await agent('  look   at\\n the  code  ', { stallMs: 5, model: 'opus', effort: 'high', isolation: 'worktree', agentType: 'explorer', cwd: '/repo', helper: () => 1 });",
				"await agent('b', { label: 'second', phase: 'Other', model: null });",
				"phase('Fix');",
				"await agent('c');",
				"try { await agent('d', { isolation: 'remote' }) } catch (e) { log(e.message) }",
			].join("\n"),
		);
		expect(calls.map((call) => call.options)).toEqual([
			{ label: "look at the code", phase: "Scan", model: "opus", effort: "high", isolation: "worktree", agentType: "explorer", cwd: "/repo" },
			{ label: "second", phase: "Other" },
			{ label: "c", phase: "Fix" },
		]);
		expect(events.filter((event) => event.type === "phase")).toEqual([{ type: "phase", title: "Scan" }, { type: "phase", title: "Fix" }]);
		expect(messages("log")).toEqual(["[look at the code] ignored option 'stallMs'", "agent({isolation:'remote'}) is not available in this build"]);
	});

	it("routes log and console output to log events", async () => {
		const { messages } = await run("log('plain'); log({ a: 1 }); console.log('x', { b: 2 }, 3); console.info('i'); console.warn('w'); console.error('e');");
		expect(messages("log")).toEqual(["plain", '{"a":1}', 'x {"b":2} 3', "i", "[warn] w", "[error] e"]);
	});

	it("throws CC's breaks-resume errors for clock and randomness", async () => {
		for (const expression of ["Date.now()", "new Date()", "Date()", "Math.random()", "new Date(0).constructor.now()"]) {
			expect((await failure(`return ${expression};`)).message).toMatch(/^(Date\.now\(\) \/ new Date\(\)|Math\.random\(\)) (is|are) unavailable in workflow scripts \(breaks resume\)\./);
		}
		expect((await run("return [new Date(0).toISOString(), Date.UTC(2020, 0, 1), Date.parse('2020-01-01T00:00:00Z')];")).result).toEqual(["1970-01-01T00:00:00.000Z", 1577836800000, 1577836800000]);
	});

	it("gives the script no host realm, no eval and no nested workflow()", async () => {
		expect((await failure("return eval('1');")).name).toBe("EvalError");
		expect((await failure("return agent.constructor('return process')();")).name).toBe("EvalError");
		expect((await failure("return parallel.constructor.constructor('return process')();")).name).toBe("EvalError");
		expect((await failure("return globalThis.constructor.constructor('return process')();")).name).toBe("EvalError");
		expect((await failure("return this.constructor.constructor('return process')();")).name).toBe("EvalError");
		expect((await run("return [typeof process, typeof require, typeof fetch];")).result).toEqual(["undefined", "undefined", "undefined"]);
		expect((await failure("return await workflow('child');")).message).toBe("workflow() is not available in this runner — inline the inner script");
		expect((await failure("return () => 1;")).message).toBe("workflow result cannot be a function");
	});

	it("clones args and exposes an unlimited budget by default", async () => {
		const args = { list: [1] };
		const { result } = await run("args.list.push(2);\nreturn [args.list, budget.total, budget.spent(), budget.remaining() === Infinity];", { args });
		expect(result).toEqual([[1, 2], null, 0, true]);
		expect(args.list).toEqual([1]);
	});

	it("runs host timers and clears them when the run is aborted", async () => {
		expect((await run("await new Promise((resolve) => setTimeout(resolve, 5));\nreturn 'woke';")).result).toBe("woke");
		const controller = new AbortController();
		const mock = mockHost({ signal: controller.signal, agent: () => new Promise(() => {}) });
		const running = runWorkflow(parseWorkflow(`${META}setTimeout(() => log('late'), 20);\nawait agent('forever');`), mock.host);
		setTimeout(() => controller.abort(), 5);
		await expect(running).rejects.toThrow("Workflow aborted");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(mock.messages("log")).toEqual([]);
	});

	it("bounds the synchronous part of a script", async () => {
		await expect(run("while (true) {}", { syncTimeoutMs: 50 })).rejects.toThrow(/timed out/);
	});
});

describe("workflow core imports", () => {
	it("imports nothing from Pi and nothing outside node:vm, node:crypto, node:fs, node:path and its own folder", () => {
		const folder = new URL("../extensions/subagents/workflow/", import.meta.url);
		for (const file of readdirSync(folder)) {
			const source = readFileSync(new URL(file, folder), "utf8");
			const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
			expect(specifiers.filter((specifier) => specifier?.startsWith("@earendil-works/")), file).toEqual([]);
			expect(specifiers.filter((specifier) => !["node:vm", "node:crypto", "node:fs", "node:path"].includes(specifier ?? "") && !specifier?.startsWith("./")), file).toEqual([]);
		}
	});
});
