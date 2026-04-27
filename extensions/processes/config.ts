import { existsSync } from "node:fs";

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
