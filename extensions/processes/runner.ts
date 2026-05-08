import { spawn, type SpawnOptions } from "node:child_process";
import type { ProcessesConfig } from "./config.ts";
import { getShellPath } from "./config.ts";
import type { SpawnedProcess, SpawnSpec } from "./types.ts";

export function ensureSupportedPlatform(): void {
	if (process.platform === "win32") {
		throw new Error("deevs processes plugin does not support Windows yet. macOS/Linux only for now.");
	}
}

export function spawnPipeProcess(spec: SpawnSpec, config: ProcessesConfig): SpawnedProcess {
	ensureSupportedPlatform();

	const env = { ...process.env, ...spec.env };
	const options: SpawnOptions = {
		cwd: spec.cwd,
		env,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	};

	const child = spec.argv
		? spawn(spec.argv[0]!, spec.argv.slice(1), options)
		: spawn(getShellPath(config), ["-lc", spec.command!], options);

	if (!child.pid) {
		throw new Error("Process spawned without a pid");
	}

	return {
		child,
		pid: child.pid,
		pgid: child.pid,
	};
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	ensureSupportedPlatform();
	process.kill(-pid, signal);
}

export function signalProcess(pid: number, signal: NodeJS.Signals): void {
	ensureSupportedPlatform();
	process.kill(pid, signal);
}
