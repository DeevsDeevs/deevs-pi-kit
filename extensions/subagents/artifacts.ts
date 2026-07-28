import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
	return {
		spec: JSON.parse(readFileSync(specPath, "utf8")) as DelegateRunSpec,
		runtime: JSON.parse(readFileSync(runtimePath, "utf8")) as DelegateRunRuntime,
	};
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
