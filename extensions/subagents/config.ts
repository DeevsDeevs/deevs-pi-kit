import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadProjectConfig } from "../shared/project-config.ts";
import type { AgentsSettings, DelegatedWritePolicy } from "./catalog-types.ts";

export const DEFAULT_TIMEOUT_MS = 6 * 60 * 60_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const DEFAULT_PARALLEL_CONCURRENCY = 3;
export const MAX_PARALLEL_CONCURRENCY = 6;

export const SUBAGENTS_CONFIG_FILE = "subagents.json";

const DELEGATED_WRITE_POLICIES: DelegatedWritePolicy[] = ["prompt", "worktree", "always"];

export const defaultAgentsSettings: AgentsSettings = {
	allowedModels: [],
	modelsByAgent: {},
	defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
	maxTimeoutMs: MAX_TIMEOUT_MS,
	parallelDefaultConcurrency: DEFAULT_PARALLEL_CONCURRENCY,
	parallelMaxConcurrency: MAX_PARALLEL_CONCURRENCY,
	delegatedWrites: "prompt",
	worktreeSetup: [],
};

export function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function normalizeAgentsSettings(input: Partial<AgentsSettings>): AgentsSettings {
	const merged = { ...structuredClone(defaultAgentsSettings), ...input } as AgentsSettings;
	merged.allowedModels = Array.isArray(input.allowedModels) ? input.allowedModels.filter((value): value is string => typeof value === "string") : [];
	merged.modelsByAgent = input.modelsByAgent && typeof input.modelsByAgent === "object" && !Array.isArray(input.modelsByAgent)
		? Object.fromEntries(Object.entries(input.modelsByAgent).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"))
		: {};
	merged.defaultModel = typeof input.defaultModel === "string" && input.defaultModel.trim() ? input.defaultModel : undefined;
	merged.maxTimeoutMs = clampNumber(input.maxTimeoutMs, 60_000, MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
	merged.defaultTimeoutMs = clampNumber(input.defaultTimeoutMs, 1_000, merged.maxTimeoutMs, DEFAULT_TIMEOUT_MS);
	merged.parallelMaxConcurrency = clampNumber(input.parallelMaxConcurrency, 1, 12, MAX_PARALLEL_CONCURRENCY);
	merged.parallelDefaultConcurrency = clampNumber(input.parallelDefaultConcurrency, 1, merged.parallelMaxConcurrency, DEFAULT_PARALLEL_CONCURRENCY);
	merged.delegatedWrites = DELEGATED_WRITE_POLICIES.includes(input.delegatedWrites as DelegatedWritePolicy) ? input.delegatedWrites as DelegatedWritePolicy : "prompt";
	merged.worktreeRoot = typeof input.worktreeRoot === "string" && input.worktreeRoot.trim() ? input.worktreeRoot.trim() : undefined;
	merged.worktreeSetup = Array.isArray(input.worktreeSetup) ? input.worktreeSetup.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
	return merged;
}

export async function loadAgentsSettings(cwd: string): Promise<AgentsSettings> {
	const defaults = normalizeAgentsSettings({ ...defaultAgentsSettings, ...await readUserAgentsSettings() });
	return loadProjectConfig(cwd, SUBAGENTS_CONFIG_FILE, defaults, normalizeAgentsSettings);
}

/** User-level defaults so a single home config can hold the write policy for every project. */
async function readUserAgentsSettings(): Promise<Partial<AgentsSettings>> {
	try {
		const parsed = JSON.parse(await readFile(path.join(piAgentDir(), SUBAGENTS_CONFIG_FILE), "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<AgentsSettings> : {};
	} catch {
		return {};
	}
}


function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(Math.floor(value), max)) : fallback;
}

export function clampTimeoutMs(value: number | undefined, settings: AgentsSettings): number {
	const timeout = value ?? settings.defaultTimeoutMs;
	if (!Number.isFinite(timeout)) return settings.defaultTimeoutMs;
	return Math.max(1_000, Math.min(Math.floor(timeout), settings.maxTimeoutMs));
}

export function clampConcurrency(value: number | undefined, settings: AgentsSettings): number {
	const concurrency = value ?? settings.parallelDefaultConcurrency;
	if (!Number.isFinite(concurrency)) return settings.parallelDefaultConcurrency;
	return Math.max(1, Math.min(Math.floor(concurrency), settings.parallelMaxConcurrency));
}
