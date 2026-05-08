import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessesConfig } from "./config.ts";
import type { StartProcessInput } from "./types.ts";

const DETACH_PATTERNS = [
	/\bnohup\b/i,
	/\bdisown\b/i,
	/\bsetsid\b/i,
	/(^|[^&])&(?![&>\d])\s*(?:$|[;#\n]|\S)/m,
];

export function detectBackgroundBash(command: string): string | null {
	for (const pattern of DETACH_PATTERNS) {
		if (pattern.test(command)) {
			return "Background/detached shell command detected. Use proc_start so pi can track, read, and clean up the process.";
		}
	}
	return null;
}

export function validateStartInput(input: StartProcessInput, config: ProcessesConfig): void {
	if (!input.name || !input.name.trim()) throw new Error("proc_start requires a non-empty name");
	if (input.command && input.argv) throw new Error("proc_start accepts exactly one of command or argv, not both");
	if (!input.command && !input.argv) throw new Error("proc_start requires command or argv");
	if (input.command !== undefined && input.command.trim().length === 0) throw new Error("proc_start command cannot be empty");
	if (input.argv !== undefined && input.argv.length === 0) throw new Error("proc_start argv cannot be empty");
	if (input.argv?.some((part) => typeof part !== "string" || part.length === 0)) {
		throw new Error("proc_start argv entries must be non-empty strings");
	}
	if (input.backend === "pty" && !config.execution.allowPty) throw new Error("PTY backend is not enabled yet");
	if ((input.backend === "tmux" || input.persistent) && input.env) throw new Error("tmux backend does not support env overlays yet");
	if (input.persistent && !config.execution.persistentEnabled) throw new Error("Persistent processes are not enabled yet");
	if (input.persistent && input.backend && input.backend !== "tmux") throw new Error("Persistent processes require the tmux backend");
	if ((input.watches?.length ?? 0) > config.limits.maxWatchesPerProcess) {
		throw new Error(`Too many watches; max is ${config.limits.maxWatchesPerProcess}`);
	}
}

export async function resolveCwd(rawCwd: string | undefined, ctx: ExtensionContext, config: ProcessesConfig): Promise<string> {
	const base = normalizePathArg(ctx.cwd);
	const requested = rawCwd ? normalizePathArg(rawCwd) : base;
	const resolved = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);

	const info = await stat(resolved).catch(() => null);
	if (!info?.isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${resolved}`);

	const realBase = await realpath(base);
	const realResolved = await realpath(resolved);

	if (!config.execution.allowCwdOutsideProject && !isInside(realResolved, realBase)) {
		throw new Error(`cwd is outside the current project: ${realResolved}`);
	}

	return realResolved;
}

export function redactValue(key: string, value: string, config: ProcessesConfig): string {
	const upper = key.toUpperCase();
	if (config.safety.redactEnvKeys.some((needle) => upper.includes(needle))) return "[redacted]";
	return value;
}

function normalizePathArg(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
