import { loadProjectConfig, saveProjectConfig } from "../shared/project-config.ts";
import type { AgentsSettings } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_RETURN_BYTES = 65_536;
export const HARD_MAX_RETURN_BYTES = 262_144;
export const STATUS_TAIL_BYTES = 4096;
export const DEFAULT_PARALLEL_CONCURRENCY = 3;
export const MAX_PARALLEL_CONCURRENCY = 6;
export const MAX_COMPLETED_RECORDS = 64;

export const SUBAGENTS_CONFIG_FILE = "subagents.json";

export const defaultAgentsSettings: AgentsSettings = {
	allowedModels: [],
	modelsByAgent: {},
	defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
	maxTimeoutMs: MAX_TIMEOUT_MS,
	parallelDefaultConcurrency: DEFAULT_PARALLEL_CONCURRENCY,
	parallelMaxConcurrency: MAX_PARALLEL_CONCURRENCY,
	dockEnabled: false,
	dockHeight: 6,
	defaultAllowWrite: false,
	notifyOnTerminal: true,
	wakeOnCompletion: true,
	wakeOnFailure: true,
	wakeOnTimeout: true,
	maxCompletedRecords: MAX_COMPLETED_RECORDS,
};

export function normalizeAgentsSettings(input: Partial<AgentsSettings>): AgentsSettings {
	const merged = { ...structuredClone(defaultAgentsSettings), ...input } as AgentsSettings;
	merged.allowedModels = Array.isArray(input.allowedModels) ? input.allowedModels.filter((value): value is string => typeof value === "string") : [];
	merged.modelsByAgent = input.modelsByAgent && typeof input.modelsByAgent === "object" && !Array.isArray(input.modelsByAgent)
		? Object.fromEntries(Object.entries(input.modelsByAgent).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"))
		: {};
	merged.defaultModel = typeof input.defaultModel === "string" && input.defaultModel.trim() ? input.defaultModel : undefined;
	merged.maxTimeoutMs = clampNumber(input.maxTimeoutMs, 60_000, 3_600_000, MAX_TIMEOUT_MS);
	merged.defaultTimeoutMs = clampNumber(input.defaultTimeoutMs, 1_000, merged.maxTimeoutMs, DEFAULT_TIMEOUT_MS);
	merged.parallelMaxConcurrency = clampNumber(input.parallelMaxConcurrency, 1, 12, MAX_PARALLEL_CONCURRENCY);
	merged.parallelDefaultConcurrency = clampNumber(input.parallelDefaultConcurrency, 1, merged.parallelMaxConcurrency, DEFAULT_PARALLEL_CONCURRENCY);
	merged.dockEnabled = input.dockEnabled === true;
	merged.dockHeight = clampNumber(input.dockHeight, 1, 20, defaultAgentsSettings.dockHeight);
	merged.defaultAllowWrite = input.defaultAllowWrite === true;
	merged.notifyOnTerminal = input.notifyOnTerminal !== false;
	merged.wakeOnCompletion = input.wakeOnCompletion !== false;
	merged.wakeOnFailure = input.wakeOnFailure !== false;
	merged.wakeOnTimeout = input.wakeOnTimeout !== false;
	merged.maxCompletedRecords = clampNumber(input.maxCompletedRecords, 1, 500, MAX_COMPLETED_RECORDS);
	return merged;
}

export async function loadAgentsSettings(cwd: string): Promise<AgentsSettings> {
	return loadProjectConfig(cwd, SUBAGENTS_CONFIG_FILE, defaultAgentsSettings, normalizeAgentsSettings);
}

export async function saveAgentsSettings(cwd: string, settings: AgentsSettings): Promise<string> {
	return saveProjectConfig(cwd, SUBAGENTS_CONFIG_FILE, normalizeAgentsSettings(settings));
}

export function applyAgentsSettings(target: AgentsSettings, source: AgentsSettings): void {
	Object.assign(target, structuredClone(source));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(Math.floor(value), max)) : fallback;
}

export function clampTimeoutMs(value: number | undefined, settings: AgentsSettings): number {
	const timeout = value ?? settings.defaultTimeoutMs;
	if (!Number.isFinite(timeout)) return settings.defaultTimeoutMs;
	return Math.max(1_000, Math.min(Math.floor(timeout), settings.maxTimeoutMs));
}

export function clampReturnBytes(value: number | undefined): number {
	const bytes = value ?? DEFAULT_RETURN_BYTES;
	if (!Number.isFinite(bytes)) return DEFAULT_RETURN_BYTES;
	return Math.max(1, Math.min(Math.floor(bytes), HARD_MAX_RETURN_BYTES));
}

export function clampStatusTailBytes(value: number | undefined): number {
	return Math.min(clampReturnBytes(value), STATUS_TAIL_BYTES);
}

export function clampConcurrency(value: number | undefined, settings: AgentsSettings): number {
	const concurrency = value ?? settings.parallelDefaultConcurrency;
	if (!Number.isFinite(concurrency)) return settings.parallelDefaultConcurrency;
	return Math.max(1, Math.min(Math.floor(concurrency), settings.parallelMaxConcurrency));
}
