import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AlertPolicy, ProcessBackend, WatchSpec } from "./types.ts";

export interface PersistentWatchRecord extends WatchSpec {
	fired?: boolean;
	lastTriggeredAt?: number;
}

export interface PersistentProcessRecord {
	id: string;
	name: string;
	command: string | null;
	argv: string[] | null;
	cwd: string;
	backend: ProcessBackend;
	tmuxSession: string | null;
	startedAt: number;
	alertPolicy: AlertPolicy;
	watches: PersistentWatchRecord[];
}

export interface ProcessStateFile {
	version: 1;
	processes: PersistentProcessRecord[];
}

export function getStateFile(cwd: string): string {
	const root = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const project = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(root, "process-state", `${project}.json`);
}

export async function readStateFile(path: string): Promise<ProcessStateFile> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as ProcessStateFile;
		if (parsed.version !== 1 || !Array.isArray(parsed.processes)) return { version: 1, processes: [] };
		return parsed;
	} catch {
		return { version: 1, processes: [] };
	}
}

export async function writeStateFile(path: string, state: ProcessStateFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
