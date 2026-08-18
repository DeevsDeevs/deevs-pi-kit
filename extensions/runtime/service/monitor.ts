import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { HOSTED_MONITOR_MAX_ENTRIES, type HostedEvent, type HostedFileObservation, type HostedMonitor } from "../hosted-types.ts";
import { HostedStateStore } from "./state.ts";

const DEFAULT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 25;

export class MonitorInputError extends Error {
	readonly code = "invalid_request" as const;
}

export class MonitorLimitError extends Error {
	readonly code = "storage_error" as const;
}

export interface DirectoryMonitorOptions {
	now?: () => number;
	automatic?: boolean;
	scanIntervalMs?: number;
	watchDebounceMs?: number;
	createId?: (prefix: "mon" | "gen") => string;
	onEvents?: (targetKey: string) => void;
	onError?: (error: unknown) => void;
}

export class DirectoryMonitorManager {
	private readonly store: HostedStateStore;
	private readonly options: DirectoryMonitorOptions;
	private readonly watchers = new Map<string, FSWatcher>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private scanTimer?: NodeJS.Timeout;
	private started = false;

	constructor(store: HostedStateStore, options: DirectoryMonitorOptions = {}) {
		this.store = store;
		this.options = options;
	}

	start(): void {
		if (this.started || this.options.automatic === false) return;
		this.started = true;
		for (const monitor of Object.values(this.store.read().monitors)) this.reconcileSafely(monitor.monitorId);
		this.scanTimer = setInterval(() => this.reconcileAll(), this.options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
		this.scanTimer.unref?.();
	}

	close(): void {
		if (this.scanTimer) clearInterval(this.scanTimer);
		this.scanTimer = undefined;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
		this.started = false;
	}

	create(targetKey: string, directory: string, settleMs = 250): HostedMonitor {
		if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 60_000) throw new MonitorInputError("settleMs must be an integer from 0 to 60000.");
		const target = this.store.read().targets[targetKey];
		if (!target) throw new MonitorInputError("Unknown runtime target.");
		const canonicalDirectory = canonicalMonitorRoot(directory);
		if (!inside(target.projectRoot, canonicalDirectory)) throw new MonitorInputError("Monitor directory must stay within the registered project root.");
		const existing = Object.values(this.store.read().monitors).find((monitor) => monitor.targetKey === targetKey);
		if (existing?.directory === canonicalDirectory) return existing;
		const now = this.now();
		const current = scanRegularFiles(canonicalDirectory);
		if (current.size > HOSTED_MONITOR_MAX_ENTRIES) throw new MonitorLimitError(`Monitor baseline exceeds ${HOSTED_MONITOR_MAX_ENTRIES} entries.`);
		const entries: Record<string, HostedFileObservation> = {};
		for (const [relativePath, file] of current) entries[relativePath] = { relativePath, ...file, stableSince: now, present: true, emitted: true };
		const monitor: HostedMonitor = {
			monitorId: this.createId("mon"),
			targetKey,
			generation: this.createId("gen"),
			directory: canonicalDirectory,
			settleMs,
			status: "watching",
			sequence: 0,
			entries,
			createdAt: now,
			updatedAt: now,
		};
		const state = this.store.apply({ type: "monitor.create", monitor });
		const created = Object.values(state.monitors).find((candidate) => candidate.targetKey === targetKey)!;
		if (this.started) this.ensureWatcher(created);
		return created;
	}

	get(targetKey: string): HostedMonitor | undefined {
		return Object.values(this.store.read().monitors).find((monitor) => monitor.targetKey === targetKey);
	}

	delete(targetKey: string, monitorId: string): void {
		this.store.apply({ type: "monitor.delete", targetKey, monitorId });
		this.stopMonitor(monitorId);
	}

	reconcile(monitorId: string): HostedMonitor | undefined {
		const currentMonitor = this.store.read().monitors[monitorId];
		if (!currentMonitor) return undefined;
		const now = this.now();
		let files: Map<string, { size: number; mtimeMs: number }>;
		try {
			files = scanRegularFiles(currentMonitor.directory);
		} catch {
			this.stopWatcher(monitorId);
			if (currentMonitor.status === "degraded") return currentMonitor;
			const degraded = { ...currentMonitor, status: "degraded" as const, updatedAt: now };
			this.store.apply({ type: "monitor.commit", monitor: degraded, events: [] });
			return degraded;
		}

		const entries = structuredClone(currentMonitor.entries);
		for (const entry of Object.values(entries)) if (entry.present && !files.has(entry.relativePath)) {
			entry.present = false;
			entry.stableSince = now;
		}
		for (const [relativePath, file] of files) {
			const previous = entries[relativePath];
			if (!previous) {
				entries[relativePath] = { relativePath, ...file, stableSince: now, present: true, emitted: false };
				continue;
			}
			if (!previous.present || previous.size !== file.size || previous.mtimeMs !== file.mtimeMs) {
				entries[relativePath] = { ...previous, ...file, stableSince: now, present: true };
			}
		}
		if (Object.keys(entries).length > HOSTED_MONITOR_MAX_ENTRIES) throw new MonitorLimitError(`Monitor cursor exceeds ${HOSTED_MONITOR_MAX_ENTRIES} entries.`);

		let sequence = currentMonitor.sequence;
		const events: HostedEvent[] = [];
		for (const entry of Object.values(entries).sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
			if (!entry.present || entry.emitted || now - entry.stableSince < currentMonitor.settleMs) continue;
			entry.emitted = true;
			sequence++;
			events.push(createdEvent(currentMonitor, entry, sequence, now));
		}
		const changed = currentMonitor.status !== "watching" || sequence !== currentMonitor.sequence || !sameObservations(entries, currentMonitor.entries);
		const monitor: HostedMonitor = changed ? { ...currentMonitor, status: "watching", sequence, entries, updatedAt: now } : currentMonitor;
		if (changed) {
			this.store.apply({ type: "monitor.commit", monitor, events });
			if (events.length > 0) this.options.onEvents?.(monitor.targetKey);
		}
		if (this.started) {
			this.ensureWatcher(monitor);
			const nextSettle = nextSettleDelay(monitor, now);
			if (nextSettle !== undefined) this.schedule(monitor.monitorId, nextSettle);
		}
		return monitor;
	}

	private reconcileAll(): void {
		for (const monitor of Object.values(this.store.read().monitors)) this.reconcileSafely(monitor.monitorId);
	}

	private reconcileSafely(monitorId: string): void {
		try { this.reconcile(monitorId); } catch (error) { this.options.onError?.(error); }
	}

	private ensureWatcher(monitor: HostedMonitor): void {
		if (this.watchers.has(monitor.monitorId)) return;
		try {
			const watcher = watch(monitor.directory, () => this.schedule(monitor.monitorId, this.options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS));
			watcher.once("error", (error) => {
				if (this.watchers.get(monitor.monitorId) === watcher) this.stopWatcher(monitor.monitorId);
				this.options.onError?.(error);
			});
			watcher.once("close", () => {
				if (this.watchers.get(monitor.monitorId) === watcher) this.watchers.delete(monitor.monitorId);
			});
			this.watchers.set(monitor.monitorId, watcher);
		} catch (error) {
			this.options.onError?.(error);
		}
	}

	private schedule(monitorId: string, delayMs: number): void {
		// ponytail: one timer may delay a newer hint until that timer or the 5 s scan; track deadlines only if measured latency needs it.
		if (this.timers.has(monitorId)) return;
		const timer = setTimeout(() => {
			this.timers.delete(monitorId);
			this.reconcileSafely(monitorId);
		}, Math.max(1, delayMs));
		timer.unref?.();
		this.timers.set(monitorId, timer);
	}

	private stopMonitor(monitorId: string): void {
		this.stopWatcher(monitorId);
		const timer = this.timers.get(monitorId);
		if (timer) clearTimeout(timer);
		this.timers.delete(monitorId);
	}

	private stopWatcher(monitorId: string): void {
		const watcher = this.watchers.get(monitorId);
		this.watchers.delete(monitorId);
		try { watcher?.close(); } catch {}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private createId(prefix: "mon" | "gen"): string {
		return this.options.createId?.(prefix) ?? `${prefix}_${randomUUID()}`;
	}
}

function canonicalMonitorRoot(directory: string): string {
	const absolute = resolve(directory);
	let info;
	try { info = lstatSync(absolute); } catch { throw new MonitorInputError("Monitor directory does not exist."); }
	if (info.isSymbolicLink() || !info.isDirectory()) throw new MonitorInputError("Monitor root must be a real directory, not a symlink.");
	return realpathSync(absolute);
}

function scanRegularFiles(directory: string): Map<string, { size: number; mtimeMs: number }> {
	const root = lstatSync(directory);
	if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Monitor root is unavailable.");
	const files = new Map<string, { size: number; mtimeMs: number }>();
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.isSymbolicLink()) continue;
		try {
			const info = lstatSync(join(directory, entry.name));
			if (!info.isSymbolicLink() && info.isFile()) files.set(entry.name, { size: info.size, mtimeMs: info.mtimeMs });
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
	}
	return files;
}

function createdEvent(monitor: HostedMonitor, entry: HostedFileObservation, sequence: number, now: number): HostedEvent {
	const key = `${monitor.monitorId}\0${monitor.generation}\0${sequence}\0${entry.relativePath}`;
	return {
		version: 1,
		eventId: `evt_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
		dedupeKey: `${monitor.monitorId}:${monitor.generation}:${entry.relativePath}`,
		source: { kind: "monitor", id: monitor.monitorId, generation: monitor.generation, sequence },
		targetKey: monitor.targetKey,
		type: "filesystem.created",
		createdAt: now,
		summary: `new file: ${entry.relativePath}`,
		payload: {
			relativePath: entry.relativePath,
			path: join(monitor.directory, entry.relativePath),
			fileType: "regular",
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		},
		delivery: { status: "pending" },
	};
}

function sameObservations(left: Record<string, HostedFileObservation>, right: Record<string, HostedFileObservation>): boolean {
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	return leftKeys.every((key) => {
		const a = left[key];
		const b = right[key];
		return !!a && !!b
			&& a.relativePath === b.relativePath
			&& a.size === b.size
			&& a.mtimeMs === b.mtimeMs
			&& a.stableSince === b.stableSince
			&& a.present === b.present
			&& a.emitted === b.emitted;
	});
}

function nextSettleDelay(monitor: HostedMonitor, now: number): number | undefined {
	let next: number | undefined;
	for (const entry of Object.values(monitor.entries)) {
		if (!entry.present || entry.emitted) continue;
		const remaining = monitor.settleMs - (now - entry.stableSince);
		next = next === undefined ? remaining : Math.min(next, remaining);
	}
	return next;
}

function inside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
