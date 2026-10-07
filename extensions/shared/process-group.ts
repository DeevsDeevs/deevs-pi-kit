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

export function trySignalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Group already exited.
	}
}
