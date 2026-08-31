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

interface PersistedAutoState {
	version?: number | null;
	enabled?: boolean | null;
	maxConcurrentStarts?: number | null;
	maxLiveCollaborators?: number | null;
	profileCeiling?: string | null;
	updatedAt?: number | null;
	generation?: string | null;
}

interface PersistedLockOwner {
	token?: string | null;
	pid?: number | null;
	identity?: string | null;
}

type PersistedKeybindingValue = string | string[] | null;
type PersistedKeybindings = Record<string, PersistedKeybindingValue>;

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
			return { state: manualState(), valid: false, error: error instanceof Error ? error.message : String(error) };
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
				if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Another Auto collaborator start is already in progress; stale locks fail closed and require explicit operator removal.");
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
				if (error instanceof Error && "code" in error && error.code === "ESRCH") live = false;
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

function parseState(value: PersistedAutoState | null): CollaboratorAutoState {
	const allowed = new Set(["version", "enabled", "maxConcurrentStarts", "maxLiveCollaborators", "profileCeiling", "updatedAt", "generation"]);
	if (!value || value.constructor !== Object || Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1 || !isBoolean(value.enabled) || value.maxConcurrentStarts !== 4 || value.maxLiveCollaborators !== 12 || value.profileCeiling !== "workspace-write" || !isFiniteNumber(value.updatedAt) || !isString(value.generation) || !/^auto_[A-Za-z0-9_-]+$/.test(value.generation)) throw new Error("Auto mode state is invalid.");
	return { version: 1, enabled: value.enabled, maxConcurrentStarts: 4, maxLiveCollaborators: 12, profileCeiling: "workspace-write", updatedAt: value.updatedAt, generation: value.generation };
}

function lockOwner(path: string): { token: string; pid: number; identity?: string } | undefined {
	try {
		const value = readJson<PersistedLockOwner | null>(path, MAX_STATE_BYTES);
		if (!value || value.constructor !== Object || !isString(value.token) || !isPositiveInteger(value.pid) || (value.identity !== undefined && !isString(value.identity))) return undefined;
		const owner = { token: value.token, pid: value.pid };
		return value.identity === undefined ? owner : { ...owner, identity: value.identity };
	} catch { return undefined; }
}

function readKeybindings(path: string): PersistedKeybindings {
	if (!existsSync(path)) return {};
	const value = readJson<PersistedKeybindings | null>(path, MAX_KEYBINDINGS_BYTES);
	if (!value || value.constructor !== Object) throw new Error("Pi keybindings must be a JSON object.");
	return value;
}

function readJson<Value>(path: string, maxBytes: number): Value {
	if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
	const bytes = readFileSync(path);
	if (bytes.length > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes.`);
	// SAFETY: Callers request only persisted input contracts and validate them before constructing trusted domain values.
	return JSON.parse(bytes.toString("utf8")) as Value;
}

function writeAtomic(root: string, path: string, value: CollaboratorAutoState | PersistedKeybindings, maxBytes: number): void {
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

function keys(value: PersistedKeybindingValue | undefined): string[] | undefined {
	if (nonEmptyString(value)) return [value];
	if (Array.isArray(value) && value.every(nonEmptyString)) return value;
	return undefined;
}
function nonEmptyString(value: PersistedKeybindingValue | undefined): value is string {
	return value !== undefined && value !== null && value.constructor === String && String.prototype.trim.call(value).length > 0;
}
function isBoolean(value: boolean | null | undefined): value is boolean { return value === true || value === false; }
function isFiniteNumber(value: number | null | undefined): value is number { return Number.isFinite(value); }
function isPositiveInteger(value: number | null | undefined): value is number { return Number.isInteger(value) && Number(value) > 0; }
function isString(value: string | null | undefined): value is string { return value !== undefined && value !== null && value.constructor === String; }
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
