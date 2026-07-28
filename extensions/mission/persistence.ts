import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missionDir, missionRoot } from "./artifacts.ts";
import type { MissionCurrent, MissionOwner, MissionProgressRecord, MissionSnapshot, MissionUsage } from "./types.ts";

const SNAPSHOT_VERSION = 1;
// Lock holds are synchronous sub-second operations, so a lock older than this — or one whose owner pid is gone — is a crashed holder, not live contention.
const STALE_LOCK_MS = 30_000;
const STATUSES = new Set(["active", "paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "complete", "ended", "cleared"]);
const REVIEW_STATUSES = new Set(["not_required", "due", "running", "awaiting_adjudication", "changes_requested", "clear", "skipped"]);

export function readMissionSnapshot(cwd: string, slug: string): MissionSnapshot | undefined {
	if (!validSlug(slug)) throw new Error(`Invalid Mission slug: ${slug}`);
	const stateDir = stateDirectory(cwd);
	if (!pathExists(stateDir)) return undefined;
	validateStateDirectories(cwd);
	const file = snapshotPath(cwd, slug);
	if (!pathExists(file)) return undefined;
	const snapshot = validateSnapshot(readJsonFile(file, "Mission state"), cwd, slug);
	validateStateDirectories(cwd);
	return snapshot;
}

export function listMissionSnapshots(cwd: string): MissionSnapshot[] {
	const stateDir = stateDirectory(cwd);
	if (!pathExists(stateDir)) return [];
	validateStateDirectories(cwd);
	const snapshots: MissionSnapshot[] = [];
	for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
		if (entry.isSymbolicLink() && entry.name.endsWith(".json")) throw new Error(`Mission state path is not a real file: ${join(stateDir, entry.name)}`);
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const slug = entry.name.slice(0, -5);
		if (!validSlug(slug)) throw new Error(`Invalid Mission state filename: ${entry.name}`);
		const snapshot = readMissionSnapshot(cwd, slug);
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots.sort((a, b) => b.mission.updatedAt - a.mission.updatedAt);
}

export function withMissionLock<T>(cwd: string, slug: string, operation: () => T): T {
	if (!validSlug(slug)) throw new Error(`Invalid Mission slug: ${slug}`);
	const stateDir = prepareStateDirectory(cwd);
	const locks = join(stateDir, ".locks");
	ensureDirectory(locks);
	return withLockPath(join(locks, slug), `Mission state is busy: ${slug}`, operation);
}

export function withMissionWorkspaceLock<T>(cwd: string, operation: () => T): T {
	const stateDir = prepareStateDirectory(cwd);
	return withLockPath(join(stateDir, ".workspace-lock"), "Mission workspace admission is busy.", operation);
}

export function writeMissionSnapshot(cwd: string, snapshot: MissionSnapshot): void {
	const validated = validateSnapshot(snapshot, cwd, snapshot.mission.slug);
	const stateDir = prepareStateDirectory(cwd);
	writeAtomicJson(snapshotPath(cwd, validated.mission.slug), validated);
	try { fsyncDirectory(stateDir); } catch { /* Rename is the commit boundary; durability sync is best-effort on unsupported filesystems. */ }
}

export function currentMissionOwner(ctx: { sessionManager: { getSessionId?: () => string; getSessionFile?: () => string | undefined } }): MissionOwner | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	const sessionId = ctx.sessionManager.getSessionId?.();
	return sessionFile && sessionId ? { sessionId, sessionFile } : undefined;
}

function snapshotPath(cwd: string, slug: string): string {
	if (!validSlug(slug)) throw new Error(`Invalid Mission slug: ${slug}`);
	return join(stateDirectory(cwd), `${slug}.json`);
}

function stateDirectory(cwd: string): string {
	return join(missionRoot(cwd), ".state");
}

function prepareStateDirectory(cwd: string): string {
	const root = missionRoot(cwd);
	const state = stateDirectory(cwd);
	ensureDirectory(root);
	ensureDirectory(state);
	return state;
}

function validateStateDirectories(cwd: string): void {
	for (const directory of [missionRoot(cwd), stateDirectory(cwd)]) {
		const info = lstatSync(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Mission state path is not a real directory: ${directory}`);
	}
}

function ensureDirectory(directory: string): void {
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
	}
	const info = lstatSync(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Mission state path is not a real directory: ${directory}`);
}

function withLockPath<T>(lock: string, busyMessage: string, operation: () => T): T {
	acquireLock(lock, busyMessage);
	try {
		return operation();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function acquireLock(lock: string, busyMessage: string): void {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { encoding: "utf8", mode: 0o600 }); } catch { /* the directory itself is the lock; owner metadata only aids stale recovery. */ }
			return;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		}
		// A crashed holder leaves the lock dir forever; reclaim it so a SIGKILL cannot permanently brick the Mission. Reclaim is an atomic rename-aside — only one racer's rename wins, losers get ENOENT and simply retry mkdir, so exclusion holds.
		if (!reclaimIfStale(lock)) throw new Error(busyMessage);
	}
	throw new Error(busyMessage);
}

function reclaimIfStale(lock: string): boolean {
	let stale: boolean;
	try {
		const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid?: unknown; startedAt?: unknown };
		const startedAt = typeof owner.startedAt === "number" ? owner.startedAt : statSync(lock).mtimeMs;
		stale = !isPidAlive(owner.pid) || Date.now() - startedAt >= STALE_LOCK_MS;
	} catch {
		// Missing owner.json is the tiny window between mkdir and the metadata write, so fall back to directory age; a vanished lock just means retry mkdir.
		try { stale = Date.now() - statSync(lock).mtimeMs >= STALE_LOCK_MS; } catch { return true; }
	}
	if (!stale) return false;
	const aside = `${lock}.stale.${process.pid}.${randomUUID()}`;
	try { renameSync(lock, aside); } catch { return true; }
	try { rmSync(aside, { recursive: true, force: true }); } catch { /* the reclaimed corpse is inert; a leftover is harmless litter. */ }
	return true;
}

function isPidAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return isNodeError(error) && error.code === "EPERM"; }
}

function writeAtomicJson(file: string, value: unknown): void {
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, file);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temp); } catch {}
		throw error;
	}
}

function fsyncDirectory(directory: string): void {
	const fd = openSync(directory, constants.O_RDONLY);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readJsonFile(file: string, name: string): unknown {
	if (!pathExists(file)) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!fstatSync(fd).isFile()) throw new Error(`${name} path is not a real file: ${file}`);
		return JSON.parse(readFileSync(fd, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${name} is malformed: ${file}`);
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function validateSnapshot(value: unknown, cwd: string, expectedSlug: string): MissionSnapshot {
	const record = object(value, "Mission snapshot");
	if (record.version !== SNAPSHOT_VERSION || !integer(record.revision, 0)) throw new Error("Unsupported Mission snapshot version or revision.");
	const ownerValue = object(record.owner, "Mission owner");
	const owner: MissionOwner = { sessionId: text(ownerValue.sessionId, "owner session id", 200), sessionFile: text(ownerValue.sessionFile, "owner session file", 2_000) };
	const rawMission = object(record.mission, "Mission");
	const slug = text(rawMission.slug, "Mission slug", 120);
	if (slug !== expectedSlug || !validSlug(slug)) throw new Error("Mission snapshot slug does not match its directory.");
	const mission = validateMission(rawMission, cwd, slug);
	const progress = array(record.progress, "Mission progress", 10_000).map(validateProgress);
	const continuationProgressIndex = number(record.continuationProgressIndex, "continuation progress index");
	if (!Number.isInteger(continuationProgressIndex) || continuationProgressIndex < 0 || continuationProgressIndex > progress.length) throw new Error("Invalid Mission continuation progress index.");
	return {
		version: 1,
		revision: record.revision as number,
		owner,
		mission,
		progress,
		continuationProgressIndex,
		carriedUsage: validateUsage(record.carriedUsage),
		usage: validateUsage(record.usage),
		reviewFailureCount: boundedInteger(record.reviewFailureCount, "review failure count", 0, 1_000_000),
		usageComplete: record.usageComplete === true,
	};
}

function validateMission(value: Record<string, unknown>, cwd: string, slug: string): MissionCurrent {
	const status = text(value.status, "Mission status", 40);
	if (!STATUSES.has(status)) throw new Error(`Invalid Mission status: ${status}`);
	const reviewStatus = value.reviewStatus === undefined ? undefined : text(value.reviewStatus, "Mission review status", 40);
	if (reviewStatus && !REVIEW_STATUSES.has(reviewStatus)) throw new Error(`Invalid Mission review status: ${reviewStatus}`);
	const mission: MissionCurrent = {
		missionId: text(value.missionId, "Mission id", 200),
		objective: text(value.objective, "Mission objective", 20_000),
		title: text(value.title, "Mission title", 80),
		requirements: stringArray(value.requirements, "Mission requirements", 12, 240),
		status: status as MissionCurrent["status"],
		createdAt: number(value.createdAt, "Mission createdAt"),
		updatedAt: number(value.updatedAt, "Mission updatedAt"),
		slug,
		chain: text(value.chain, "Mission Chain", 120),
		chainBranch: text(value.chainBranch, "Mission Chain branch", 120),
		artifactDir: missionDir(cwd, slug),
		paths: stringArray(value.paths, "Mission paths", 100, 2_000),
		baselineMainTokens: nonnegative(value.baselineMainTokens, "baseline main tokens"),
		baselineSubagentTokens: nonnegative(value.baselineSubagentTokens, "baseline Subagent tokens"),
		baselineMainCostUsd: nonnegative(value.baselineMainCostUsd, "baseline main cost"),
		baselineSubagentCostUsd: nonnegative(value.baselineSubagentCostUsd, "baseline Subagent cost"),
	};
	for (const key of ["tokenBudget", "costBudgetUsd", "turnBudget", "wallDeadlineAt", "objectiveVersion", "blockerCount", "turnCount"] as const) {
		if (value[key] !== undefined) (mission as unknown as Record<string, unknown>)[key] = nonnegative(value[key], key);
	}
	for (const key of ["lastReason", "lastSummary", "generation", "reviewRunId", "reviewReason", "reviewSkippedReason", "reviewSuggestedVerdict", "reviewWorktreeFingerprint", "admittedWorktreeFingerprint", "blockerFingerprint"] as const) {
		if (value[key] !== undefined) (mission as unknown as Record<string, unknown>)[key] = text(value[key], key, 20_000);
	}
	if (value.lastContinuationAt !== undefined) mission.lastContinuationAt = number(value.lastContinuationAt, "lastContinuationAt");
	if (reviewStatus) mission.reviewStatus = reviewStatus as MissionCurrent["reviewStatus"];
	if (value.reviewFailure !== undefined) mission.reviewFailure = value.reviewFailure === true;
	return mission;
}

function validateProgress(value: unknown): MissionProgressRecord {
	const record = object(value, "Mission progress record");
	return {
		missionId: text(record.missionId, "progress Mission id", 200),
		at: number(record.at, "progress timestamp"),
		summary: text(record.summary, "progress summary", 1_200),
		evidence: stringArray(record.evidence, "progress evidence", 20, 500),
		remaining: stringArray(record.remaining, "progress remaining", 20, 500),
		validation: array(record.validation, "progress validation", 20).map((item) => {
			const validation = object(item, "validation record");
			return {
				command: text(validation.command, "validation command", 500),
				exitCode: boundedInteger(validation.exitCode, "validation exit code", -1_000_000, 1_000_000),
				objectiveVersion: boundedInteger(validation.objectiveVersion, "validation objective version", 1, 1_000_000),
				...(validation.summary === undefined ? {} : { summary: text(validation.summary, "validation summary", 500) }),
				...(validation.artifact === undefined ? {} : { artifact: text(validation.artifact, "validation artifact", 500) }),
			};
		}),
		checkpoint: record.checkpoint === true,
		blocked: record.blocked === true,
		...(record.blockerId === undefined ? {} : { blockerId: text(record.blockerId, "blocker id", 160) }),
	};
}

function validateUsage(value: unknown): MissionUsage {
	const record = object(value, "Mission usage");
	const mainTokens = nonnegative(record.mainTokens, "main tokens");
	const subagentTokens = nonnegative(record.subagentTokens, "Subagent tokens");
	const mainCostUsd = nonnegative(record.mainCostUsd, "main cost");
	const subagentCostUsd = nonnegative(record.subagentCostUsd, "Subagent cost");
	return {
		mainTokens,
		subagentTokens,
		totalTokens: mainTokens + subagentTokens,
		mainCostUsd,
		subagentCostUsd,
		totalCostUsd: mainCostUsd + subagentCostUsd,
	};
}

function validSlug(value: string): boolean {
	return !!value && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function array(value: unknown, name: string, max: number): unknown[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} items.`);
	return value;
}

function stringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
	return array(value, name, maxItems).map((item) => text(item, name, maxLength));
}

function text(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || !value || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
	return value;
}

function number(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite.`);
	return value;
}

function nonnegative(value: unknown, name: string): number {
	const result = number(value, name);
	if (result < 0) throw new Error(`${name} must be nonnegative.`);
	return result;
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
	const result = number(value, name);
	if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return result;
}

function integer(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min;
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; } catch { return false; }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
