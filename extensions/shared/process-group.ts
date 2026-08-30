import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
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

export async function readProcessGroupId(pid: number): Promise<number | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const fields = stat.slice(close + 2).trim().split(/\s+/);
			const pgid = Number(fields[2]);
			return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 1_000, maxBuffer: 64 * 1024 });
		const pgid = Number(stdout.trim());
		return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
	} catch {
		return undefined;
	}
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

export async function isProcessGroupQuiescent(pgid: number): Promise<boolean> {
	if (!isProcessGroupAlive(pgid)) return true;
	if (process.platform !== "linux") return false;
	try {
		for (const entry of await readdir("/proc", { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
			const stat = await readFile(`/proc/${entry.name}/stat`, "utf8").catch(() => undefined);
			if (!stat) continue;
			const close = stat.lastIndexOf(")");
			const fields = stat.slice(close + 2).trim().split(/\s+/);
			if (Number(fields[2]) === pgid && fields[0] !== "Z") return false;
		}
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
