import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { HOSTED_AUTO_MAX_COLLABORATORS } from "./hosted-types.ts";

export const AUTO_MAX_CONCURRENT_STARTS = 4;
export const AUTO_MAX_LIVE_COLLABORATORS = HOSTED_AUTO_MAX_COLLABORATORS;
const MAX_STATE_BYTES = 4 * 1024;
const MAX_KEYBINDINGS_BYTES = 64 * 1024;
const THINKING_ACTION = "app.thinking.cycle";
const AUTO_KEY = "shift+tab";
const THINKING_KEY = "ctrl+shift+t";

export interface CollaboratorAutoState {
	version: 1;
	enabled: boolean;
	maxConcurrentStarts: 4;
	maxLiveCollaborators: 12;
	profileCeiling: "workspace-write";
	updatedAt: number;
	generation: string;
}

export class CollaboratorAutoStore {
	readonly statePath: string;
	readonly keybindingsPath: string;
	private readonly lockPath: string;

	constructor(readonly runtimeRoot: string) {
		this.statePath = join(runtimeRoot, "auto-mode.v1.json");
		this.lockPath = join(runtimeRoot, "auto-start.lock");
		this.keybindingsPath = join(dirname(runtimeRoot), "keybindings.json");
	}

	read() {
		if (!existsSync(this.statePath)) return { state: manualState(), valid: true };
		try {
			return { state: parseState(readJson(this.statePath, MAX_STATE_BYTES)), valid: true };
		} catch (error) {
			return { state: manualState(), valid: false, error: message(error) };
		}
	}

	set(enabled: boolean): CollaboratorAutoState {
		const state: CollaboratorAutoState = { version: 1, enabled, maxConcurrentStarts: 4, maxLiveCollaborators: 12, profileCeiling: "workspace-write", updatedAt: Date.now(), generation: `auto_${randomUUID()}` };
		writeAtomic(this.runtimeRoot, this.statePath, state, MAX_STATE_BYTES);
		return state;
	}

	toggle(): CollaboratorAutoState {
		const current = this.read();
		if (!current.valid) throw new Error("Auto mode state is invalid; recover explicitly with /runtime auto on or /runtime auto off.");
		return this.set(!current.state.enabled);
	}

	shortcutConfigured(): boolean {
		try {
			const config = readKeybindings(this.keybindingsPath);
			const thinking = keys(config[THINKING_ACTION]);
			return !!thinking && hasKey(thinking, THINKING_KEY) && !hasKey(thinking, AUTO_KEY) && !Object.entries(config).some(([action, value]) => action !== THINKING_ACTION && (hasKey(keys(value), AUTO_KEY) || hasKey(keys(value), THINKING_KEY)));
		} catch { return false; }
	}

	configureShortcut() {
		const config = readKeybindings(this.keybindingsPath);
		for (const [action, value] of Object.entries(config)) {
			if (action === THINKING_ACTION) continue;
			const assigned = keys(value);
			if (!assigned) throw new Error(`Invalid keybinding value for ${action}.`);
			if (hasKey(assigned, AUTO_KEY)) throw new Error(`${AUTO_KEY} is already assigned to ${action}.`);
			if (hasKey(assigned, THINKING_KEY)) throw new Error(`${THINKING_KEY} is already assigned to ${action}.`);
		}
		const current = config[THINKING_ACTION] === undefined ? [AUTO_KEY] : keys(config[THINKING_ACTION]);
		if (!current) throw new Error(`Invalid keybinding value for ${THINKING_ACTION}.`);
		const next = unique([...current.filter((key) => !hasKey([key], AUTO_KEY) && !hasKey([key], THINKING_KEY)), THINKING_KEY]);
		if (JSON.stringify(config[THINKING_ACTION]) === JSON.stringify(next)) return { path: this.keybindingsPath, changed: false };
		config[THINKING_ACTION] = next;
		writeAtomic(dirname(this.keybindingsPath), this.keybindingsPath, config, MAX_KEYBINDINGS_BYTES);
		return { path: this.keybindingsPath, changed: true };
	}

	async acquireStartLock(): Promise<() => void> {
		mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
		const token = `lock_${randomUUID()}`;
		const temporary = `${this.lockPath}.${token}.tmp`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify({ token, pid: process.pid })}\n`);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			try { linkSync(temporary, this.lockPath); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Auto collaborator start is already in progress; stale locks fail closed and require explicit operator removal.");
				throw error;
			}
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
			try { unlinkSync(temporary); } catch {}
		}
		return () => {
			const owner = lockOwner(this.lockPath);
			if (owner?.token === token) try { unlinkSync(this.lockPath); } catch {}
		};
	}

	recoverStartLock(): boolean {
		if (!existsSync(this.lockPath)) return false;
		if (lstatSync(this.lockPath).isSymbolicLink()) throw new Error("Auto start lock is a symbolic link; refusing recovery.");
		const owner = lockOwner(this.lockPath);
		if (!owner) throw new Error("Auto start lock is malformed; inspect it before manual recovery.");
		if (owner.pid !== process.pid) {
			let live = true;
			try { process.kill(owner.pid, 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false;
				else throw error;
			}
			if (live) throw new Error(`Auto start lock owner PID ${owner.pid} is still live; refusing recovery.`);
		}
		unlinkSync(this.lockPath);
		return true;
	}

	async withStartLock<T>(operation: () => Promise<T>): Promise<T> {
		const release = await this.acquireStartLock();
		try { return await operation(); } finally { release(); }
	}
}

function manualState(): CollaboratorAutoState {
	return { version: 1, enabled: false, maxConcurrentStarts: 4, maxLiveCollaborators: 12, profileCeiling: "workspace-write", updatedAt: 0, generation: "auto_manual_default" };
}

function parseState(value: unknown): CollaboratorAutoState {
	const record = object(value);
	const allowed = new Set(["version", "enabled", "maxConcurrentStarts", "maxLiveCollaborators", "profileCeiling", "updatedAt", "generation"]);
	if (!record || Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1 || typeof record.enabled !== "boolean" || record.maxConcurrentStarts !== 4 || record.maxLiveCollaborators !== 12 || record.profileCeiling !== "workspace-write" || typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt) || typeof record.generation !== "string" || !/^auto_[A-Za-z0-9_-]+$/.test(record.generation)) throw new Error("Auto mode state is invalid.");
	return record as unknown as CollaboratorAutoState;
}

function lockOwner(path: string): { token: string; pid: number; identity?: string } | undefined {
	try {
		const value = object(readJson(path, MAX_STATE_BYTES));
		return value && typeof value.token === "string" && Number.isInteger(value.pid) && (value.pid as number) > 0 && (value.identity === undefined || typeof value.identity === "string") ? value as unknown as { token: string; pid: number; identity?: string } : undefined;
	} catch { return undefined; }
}

function readKeybindings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const value = object(readJson(path, MAX_KEYBINDINGS_BYTES));
	if (!value) throw new Error("Pi keybindings must be a JSON object.");
	return value;
}

function readJson(path: string, maxBytes: number): unknown {
	if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
	const bytes = readFileSync(path);
	if (bytes.length > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes.`);
	return JSON.parse(bytes.toString("utf8"));
}

function writeAtomic(root: string, path: string, value: unknown, maxBytes: number): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content) > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes.`);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
		const directory = openSync(root, "r");
		try { fsyncSync(directory); } finally { closeSync(directory); }
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try { unlinkSync(temporary); } catch {}
	}
}

function keys(value: unknown): string[] | undefined {
	if (typeof value === "string" && value.trim()) return [value];
	if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) return value as string[];
	return undefined;
}
function hasKey(values: string[] | undefined, key: string): boolean { return !!values?.some((value) => value.trim().toLowerCase() === key); }
function unique(values: string[]): string[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = value.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
