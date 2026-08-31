import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missionDir, missionRoot } from "./artifacts.ts";
import { MAX_MISSION_REVIEW_ADJUDICATIONS } from "./types.ts";
import type { MissionCurrent, MissionOwner, MissionProgressRecord, MissionReviewCriticalImpact, MissionReviewFinding, MissionReviewRevision, MissionReviewSeverity, MissionReviewStatus, MissionSnapshot, MissionStatus, MissionUsage, MissionValidationRecord } from "./types.ts";

interface PersistedObject {
	[field: string]: PersistedValue;
}

type PersistedValue = string | number | boolean | null | PersistedObject | PersistedValue[];
type PersistedInput = PersistedValue | undefined;
type PersistedObjectInput = PersistedInput | MissionSnapshot;
type PersistedFields<Fields extends readonly string[]> = PersistedObject & Partial<Record<Fields[number], PersistedValue>>;

const SNAPSHOT_VERSION = 1;
// Lock holds are synchronous sub-second operations, so a lock older than this — or one whose owner pid is gone — is a crashed holder, not live contention.
const STATUSES = new Set<MissionStatus>(["active", "paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "complete", "ended", "cleared"]);
const REVIEW_STATUSES = new Set<MissionReviewStatus>(["not_required", "due", "starting", "running", "awaiting_adjudication", "changes_requested", "clear", "skipped"]);
const REVIEW_SEVERITIES = new Set<MissionReviewSeverity>(["blocker", "major", "minor", "nit"]);
const REVIEW_CRITICAL_IMPACTS = new Set<MissionReviewCriticalImpact>(["security", "data_loss"]);
const SNAPSHOT_FIELDS = ["version", "revision", "owner", "mission", "progress", "continuationProgressIndex", "carriedUsage", "usage", "reviewFailureCount", "usageComplete"] satisfies readonly (keyof MissionSnapshot)[];
const OWNER_FIELDS = ["sessionId", "sessionFile"] satisfies readonly (keyof MissionOwner)[];
const MISSION_FIELDS = [
	"missionId", "objective", "title", "requirements", "status", "createdAt", "updatedAt", "slug", "chain", "chainBranch", "artifactDir", "paths", "tokenBudget", "costBudgetUsd", "baselineMainTokens", "baselineSubagentTokens", "baselineMainCostUsd", "baselineSubagentCostUsd", "lastReason", "lastSummary", "lastContinuationAt", "generation", "objectiveVersion", "turnBudget", "wallDeadlineAt", "reviewStatus", "initialBaselinePending", "reviewUpdatedAt", "reviewRunId", "reviewAdmissionId", "reviewReason", "reviewSkippedReason", "reviewSuggestedVerdict", "reviewFailure", "reviewOutcome", "reviewNotBeforeAt", "reviewSupersessionCount", "reviewWorktreeFingerprint", "admittedWorktreeFingerprint", "reviewCandidateId", "reviewCandidateObjectiveVersion", "reviewAdjudicatedCandidateId", "reviewAdjudicatedVerdict", "reviewAdjudications", "reviewAdjudicationHistoryComplete", "reviewLegacyRelaunchAuthorized", "reviewHighestSeverity", "reviewBlockingFindingCount", "reviewBacklogFindingCount", "reviewFindings", "reviewAcceptedFindings", "reviewScopePaths", "reviewScopeRevisions", "reviewAcceptedRevisions", "reviewCorrectionCount", "reviewCorrectionLimit", "completionLatchCandidateId", "completionLatchReviewStatus", "completionId", "completionEffectsStatus", "completionAudit", "blockerFingerprint", "blockerCount", "turnCount",
] satisfies readonly (keyof MissionCurrent)[];
const PROGRESS_FIELDS = ["missionId", "at", "summary", "evidence", "remaining", "validation", "checkpoint", "blocked", "blockerId"] satisfies readonly (keyof MissionProgressRecord)[];
const VALIDATION_FIELDS = ["command", "exitCode", "objectiveVersion", "summary", "artifact"] as const;
const USAGE_FIELDS = ["mainTokens", "subagentTokens", "totalTokens", "mainCostUsd", "subagentCostUsd", "totalCostUsd"] satisfies readonly (keyof MissionUsage)[];
const ADJUDICATION_FIELDS = ["candidateId", "verdict"] as const;
const FINDING_FIELDS = ["index", "severity", "summary", "path", "line", "requirementIndex", "criticalImpact"] as const;
const REVISION_FIELDS = ["root", "base", "head"] as const;
const COMPLETION_AUDIT_FIELDS = ["requirementIndex", "evidence"] as const;
const LOCK_OWNER_FIELDS = ["pid", "startedAt"] as const;

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
		const candidate = `${lock}.candidate.${process.pid}.${randomUUID()}`;
		try {
			mkdirSync(candidate, { mode: 0o700 });
			writeFileSync(join(candidate, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { encoding: "utf8", mode: 0o600 });
			renameSync(candidate, lock);
			return;
		} catch (error) {
			rmSync(candidate, { recursive: true, force: true });
			if (!isNodeError(error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
		}
		// A crashed holder leaves the lock dir forever; reclaim it only when its published owner is provably dead.
		if (!reclaimIfStale(lock)) throw new Error(busyMessage);
	}
	throw new Error(busyMessage);
}

function reclaimIfStale(lock: string): boolean {
	let stale: boolean;
	try {
		const owner = object(parsePersistedJson(readFileSync(join(lock, "owner.json"), "utf8")), "Mission lock owner", LOCK_OWNER_FIELDS);
		const pid = boundedInteger(owner.pid, "Mission lock owner pid", 1, Number.MAX_SAFE_INTEGER);
		if (owner.startedAt !== undefined) boundedInteger(owner.startedAt, "Mission lock owner start time", 0, Number.MAX_SAFE_INTEGER);
		stale = !isPidAlive(pid);
	} catch {
		// Owner metadata is published atomically with the lock directory; unknown/corrupt ownership fails closed.
		try { statSync(lock); return false; } catch { return true; }
	}
	if (!stale) return false;
	const aside = `${lock}.stale.${process.pid}.${randomUUID()}`;
	try { renameSync(lock, aside); } catch { return true; }
	try { rmSync(aside, { recursive: true, force: true }); } catch { /* the reclaimed corpse is inert; a leftover is harmless litter. */ }
	return true;
}

function isPidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return isNodeError(error) && error.code === "EPERM"; }
}

function writeAtomicJson(file: string, value: MissionSnapshot): void {
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

function readJsonFile(file: string, name: string): PersistedInput {
	if (!pathExists(file)) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!fstatSync(fd).isFile()) throw new Error(`${name} path is not a real file: ${file}`);
		return parsePersistedJson(readFileSync(fd, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${name} is malformed: ${file}`);
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parsePersistedJson(source: string): PersistedValue {
	return JSON.parse(source);
}

function validateSnapshot(value: PersistedObjectInput, cwd: string, expectedSlug: string): MissionSnapshot {
	const record = object(value, "Mission snapshot", SNAPSHOT_FIELDS);
	const revision = record.revision;
	if (record.version !== SNAPSHOT_VERSION || !isFiniteNumber(revision) || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Unsupported Mission snapshot version or revision.");
	const ownerValue = object(record.owner, "Mission owner", OWNER_FIELDS);
	const owner: MissionOwner = { sessionId: text(ownerValue.sessionId, "owner session id", 200), sessionFile: text(ownerValue.sessionFile, "owner session file", 2_000) };
	const rawMission = object(record.mission, "Mission", MISSION_FIELDS);
	const slug = text(rawMission.slug, "Mission slug", 120);
	if (slug !== expectedSlug || !validSlug(slug)) throw new Error("Mission snapshot slug does not match its directory.");
	const mission = validateMission(rawMission, cwd, slug);
	const progress = array(record.progress, "Mission progress", 10_000).map(validateProgress);
	const continuationProgressIndex = number(record.continuationProgressIndex, "continuation progress index");
	if (!Number.isInteger(continuationProgressIndex) || continuationProgressIndex < 0 || continuationProgressIndex > progress.length) throw new Error("Invalid Mission continuation progress index.");
	return {
		version: 1,
		revision,
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

function validateMission(value: PersistedFields<typeof MISSION_FIELDS>, cwd: string, slug: string): MissionCurrent {
	const status = enumValue(value.status, STATUSES, "Mission status");
	const reviewStatus = value.reviewStatus === undefined ? undefined : enumValue(value.reviewStatus, REVIEW_STATUSES, "Mission review status");
	const mission: MissionCurrent = {
		missionId: text(value.missionId, "Mission id", 200),
		objective: text(value.objective, "Mission objective", 20_000),
		title: text(value.title, "Mission title", 80),
		requirements: stringArray(value.requirements, "Mission requirements", 12, 240),
		status,
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
	if (value.tokenBudget !== undefined) mission.tokenBudget = boundedInteger(value.tokenBudget, "tokenBudget", 0, Number.MAX_SAFE_INTEGER);
	if (value.costBudgetUsd !== undefined) mission.costBudgetUsd = nonnegative(value.costBudgetUsd, "costBudgetUsd");
	if (value.turnBudget !== undefined) mission.turnBudget = boundedInteger(value.turnBudget, "turnBudget", 0, Number.MAX_SAFE_INTEGER);
	if (value.wallDeadlineAt !== undefined) mission.wallDeadlineAt = boundedInteger(value.wallDeadlineAt, "wallDeadlineAt", 0, Number.MAX_SAFE_INTEGER);
	if (value.objectiveVersion !== undefined) mission.objectiveVersion = boundedInteger(value.objectiveVersion, "objectiveVersion", 0, Number.MAX_SAFE_INTEGER);
	if (value.blockerCount !== undefined) mission.blockerCount = boundedInteger(value.blockerCount, "blockerCount", 0, Number.MAX_SAFE_INTEGER);
	if (value.turnCount !== undefined) mission.turnCount = boundedInteger(value.turnCount, "turnCount", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewCandidateObjectiveVersion !== undefined) mission.reviewCandidateObjectiveVersion = boundedInteger(value.reviewCandidateObjectiveVersion, "reviewCandidateObjectiveVersion", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewUpdatedAt !== undefined) mission.reviewUpdatedAt = boundedInteger(value.reviewUpdatedAt, "reviewUpdatedAt", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewNotBeforeAt !== undefined) mission.reviewNotBeforeAt = boundedInteger(value.reviewNotBeforeAt, "reviewNotBeforeAt", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewSupersessionCount !== undefined) mission.reviewSupersessionCount = boundedInteger(value.reviewSupersessionCount, "reviewSupersessionCount", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewBlockingFindingCount !== undefined) mission.reviewBlockingFindingCount = boundedInteger(value.reviewBlockingFindingCount, "reviewBlockingFindingCount", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewBacklogFindingCount !== undefined) mission.reviewBacklogFindingCount = boundedInteger(value.reviewBacklogFindingCount, "reviewBacklogFindingCount", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewCorrectionCount !== undefined) mission.reviewCorrectionCount = boundedInteger(value.reviewCorrectionCount, "reviewCorrectionCount", 0, Number.MAX_SAFE_INTEGER);
	if (value.reviewCorrectionLimit !== undefined) mission.reviewCorrectionLimit = boundedInteger(value.reviewCorrectionLimit, "reviewCorrectionLimit", 0, Number.MAX_SAFE_INTEGER);
	if (value.lastReason !== undefined) mission.lastReason = text(value.lastReason, "lastReason", 20_000);
	if (value.lastSummary !== undefined) mission.lastSummary = text(value.lastSummary, "lastSummary", 20_000);
	if (value.generation !== undefined) mission.generation = text(value.generation, "generation", 20_000);
	if (value.reviewRunId !== undefined) mission.reviewRunId = text(value.reviewRunId, "reviewRunId", 20_000);
	if (value.reviewAdmissionId !== undefined) mission.reviewAdmissionId = text(value.reviewAdmissionId, "reviewAdmissionId", 20_000);
	if (value.reviewReason !== undefined) mission.reviewReason = text(value.reviewReason, "reviewReason", 20_000);
	if (value.reviewSkippedReason !== undefined) mission.reviewSkippedReason = text(value.reviewSkippedReason, "reviewSkippedReason", 20_000);
	if (value.reviewSuggestedVerdict !== undefined) {
		const verdict = text(value.reviewSuggestedVerdict, "reviewSuggestedVerdict", 20_000);
		if (verdict !== "clear" && verdict !== "changes_requested" && verdict !== "unknown") throw new Error("Invalid Mission suggested review verdict.");
		mission.reviewSuggestedVerdict = verdict;
	}
	if (value.reviewOutcome !== undefined) {
		const outcome = text(value.reviewOutcome, "reviewOutcome", 20_000);
		if (outcome !== "superseded" && outcome !== "failed") throw new Error("Invalid Mission review outcome.");
		mission.reviewOutcome = outcome;
	}
	if (value.reviewWorktreeFingerprint !== undefined) mission.reviewWorktreeFingerprint = text(value.reviewWorktreeFingerprint, "reviewWorktreeFingerprint", 20_000);
	if (value.admittedWorktreeFingerprint !== undefined) mission.admittedWorktreeFingerprint = text(value.admittedWorktreeFingerprint, "admittedWorktreeFingerprint", 20_000);
	if (value.reviewCandidateId !== undefined) mission.reviewCandidateId = text(value.reviewCandidateId, "reviewCandidateId", 20_000);
	if (value.reviewAdjudicatedCandidateId !== undefined) mission.reviewAdjudicatedCandidateId = text(value.reviewAdjudicatedCandidateId, "reviewAdjudicatedCandidateId", 20_000);
	if (value.reviewAdjudicatedVerdict !== undefined) {
		const verdict = text(value.reviewAdjudicatedVerdict, "reviewAdjudicatedVerdict", 20_000);
		if (verdict !== "clear" && verdict !== "changes_requested") throw new Error("Invalid Mission adjudicated review verdict.");
		mission.reviewAdjudicatedVerdict = verdict;
	}
	if (value.reviewHighestSeverity !== undefined) {
		const severity = text(value.reviewHighestSeverity, "reviewHighestSeverity", 20_000);
		if (severity !== "blocker" && severity !== "major" && severity !== "minor" && severity !== "nit") throw new Error("Invalid Mission review severity.");
		mission.reviewHighestSeverity = severity;
	}
	if (value.completionLatchCandidateId !== undefined) mission.completionLatchCandidateId = text(value.completionLatchCandidateId, "completionLatchCandidateId", 20_000);
	if (value.completionLatchReviewStatus !== undefined) {
		const latchStatus = text(value.completionLatchReviewStatus, "completionLatchReviewStatus", 20_000);
		if (latchStatus !== "not_required" && latchStatus !== "clear" && latchStatus !== "skipped") throw new Error("Invalid Mission completion latch review status.");
		mission.completionLatchReviewStatus = latchStatus;
	}
	if (value.completionId !== undefined) mission.completionId = text(value.completionId, "completionId", 20_000);
	if (value.completionEffectsStatus !== undefined) {
		const effectsStatus = text(value.completionEffectsStatus, "completionEffectsStatus", 20_000);
		if (effectsStatus !== "pending" && effectsStatus !== "done") throw new Error("Invalid Mission completion effects status.");
		mission.completionEffectsStatus = effectsStatus;
	}
	if (value.blockerFingerprint !== undefined) mission.blockerFingerprint = text(value.blockerFingerprint, "blockerFingerprint", 20_000);
	if (value.reviewAdjudications !== undefined) mission.reviewAdjudications = array(value.reviewAdjudications, "Mission review adjudications", MAX_MISSION_REVIEW_ADJUDICATIONS).map((item) => {
		const adjudication = object(item, "Mission review adjudication", ADJUDICATION_FIELDS);
		const verdict = text(adjudication.verdict, "Mission review adjudication verdict", 40);
		if (verdict !== "clear" && verdict !== "changes_requested") throw new Error("Invalid Mission review adjudication verdict.");
		return { candidateId: text(adjudication.candidateId, "Mission review adjudication candidate", 200), verdict };
	});
	if (mission.reviewAdjudicatedCandidateId && mission.reviewAdjudicatedVerdict) {
		const candidateKnown = mission.reviewAdjudications?.some((item) => item.candidateId === mission.reviewAdjudicatedCandidateId) ?? false;
		if (!candidateKnown && (mission.reviewAdjudications?.length ?? 0) >= MAX_MISSION_REVIEW_ADJUDICATIONS) throw new Error("Mission review adjudication history cannot include the latest adjudicated candidate without exceeding capacity.");
		mission.reviewAdjudications = [...(mission.reviewAdjudications ?? []).filter((item) => item.candidateId !== mission.reviewAdjudicatedCandidateId), { candidateId: mission.reviewAdjudicatedCandidateId, verdict: mission.reviewAdjudicatedVerdict }];
	}
	if (value.reviewFindings !== undefined) mission.reviewFindings = reviewFindings(value.reviewFindings, "Mission review findings");
	if (value.reviewAcceptedFindings !== undefined) mission.reviewAcceptedFindings = reviewFindings(value.reviewAcceptedFindings, "Mission accepted review findings");
	if (value.reviewScopePaths !== undefined) {
		mission.reviewScopePaths = stringArray(value.reviewScopePaths, "Mission review scope paths", 1_000, 2_000);
		if (mission.reviewScopePaths.some((path) => !reviewPath(path))) throw new Error("Invalid Mission review scope path.");
	}
	if (value.reviewScopeRevisions !== undefined) mission.reviewScopeRevisions = reviewRevisions(value.reviewScopeRevisions, "Mission review scope revisions");
	if (value.reviewAcceptedRevisions !== undefined) mission.reviewAcceptedRevisions = reviewRevisions(value.reviewAcceptedRevisions, "Mission accepted review revisions");
	if (value.completionAudit !== undefined) mission.completionAudit = array(value.completionAudit, "Mission completion audit", 12).map((item) => {
		const audit = object(item, "Mission completion audit item", COMPLETION_AUDIT_FIELDS);
		return { requirementIndex: boundedInteger(audit.requirementIndex, "requirement index", 0, 11), evidence: text(audit.evidence, "requirement evidence", 2_000) };
	});
	if (value.lastContinuationAt !== undefined) mission.lastContinuationAt = number(value.lastContinuationAt, "lastContinuationAt");
	if (reviewStatus) mission.reviewStatus = reviewStatus;
	if (value.reviewFailure !== undefined) mission.reviewFailure = value.reviewFailure === true;
	if (value.initialBaselinePending !== undefined) {
		if (!isBoolean(value.initialBaselinePending)) throw new Error("Invalid Mission initial baseline pending marker.");
		mission.initialBaselinePending = value.initialBaselinePending;
	}
	if (value.reviewAdjudicationHistoryComplete !== undefined) {
		if (value.reviewAdjudicationHistoryComplete !== true) throw new Error("Invalid Mission review adjudication history completeness marker.");
		mission.reviewAdjudicationHistoryComplete = true;
	}
	if (value.reviewLegacyRelaunchAuthorized !== undefined) {
		if (value.reviewLegacyRelaunchAuthorized !== true || reviewStatus === "clear" || reviewStatus === "skipped" || reviewStatus === "not_required") throw new Error("Invalid Mission legacy review relaunch authorization.");
		mission.reviewLegacyRelaunchAuthorized = true;
	}
	return mission;
}

function reviewRevisions(value: PersistedInput, label: string): MissionReviewRevision[] {
	return array(value, label, 100).map((item) => {
		const revision = object(item, "Mission review revision", REVISION_FIELDS);
		const root = text(revision.root, "Mission review revision root", 2_000);
		const base = text(revision.base, "Mission review revision base", 64);
		const head = text(revision.head, "Mission review revision head", 64);
		if (!reviewPath(root) || !/^[0-9a-f]{40,64}$/.test(base) || !/^[0-9a-f]{40,64}$/.test(head)) throw new Error("Invalid Mission review revision.");
		return { root, base, head };
	});
}

function reviewFindings(value: PersistedInput, label: string): MissionReviewFinding[] {
	return array(value, label, 1_000).map((item) => {
		const finding = object(item, "Mission review finding", FINDING_FIELDS);
		const severity = enumValue(finding.severity, REVIEW_SEVERITIES, "Mission review finding severity");
		const criticalImpact = finding.criticalImpact === undefined ? undefined : enumValue(finding.criticalImpact, REVIEW_CRITICAL_IMPACTS, "Mission review critical impact");
		const path = finding.path === undefined ? undefined : text(finding.path, "Mission review finding path", 2_000);
		if (path !== undefined && !reviewPath(path)) throw new Error("Invalid Mission review finding path.");
		const result: MissionReviewFinding = {
			index: boundedInteger(finding.index, "Mission review finding index", 0, 999),
			severity,
			summary: text(finding.summary, "Mission review finding summary", 4_000),
		};
		if (path !== undefined) result.path = path;
		if (finding.line !== undefined) result.line = boundedInteger(finding.line, "Mission review finding line", 1, Number.MAX_SAFE_INTEGER);
		if (finding.requirementIndex !== undefined) result.requirementIndex = boundedInteger(finding.requirementIndex, "Mission review finding requirement", 0, 11);
		if (criticalImpact !== undefined) result.criticalImpact = criticalImpact;
		return result;
	});
}

function reviewPath(path: string): boolean {
	return path === "." || !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function validateProgress(value: PersistedValue): MissionProgressRecord {
	const record = object(value, "Mission progress record", PROGRESS_FIELDS);
	const validation = array(record.validation, "progress validation", 20).map((item) => {
		const value = object(item, "validation record", VALIDATION_FIELDS);
		const result: MissionValidationRecord = {
			command: text(value.command, "validation command", 500),
			exitCode: boundedInteger(value.exitCode, "validation exit code", -1_000_000, 1_000_000),
			objectiveVersion: boundedInteger(value.objectiveVersion, "validation objective version", 1, 1_000_000),
		};
		if (value.summary !== undefined) result.summary = text(value.summary, "validation summary", 500);
		if (value.artifact !== undefined) result.artifact = text(value.artifact, "validation artifact", 500);
		return result;
	});
	const progress: MissionProgressRecord = {
		missionId: text(record.missionId, "progress Mission id", 200),
		at: number(record.at, "progress timestamp"),
		summary: text(record.summary, "progress summary", 1_200),
		evidence: stringArray(record.evidence, "progress evidence", 20, 500),
		remaining: stringArray(record.remaining, "progress remaining", 20, 500),
		validation,
		checkpoint: record.checkpoint === true,
		blocked: record.blocked === true,
	};
	if (record.blockerId !== undefined) progress.blockerId = text(record.blockerId, "blocker id", 160);
	return progress;
}

function validateUsage(value: PersistedInput): MissionUsage {
	const record = object(value, "Mission usage", USAGE_FIELDS);
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

function object<const Fields extends readonly string[]>(value: PersistedObjectInput, name: string, allowedFields: Fields): PersistedFields<Fields> {
	if (!isPersistedObject(value)) throw new Error(`${name} must be an object.`);
	if (!hasOnlyFields(value, allowedFields)) {
		const unknownField = Object.keys(value).find((key) => !includesField(allowedFields, key));
		throw new Error(`${name} has unknown field: ${unknownField}`);
	}
	return value;
}

function enumValue<const Value extends string>(value: PersistedInput, allowed: ReadonlySet<Value>, name: string): Value {
	if (isString(value)) for (const candidate of allowed) if (candidate === value) return candidate;
	throw new Error(`Invalid ${name}: ${String(value)}`);
}

function array(value: PersistedInput, name: string, max: number): PersistedValue[] {
	if (!isPersistedArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} items.`);
	return value;
}

function stringArray(value: PersistedInput, name: string, maxItems: number, maxLength: number): string[] {
	return array(value, name, maxItems).map((item) => text(item, name, maxLength));
}

function text(value: PersistedInput, name: string, max: number): string {
	if (!isString(value) || !value || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
	return value;
}

function number(value: PersistedInput, name: string): number {
	if (!isFiniteNumber(value)) throw new Error(`${name} must be finite.`);
	return value;
}

function nonnegative(value: PersistedInput, name: string): number {
	const result = number(value, name);
	if (result < 0) throw new Error(`${name} must be nonnegative.`);
	return result;
}

function boundedInteger(value: PersistedInput, name: string, min: number, max: number): number {
	const result = number(value, name);
	if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return result;
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; } catch { return false; }
}

function isPersistedObject(value: PersistedObjectInput): value is PersistedObject {
	return value !== undefined && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function hasOnlyFields<const Fields extends readonly string[]>(value: PersistedObject, allowedFields: Fields): value is PersistedFields<Fields> {
	return Object.keys(value).every((key) => includesField(allowedFields, key));
}

function includesField(allowedFields: readonly string[], key: string): boolean {
	return allowedFields.includes(key);
}

function isPersistedArray(value: PersistedInput): value is PersistedValue[] {
	return Array.isArray(value);
}

function isString(value: PersistedInput): value is string {
	return Object.prototype.toString.call(value) === "[object String]" && value === String(value);
}

function isFiniteNumber(value: PersistedInput): value is number {
	return Object.prototype.toString.call(value) === "[object Number]" && value === Number(value) && Number.isFinite(Number(value));
}

function isBoolean(value: PersistedInput): value is boolean {
	return value === true || value === false;
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause;
}
