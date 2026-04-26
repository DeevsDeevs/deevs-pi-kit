import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ProcessesConfig } from "./config.ts";
import { getShellPath } from "./config.ts";
import type { SpawnSpec } from "./types.ts";

export interface PtyProcessHandle {
	pid: number;
	write(input: string): void;
	kill(signal?: string): void;
	onData(callback: (data: string) => void): void;
	onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

export async function spawnPtyProcess(spec: SpawnSpec, config: ProcessesConfig): Promise<PtyProcessHandle> {
	const pty = await loadNodePty();
	const file = spec.argv ? spec.argv[0]! : getShellPath(config);
	const args = spec.argv ? spec.argv.slice(1) : ["-lc", spec.command!];
	const child = pty.spawn(file, args, {
		name: "xterm-256color",
		cols: config.ui.terminalCols,
		rows: config.ui.terminalRows,
		cwd: spec.cwd,
		env: { ...process.env, TERM: "xterm-256color", ...spec.env },
	});

	return {
		pid: child.pid,
		write(input) {
			child.write(input);
		},
		kill(signal) {
			child.kill(signal);
		},
		onData(callback) {
			child.onData((data) => callback(normalizePtyOutput(data)));
		},
		onExit(callback) {
			child.onExit(callback);
		},
	};
}

async function loadNodePty(): Promise<{ spawn: (file: string, args: string[], options: Record<string, unknown>) => NodePtyProcess }> {
	try {
		await ensureSpawnHelperExecutable();
		return (await import("node-pty")) as unknown as { spawn: (file: string, args: string[], options: Record<string, unknown>) => NodePtyProcess };
	} catch (error) {
		throw new Error(`PTY backend requires node-pty. Reinstall/update the package so optional dependencies are installed. ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function ensureSpawnHelperExecutable(): Promise<void> {
	const require = createRequire(import.meta.url);
	const packageJson = require.resolve("node-pty/package.json");
	const packageRoot = dirname(packageJson);
	const helper = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	await chmod(helper, 0o755).catch(() => undefined);
}

function normalizePtyOutput(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

interface NodePtyProcess {
	pid: number;
	write(input: string): void;
	kill(signal?: string): void;
	onData(callback: (data: string) => void): void;
	onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}
