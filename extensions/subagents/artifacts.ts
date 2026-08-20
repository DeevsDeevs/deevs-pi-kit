import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { DelegateRunRuntime, DelegateRunSpec } from "./runtime-types.ts";

export function defaultDelegateRoot(cwd: string): string {
	const base = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const project = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
	return path.join(base, "subagents", project);
}

export function createDelegatePaths(root: string, runId: string, agentId: string) {
	const artifactsDir = path.join(root, "runs", runId);
	const sessionDir = path.join(root, "agents", agentId, "session");
	mkdirSync(artifactsDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	return {
		artifactsDir,
		sessionDir,
		systemPromptPath: path.join(artifactsDir, "system-prompt.md"),
		taskPath: path.join(artifactsDir, "task.md"),
		transcriptPath: path.join(artifactsDir, "transcript.jsonl"),
		resultPath: path.join(artifactsDir, "result.md"),
		runtimePath: path.join(artifactsDir, "runtime.json"),
	};
}

export function writeRunSpec(spec: DelegateRunSpec): void {
	writeJsonAtomic(path.join(spec.artifactsDir, "spec.json"), spec);
}

export function writeRunRuntime(spec: DelegateRunSpec, runtime: DelegateRunRuntime): void {
	writeJsonAtomic(spec.runtimePath, runtime);
}

export function appendTranscript(spec: DelegateRunSpec, line: string): void {
	const maxBytes = 10_000_000;
	const current = existsSync(spec.transcriptPath) ? statSync(spec.transcriptPath).size : 0;
	if (current >= maxBytes) return;
	const value = Buffer.from(`${line}\n`);
	appendFileSync(spec.transcriptPath, value.subarray(0, maxBytes - current), { mode: 0o600 });
}

export function writePrivateText(filePath: string, content: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

export function listRunIds(root: string): string[] {
	const runsDir = path.join(root, "runs");
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export function readRun(root: string, id: string): { spec: DelegateRunSpec; runtime: DelegateRunRuntime } | undefined {
	const dir = path.join(root, "runs", id);
	const specPath = path.join(dir, "spec.json");
	const runtimePath = path.join(dir, "runtime.json");
	if (!existsSync(specPath) || !existsSync(runtimePath)) return undefined;
	try {
		return {
			spec: JSON.parse(readFileSync(specPath, "utf8")) as DelegateRunSpec,
			runtime: JSON.parse(readFileSync(runtimePath, "utf8")) as DelegateRunRuntime,
		};
	} catch { return undefined; }
}

export function findRunByAdmission(root: string, cwd: string, admissionKey: string): { spec: DelegateRunSpec; runtime: DelegateRunRuntime } | undefined {
	const index = readAdmissionIndex(root, cwd, admissionKey);
	if (!index?.runId) return undefined;
	const run = readRun(root, index.runId);
	if (!run) {
		if (!isPidAlive(index.ownerPid)) rmSync(admissionIndexPath(root, cwd, admissionKey), { force: true });
		return undefined;
	}
	if (path.resolve(run.spec.cwd) !== path.resolve(cwd) || run.spec.admissionKey !== admissionKey) throw new Error(`Delegate admission index is inconsistent: ${admissionKey}`);
	return run;
}

export function reserveAdmission(root: string, cwd: string, admissionKey: string, runId: string): boolean {
	const file = admissionIndexPath(root, cwd, admissionKey);
	mkdirSync(path.dirname(file), { recursive: true });
	try {
		writeFileSync(file, `${JSON.stringify({ cwd: path.resolve(cwd), admissionKey, runId, ownerPid: process.pid, reservedAt: Date.now() })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export function removeAdmission(root: string, cwd: string, admissionKey: string, runId: string): void {
	const file = admissionIndexPath(root, cwd, admissionKey);
	const index = readAdmissionIndex(root, cwd, admissionKey);
	if (index?.runId === runId) rmSync(file, { force: true });
}

export function releaseAdmissionReservation(root: string, cwd: string, admissionKey: string): void {
	const file = admissionIndexPath(root, cwd, admissionKey);
	const index = readAdmissionIndex(root, cwd, admissionKey);
	if (index?.ownerPid === process.pid && (!index.runId || !readRun(root, index.runId))) rmSync(file, { force: true });
}

function readAdmissionIndex(root: string, cwd: string, admissionKey: string): { runId?: string; ownerPid?: number } | undefined {
	const file = admissionIndexPath(root, cwd, admissionKey);
	if (!existsSync(file)) return undefined;
	const value = JSON.parse(readFileSync(file, "utf8")) as { cwd?: unknown; admissionKey?: unknown; runId?: unknown; ownerPid?: unknown };
	if (value.cwd !== path.resolve(cwd) || value.admissionKey !== admissionKey || (value.runId !== undefined && typeof value.runId !== "string") || (value.ownerPid !== undefined && (!Number.isInteger(value.ownerPid) || (value.ownerPid as number) <= 0))) throw new Error(`Invalid delegate admission index: ${admissionKey}`);
	return { runId: value.runId as string | undefined, ownerPid: value.ownerPid as number | undefined };
}

function isPidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function admissionIndexPath(root: string, cwd: string, admissionKey: string): string {
	const id = createHash("sha256").update(path.resolve(cwd)).update("\0").update(admissionKey).digest("hex");
	return path.join(root, "admissions", `${id}.json`);
}

export function findLatestSessionFile(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	let latest: { path: string; mtimeMs: number } | undefined;
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const mtimeMs = statSync(child).mtimeMs;
				if (!latest || mtimeMs > latest.mtimeMs) latest = { path: child, mtimeMs };
			}
		}
	};
	visit(sessionDir);
	return latest?.path;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, filePath);
}
