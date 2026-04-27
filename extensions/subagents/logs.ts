import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AgentGroupRecord, AgentRunRecord } from "./types.ts";

export function agentRoot(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function projectHash(cwd: string): string {
	return createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

export function subagentRunsRoot(cwd: string): string {
	return path.join(agentRoot(), "subagent-runs", projectHash(cwd));
}

export function createRunArtifactsDir(cwd: string, id: string): string {
	const dir = path.join(subagentRunsRoot(cwd), id);
	mkdirSync(dir, { recursive: true });
	mkdirSync(path.join(dir, "session"), { recursive: true });
	return dir;
}

export function writeTextFile(filePath: string, content: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
}

export function writeJsonFile(filePath: string, value: unknown): void {
	writeTextFile(filePath, `${JSON.stringify(value, replacer, 2)}\n`);
}

export function readTextTail(filePath: string, maxBytes: number): string {
	if (!existsSync(filePath)) return "";
	const text = readFileSync(filePath, "utf-8");
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let tail = text.slice(-maxBytes);
	while (Buffer.byteLength(tail) > maxBytes) tail = tail.slice(1);
	return `[truncated from start]\n${tail}`;
}

export function deleteArtifacts(record: AgentRunRecord | AgentGroupRecord): void {
	rmSync(record.artifactsDir, { recursive: true, force: true });
}

function replacer(_key: string, value: unknown): unknown {
	if (typeof value === "function") return undefined;
	if (value instanceof Error) return { message: value.message, stack: value.stack };
	return value;
}
