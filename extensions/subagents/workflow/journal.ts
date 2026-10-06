import { createHash } from "node:crypto";
import type { AgentOptions, JsonValue } from "./sandbox.ts";

export type JournalRecord =
	| { type: "launched" }
	| { type: "started"; key: string; agentId: string; label?: string; phase?: string }
	| { type: "result"; key: string; agentId: string; result: JsonValue }
	| { type: "failed"; key: string; agentId: string };

export type ReplayStep = { key: string; cached: false } | { key: string; cached: true; result: JsonValue };

const KEYED_OPTIONS = ["schema", "model", "effort", "isolation", "agentType", "cwd"] as const;

export function canon(options: Partial<AgentOptions> | undefined): string {
	const picked: { [key: string]: JsonValue } = {};
	for (const key of KEYED_OPTIONS) {
		const value = options?.[key];
		if (value !== undefined) picked[key] = value;
	}
	return JSON.stringify(sortKeys(picked));
}

export function chainKey(previous: string, prompt: string, options: Partial<AgentOptions> | undefined): string {
	return `v2:${sha256(`${previous}\0${prompt}\0${canon(options)}`)}`;
}

export function parseJournal(text: string): JournalRecord[] {
	return text.split("\n").flatMap((line): JournalRecord[] => {
		try {
			const { type, key, agentId, result }: Partial<{ type: string; key: string; agentId: string; result: JsonValue }> = JSON.parse(line);
			if (type === "launched") return [{ type }];
			if (typeof key !== "string" || typeof agentId !== "string") return [];
			if (type === "started") return [{ type, key, agentId }];
			if (type === "result" && result !== undefined) return [{ type, key, agentId, result }];
			if (type === "failed") return [{ type, key, agentId }];
			return [];
		} catch {
			return [];
		}
	});
}

// Longest-unchanged-prefix replay: the first new, edited or failed call and
// every call after it run live; a call that started but never finished is
// re-run without ending the prefix.
export class JournalReplay {
	private readonly results = new Map<string, JsonValue>();
	private readonly started = new Set<string>();
	private readonly failed = new Set<string>();
	private previous = "";
	private diverged = false;

	constructor(records: readonly JournalRecord[]) {
		for (const record of records) {
			if (record.type === "result") this.results.set(record.key, record.result);
			else if (record.type === "started") this.started.add(record.key);
			else if (record.type === "failed") this.failed.add(record.key);
		}
	}

	next(prompt: string, options: Partial<AgentOptions> | undefined): ReplayStep {
		const key = chainKey(this.previous, prompt, options);
		this.previous = key;
		const result = this.results.get(key);
		if (!this.diverged && result !== undefined) return { key, cached: true, result: structuredClone(result) };
		if (!this.started.has(key) || this.failed.has(key)) this.diverged = true;
		return { key, cached: false };
	}
}

export class CrashKeys {
	private readonly occurrences = new Map<string, number>();

	next(prompt: string, options: Partial<AgentOptions> | undefined): string {
		const base = sha256(`${prompt}\0${canon(options)}`);
		const occurrence = this.occurrences.get(base) ?? 0;
		this.occurrences.set(base, occurrence + 1);
		return `${base}#${occurrence}`;
	}
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function sortKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== "object") return value;
	const sorted: { [key: string]: JsonValue } = {};
	for (const key of Object.keys(value).sort()) {
		if (key !== "__proto__") sorted[key] = sortKeys(value[key]);
	}
	return sorted;
}
