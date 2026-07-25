import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readProcessIdentity(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const fields = stat.slice(close + 2).trim().split(/\s+/);
			const startTicks = fields[19];
			const executable = await readlink(`/proc/${pid}/exe`).catch(() => "unknown");
			return startTicks ? `${startTicks}:${executable}` : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const { stdout } = await execFileAsync("ps", ["eww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], { timeout: 1_000, maxBuffer: 2_000_000 });
		const value = stdout.trim().replace(/\s+/g, " ");
		return value ? createHash("sha256").update(value).digest("hex") : undefined;
	} catch {
		return undefined;
	}
}

export async function ownsProcessIdentity(pid: number, expected: string | undefined): Promise<boolean> {
	return expected !== undefined && await readProcessIdentity(pid) === expected;
}

export async function quiesceProcessGroup(pgid: number, options: { graceful?: boolean; graceMs?: number; killWaitMs?: number } = {}): Promise<boolean> {
	if (!isProcessGroupAlive(pgid)) return true;
	if (options.graceful !== false) {
		trySignalGroup(pgid, "SIGTERM");
		await waitForGroupExit(pgid, options.graceMs ?? 250);
	}
	if (!isProcessGroupAlive(pgid)) return true;
	trySignalGroup(pgid, "SIGKILL");
	await waitForGroupExit(pgid, options.killWaitMs ?? 2_000);
	return !isProcessGroupAlive(pgid);
}

export function isProcessGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

export function trySignalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Group already exited.
	}
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessGroupAlive(pgid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}
