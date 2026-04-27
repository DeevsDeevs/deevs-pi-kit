import type { AgentsSettings } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 900_000;
export const DEFAULT_RETURN_BYTES = 65_536;
export const HARD_MAX_RETURN_BYTES = 262_144;
export const STATUS_TAIL_BYTES = 4096;
export const DEFAULT_PARALLEL_CONCURRENCY = 3;
export const MAX_PARALLEL_CONCURRENCY = 6;
export const MAX_COMPLETED_RECORDS = 64;

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
