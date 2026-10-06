import vm from "node:vm";
import { wrapBody, type ParsedWorkflow } from "./meta.ts";

export const SYNC_TIMEOUT_MS = 30_000;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface AgentOptions {
	label: string;
	phase?: string;
	schema?: { [key: string]: JsonValue };
	model?: string;
	effort?: string | number;
	isolation?: "worktree";
	agentType?: string;
	cwd?: string;
}

export type WorkflowEvent =
	| { type: "log"; message: string }
	| { type: "phase"; title: string }
	| { type: "failure"; message: string };

export interface WorkflowHost {
	agent(prompt: string, options: AgentOptions): Promise<JsonValue>;
	emit(event: WorkflowEvent): void;
	args?: JsonValue;
	budget?: { total: number | null; spent(): number };
	signal?: AbortSignal;
	syncTimeoutMs?: number;
}

interface Bridge {
	agent(prompt: string, optionsJson: string): Promise<string>;
	emit(type: "log" | "phase" | "failure", text: string): void;
	spent(): number;
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(id: number): void;
	total: number | null;
	args: string | undefined;
}

// Runs inside the context, so every object the script can reach belongs to the
// sandbox realm; the host bridge stays in this closure and only strings,
// numbers and envelopes cross it.
const PRELUDE = String.raw`(bridge) => {
	"use strict";
	const NOW_ERROR = "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.";
	const RANDOM_ERROR = "Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.";
	const BUDGET_ERROR = "WorkflowBudgetExceededError";
	const total = bridge.total;
	const spent = () => bridge.spent();
	const text = (value) => {
		if (typeof value === "string") return value;
		try { return String(JSON.stringify(value)); } catch { return String(value); }
	};
	const reason = (error) => error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error);
	const checkBudget = () => {
		if (total === null || total <= 0) return;
		const used = spent();
		if (used < total) return;
		const error = new Error("Workflow token budget exceeded (" + used + " / " + total + " output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.");
		error.name = BUDGET_ERROR;
		throw error;
	};
	const unwrap = (envelope) => {
		const outcome = JSON.parse(envelope);
		if (outcome.ok) return outcome.value;
		const error = new Error(outcome.message);
		error.name = outcome.name;
		throw error;
	};
	const settle = (kind, outcomes) => {
		let dropped = 0;
		const values = outcomes.map((outcome, index) => {
			if (outcome.status === "fulfilled") return outcome.value;
			if (outcome.reason?.name === BUDGET_ERROR) dropped++;
			else bridge.emit("failure", kind + "[" + index + "] failed: " + reason(outcome.reason));
			return null;
		});
		if (dropped > 0) bridge.emit("failure", kind + ": " + dropped + (dropped === 1 ? " slot" : " slots") + " dropped — token budget exceeded");
		return values;
	};
	const agent = async (prompt, options) => {
		checkBudget();
		return unwrap(await bridge.agent(String(prompt), text(options ?? {})));
	};
	const parallel = async (thunks) => {
		if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
		if (thunks.length === 0) return [];
		for (const thunk of thunks) {
			if (typeof thunk !== "function") throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
		}
		checkBudget();
		return settle("parallel", await Promise.allSettled(thunks.map(async (thunk) => thunk())));
	};
	const pipeline = async (items, ...stages) => {
		if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
		if (items.length === 0) return [];
		for (const stage of stages) {
			if (typeof stage !== "function") throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
		}
		checkBudget();
		return settle("pipeline", await Promise.allSettled(items.map(async (item, index) => {
			let value = await item;
			for (const stage of stages) {
				if (value === null) break;
				value = await stage(value, item, index);
			}
			return value;
		})));
	};
	const say = (prefix) => (...values) => bridge.emit("log", prefix + values.map(text).join(" "));
	Math.random = function random() { throw new Error(RANDOM_ERROR); };
	const RealDate = Date;
	RealDate.now = function now() { throw new Error(NOW_ERROR); };
	function ShimDate(...values) {
		if (!new.target || values.length === 0) throw new Error(NOW_ERROR);
		return Reflect.construct(RealDate, values, new.target);
	}
	ShimDate.now = RealDate.now;
	ShimDate.parse = RealDate.parse;
	ShimDate.UTC = RealDate.UTC;
	ShimDate.prototype = RealDate.prototype;
	RealDate.prototype.constructor = ShimDate;
	Object.freeze(RealDate);
	Object.assign(globalThis, {
		Date: ShimDate,
		agent,
		parallel,
		pipeline,
		phase: (title) => bridge.emit("phase", String(title)),
		log: (message) => bridge.emit("log", text(message)),
		console: Object.freeze({ log: say(""), info: say(""), debug: say(""), warn: say("[warn] "), error: say("[error] ") }),
		budget: Object.freeze({ total, spent, remaining: () => total === null ? Infinity : Math.max(0, total - spent()) }),
		workflow: async () => { throw new Error("workflow() is not available in this runner — inline the inner script"); },
		args: bridge.args === undefined ? undefined : JSON.parse(bridge.args),
		setTimeout: (callback, delay, ...rest) => bridge.setTimeout(() => callback(...rest), Number(delay) || 0),
		clearTimeout: (id) => bridge.clearTimeout(Number(id)),
	});
}`;

export async function runWorkflow(workflow: Pick<ParsedWorkflow, "body" | "bodyLine">, host: WorkflowHost): Promise<JsonValue | undefined> {
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	let nextTimer = 1;
	let currentPhase: string | undefined;
	const log = (message: string) => host.emit({ type: "log", message });
	const bridge: Bridge = {
		agent: async (prompt, optionsJson) => {
			try {
				const options = agentOptions(prompt, JSON.parse(optionsJson), currentPhase, log);
				return JSON.stringify({ ok: true, value: await host.agent(prompt, options) });
			} catch (error) {
				const { name, message } = toError(error);
				return JSON.stringify({ ok: false, name, message });
			}
		},
		emit: (type, text) => {
			if (type === "phase") {
				currentPhase = text;
				host.emit({ type, title: text });
			} else host.emit({ type, message: text });
		},
		spent: () => host.budget?.spent() ?? 0,
		setTimeout: (callback, delay) => {
			if (host.signal?.aborted) return 0;
			const id = nextTimer++;
			timers.set(id, setTimeout(() => {
				timers.delete(id);
				try {
					callback();
				} catch (error) {
					log(`[error] setTimeout callback failed: ${toError(error).message}`);
				}
			}, delay));
			return id;
		},
		clearTimeout: (id) => {
			clearTimeout(timers.get(id));
			timers.delete(id);
		},
		total: host.budget?.total ?? null,
		args: host.args === undefined ? undefined : JSON.stringify(host.args),
	};
	if (host.signal?.aborted) throw new Error("Workflow aborted");
	const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
	new vm.Script(PRELUDE, { filename: "workflow-prelude.js" }).runInContext(context)(bridge);
	const script = new vm.Script(`${wrapBody(workflow.body)}()`, { filename: "workflow.js", lineOffset: workflow.bodyLine - 2 });
	let abort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Workflow aborted"));
	});
	host.signal?.addEventListener("abort", abort, { once: true });
	try {
		const result = await Promise.race([script.runInContext(context, { timeout: host.syncTimeoutMs ?? SYNC_TIMEOUT_MS }), aborted]);
		if (typeof result === "function") throw new Error("workflow result cannot be a function");
		const json = JSON.stringify(result);
		return json === undefined ? undefined : JSON.parse(json);
	} catch (error) {
		throw toError(error);
	} finally {
		host.signal?.removeEventListener("abort", abort);
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	}
}

function agentOptions(prompt: string, raw: JsonValue, phase: string | undefined, log: (message: string) => void): AgentOptions {
	const given = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const label = typeof given.label === "string" && given.label.length > 0 ? given.label : prompt.replace(/\s+/g, " ").trim().slice(0, 60);
	if (given.isolation === "remote") throw new Error("agent({isolation:'remote'}) is not available in this build");
	const options: AgentOptions = { label, phase };
	for (const [key, value] of Object.entries(given)) {
		if (key === "label" || value === null) continue;
		if (typeof value === "string" && (key === "phase" || key === "model" || key === "agentType" || key === "cwd")) options[key] = value;
		else if (key === "effort" && (typeof value === "string" || typeof value === "number")) options.effort = value;
		else if (key === "isolation" && value === "worktree") options.isolation = value;
		else if (key === "schema" && typeof value === "object" && !Array.isArray(value)) options.schema = value;
		else log(`[${label}] ignored option '${key}'`);
	}
	return options;
}

function toError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	const fields: { name?: unknown; message?: unknown; stack?: unknown } = Object(reason);
	const error = new Error(typeof fields.message === "string" ? fields.message : String(reason));
	if (typeof fields.name === "string") error.name = fields.name;
	if (typeof fields.stack === "string") error.stack = fields.stack;
	return error;
}
