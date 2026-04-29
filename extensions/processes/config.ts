import { existsSync } from "node:fs";
import { loadProjectConfig, mergeDeep, saveProjectConfig } from "../shared/project-config.ts";

export interface ProcessesConfig {
	limits: {
		maxProcesses: number;
		maxExitedRecords: number;
		autoClearExitedAfterMs: number;
		defaultWaitMs: number;
		maxWaitMs: number;
		maxReadBytes: number;
		maxChunkBytes: number;
		maxBufferBytesPerProcess: number;
		maxLogBytesPerProcess: number;
		maxWatchesPerProcess: number;
	};
	execution: {
		shellPath?: string;
		allowCwdOutsideProject: boolean;
		defaultBackend: "pipe" | "pty" | "tmux";
		allowPty: boolean;
		killOnShutdown: boolean;
		killOnReload: boolean;
		persistentEnabled: boolean;
	};
	safety: {
		blockBackgroundBash: boolean;
		redactEnvKeys: string[];
		confirmLongRunningServers: boolean;
		allowNetworkListeners: boolean;
	};
	logs: {
		enabled: boolean;
		directory?: string;
		rotate: boolean;
	};
	alerts: {
		defaultAlertOnFailure: boolean;
		defaultAlertOnExit: boolean;
		suppressNotificationsForNamePrefixes: string[];
		repeatWatchCooldownMs: number;
		maxAgentTurnsPerMinute: number;
	};
	ui: {
		dockEnabled: boolean;
		dockHeight: number;
		followLogs: boolean;
		terminalCols: number;
		terminalRows: number;
	};
}

export const PROCESSES_CONFIG_FILE = "processes.json";

export const defaultConfig: ProcessesConfig = {
	limits: {
		maxProcesses: 16,
		maxExitedRecords: 64,
		autoClearExitedAfterMs: 0,
		defaultWaitMs: 1000,
		maxWaitMs: 30_000,
		maxReadBytes: 65_536,
		maxChunkBytes: 262_144,
		maxBufferBytesPerProcess: 1_000_000,
		maxLogBytesPerProcess: 50_000_000,
		maxWatchesPerProcess: 16,
	},
	execution: {
		allowCwdOutsideProject: false,
		defaultBackend: "pipe",
		allowPty: true,
		killOnShutdown: true,
		killOnReload: true,
		persistentEnabled: true,
	},
	safety: {
		blockBackgroundBash: true,
		redactEnvKeys: ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASS", "AUTH", "CREDENTIAL", "COOKIE"],
		confirmLongRunningServers: false,
		allowNetworkListeners: true,
	},
	logs: {
		enabled: true,
		rotate: true,
	},
	alerts: {
		defaultAlertOnFailure: true,
		defaultAlertOnExit: false,
		suppressNotificationsForNamePrefixes: ["agent:", "agent-group:"],
		repeatWatchCooldownMs: 5000,
		maxAgentTurnsPerMinute: 3,
	},
	ui: {
		dockEnabled: false,
		dockHeight: 10,
		followLogs: true,
		terminalCols: 120,
		terminalRows: 30,
	},
};

export function normalizeProcessesConfig(input: Partial<ProcessesConfig>): ProcessesConfig {
	const merged = mergeDeep(defaultConfig, input);
	merged.limits.maxProcesses = clampNumber(merged.limits.maxProcesses, 1, 128, defaultConfig.limits.maxProcesses);
	merged.limits.maxExitedRecords = clampNumber(merged.limits.maxExitedRecords, 0, 1000, defaultConfig.limits.maxExitedRecords);
	merged.limits.autoClearExitedAfterMs = clampNumber(merged.limits.autoClearExitedAfterMs, 0, 86_400_000, defaultConfig.limits.autoClearExitedAfterMs);
	merged.limits.defaultWaitMs = clampNumber(merged.limits.defaultWaitMs, 0, merged.limits.maxWaitMs, defaultConfig.limits.defaultWaitMs);
	merged.limits.maxWaitMs = clampNumber(merged.limits.maxWaitMs, 1_000, 300_000, defaultConfig.limits.maxWaitMs);
	merged.limits.maxReadBytes = clampNumber(merged.limits.maxReadBytes, 1, merged.limits.maxBufferBytesPerProcess, defaultConfig.limits.maxReadBytes);
	merged.limits.maxChunkBytes = clampNumber(merged.limits.maxChunkBytes, 1, 10_000_000, defaultConfig.limits.maxChunkBytes);
	merged.limits.maxBufferBytesPerProcess = clampNumber(merged.limits.maxBufferBytesPerProcess, 1_000, 100_000_000, defaultConfig.limits.maxBufferBytesPerProcess);
	merged.limits.maxLogBytesPerProcess = clampNumber(merged.limits.maxLogBytesPerProcess, 0, 1_000_000_000, defaultConfig.limits.maxLogBytesPerProcess);
	merged.limits.maxWatchesPerProcess = clampNumber(merged.limits.maxWatchesPerProcess, 0, 128, defaultConfig.limits.maxWatchesPerProcess);
	if (!isBackend(merged.execution.defaultBackend)) merged.execution.defaultBackend = defaultConfig.execution.defaultBackend;
	merged.execution.allowCwdOutsideProject = merged.execution.allowCwdOutsideProject === true;
	merged.execution.allowPty = merged.execution.allowPty !== false;
	merged.execution.killOnShutdown = merged.execution.killOnShutdown !== false;
	merged.execution.killOnReload = merged.execution.killOnReload !== false;
	merged.execution.persistentEnabled = merged.execution.persistentEnabled !== false;
	if (typeof merged.execution.shellPath !== "string" || !merged.execution.shellPath.trim()) delete merged.execution.shellPath;
	merged.safety.blockBackgroundBash = merged.safety.blockBackgroundBash !== false;
	merged.safety.redactEnvKeys = Array.isArray(merged.safety.redactEnvKeys) ? merged.safety.redactEnvKeys.filter((value): value is string => typeof value === "string") : defaultConfig.safety.redactEnvKeys;
	merged.safety.confirmLongRunningServers = merged.safety.confirmLongRunningServers === true;
	merged.safety.allowNetworkListeners = merged.safety.allowNetworkListeners !== false;
	merged.logs.enabled = merged.logs.enabled !== false;
	merged.logs.rotate = merged.logs.rotate !== false;
	if (typeof merged.logs.directory !== "string" || !merged.logs.directory.trim()) delete merged.logs.directory;
	merged.alerts.defaultAlertOnFailure = merged.alerts.defaultAlertOnFailure !== false;
	merged.alerts.defaultAlertOnExit = merged.alerts.defaultAlertOnExit === true;
	merged.alerts.suppressNotificationsForNamePrefixes = Array.isArray(merged.alerts.suppressNotificationsForNamePrefixes) ? merged.alerts.suppressNotificationsForNamePrefixes.filter((value): value is string => typeof value === "string") : defaultConfig.alerts.suppressNotificationsForNamePrefixes;
	merged.alerts.repeatWatchCooldownMs = clampNumber(merged.alerts.repeatWatchCooldownMs, 0, 60_000, defaultConfig.alerts.repeatWatchCooldownMs);
	merged.alerts.maxAgentTurnsPerMinute = clampNumber(merged.alerts.maxAgentTurnsPerMinute, 0, 60, defaultConfig.alerts.maxAgentTurnsPerMinute);
	merged.ui.dockEnabled = merged.ui.dockEnabled === true;
	merged.ui.dockHeight = clampNumber(merged.ui.dockHeight, 1, 30, defaultConfig.ui.dockHeight);
	merged.ui.followLogs = merged.ui.followLogs !== false;
	merged.ui.terminalCols = clampNumber(merged.ui.terminalCols, 20, 500, defaultConfig.ui.terminalCols);
	merged.ui.terminalRows = clampNumber(merged.ui.terminalRows, 5, 200, defaultConfig.ui.terminalRows);
	return merged;
}

export async function loadProcessesConfig(cwd: string): Promise<ProcessesConfig> {
	return loadProjectConfig(cwd, PROCESSES_CONFIG_FILE, defaultConfig, normalizeProcessesConfig);
}

export async function saveProcessesConfig(cwd: string, config: ProcessesConfig): Promise<string> {
	return saveProjectConfig(cwd, PROCESSES_CONFIG_FILE, normalizeProcessesConfig(config));
}

export function applyProcessesConfig(target: ProcessesConfig, source: ProcessesConfig): void {
	Object.assign(target.limits, source.limits);
	Object.assign(target.execution, source.execution);
	Object.assign(target.safety, source.safety);
	Object.assign(target.logs, source.logs);
	Object.assign(target.alerts, source.alerts);
	Object.assign(target.ui, source.ui);
}

function isBackend(value: unknown): value is "pipe" | "pty" | "tmux" {
	return value === "pipe" || value === "pty" || value === "tmux";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(Math.floor(value), max)) : fallback;
}

export function getShellPath(config: ProcessesConfig = defaultConfig): string {
	if (config.execution.shellPath) return config.execution.shellPath;

	const candidates = [process.env.SHELL, "/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/bin/zsh"].filter(Boolean) as string[];

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return "/bin/sh";
}

export function clampWaitMs(value: number | undefined, config: ProcessesConfig): number {
	const waitMs = value ?? config.limits.defaultWaitMs;
	if (!Number.isFinite(waitMs)) return config.limits.defaultWaitMs;
	return Math.max(0, Math.min(Math.floor(waitMs), config.limits.maxWaitMs));
}

export function clampReadBytes(value: number | undefined, config: ProcessesConfig): number {
	const maxBytes = value ?? config.limits.maxReadBytes;
	if (!Number.isFinite(maxBytes)) return config.limits.maxReadBytes;
	return Math.max(1, Math.min(Math.floor(maxBytes), config.limits.maxBufferBytesPerProcess));
}
