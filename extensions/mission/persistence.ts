import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isErrorCode, isNodeError, isRealDirectory, missionDir, missionRoot } from "./artifacts.ts";
import { MAX_MISSION_REVIEW_ADJUDICATIONS } from "./types.ts";
import type {
	MissionCompletionLatch,
	MissionConvergedReviewStatus,
	MissionCurrent,
	MissionOwner,
	MissionProgressRecord,
	MissionReview,
	MissionReviewAdjudication,
	MissionReviewAdmission,
	MissionReviewCandidate,
	MissionReviewCorrection,
	MissionReviewCriticalImpact,
	MissionReviewFindings,
	MissionReviewFinding,
	MissionReviewOutcome,
	MissionReviewRevision,
	MissionReviewSeverity,
	MissionReviewStatus,
	MissionReviewVerdict,
	MissionSnapshot,
	MissionStatus,
	MissionUsage,
	MissionValidationRecord,
} from "./types.ts";

interface PersistedObject {
	[field: string]: PersistedValue;
}

type PersistedValue = string | number | boolean | null | PersistedObject | PersistedValue[];
type PersistedInput = PersistedValue | undefined;
type PersistedObjectInput = PersistedInput | MissionSnapshot;
type PersistedFields<Fields extends readonly string[]> = PersistedObject & Partial<Record<Fields[number], PersistedValue>>;

const SNAPSHOT_VERSION = 2;
// Lock holds are synchronous sub-second operations, so a lock older than this — or one whose owner pid is
// gone — is a crashed holder, not live contention.
const STATUSES = new Set<MissionStatus>([
	"active", "paused", "blocked", "terminal_error", "budget_limited", "usage_limited", "complete", "ended", "cleared",
]);
const REVIEW_STATUSES = new Set<MissionReviewStatus>([
	"not_required", "due", "starting", "running", "awaiting_adjudication", "changes_requested", "clear", "skipped",
]);
const CONVERGED_REVIEW_STATUSES = new Set<MissionConvergedReviewStatus>(["not_required", "clear", "skipped"]);
const REVIEW_VERDICTS = new Set<MissionReviewVerdict>(["clear", "changes_requested"]);
const REVIEW_OUTCOMES = new Set<MissionReviewOutcome>(["superseded", "failed"]);
const REVIEW_SEVERITIES = new Set<MissionReviewSeverity>(["blocker", "major", "minor", "nit"]);
const REVIEW_CRITICAL_IMPACTS = new Set<MissionReviewCriticalImpact>(["security", "data_loss"]);
const SNAPSHOT_FIELDS = [
	"version", "revision", "owner", "mission", "progress", "continuationProgressIndex", "carriedUsage", "usage",
	"reviewFailureCount", "usageComplete",
] satisfies readonly (keyof MissionSnapshot)[];
const OWNER_FIELDS = ["sessionId", "sessionFile"] satisfies readonly (keyof MissionOwner)[];
const MISSION_FIELDS = [
	"missionId", "objective", "title", "requirements", "status", "createdAt", "updatedAt", "slug", "chain",
	"chainBranch", "artifactDir", "paths", "tokenBudget", "costBudgetUsd", "baselineMainTokens",
	"baselineSubagentTokens", "baselineMainCostUsd", "baselineSubagentCostUsd", "lastReason", "lastSummary",
	"lastContinuationAt", "generation", "objectiveVersion", "turnBudget", "wallDeadlineAt", "review", "completionId",
	"completionEffectsStatus", "completionAudit", "blockerFingerprint", "blockerCount", "turnCount",
] satisfies readonly (keyof MissionCurrent)[];
const REVIEW_FIELDS = [
	"admission", "candidate", "adjudication", "findings", "correction", "completionLatch",
] satisfies readonly (keyof MissionReview)[];
const REVIEW_ADMISSION_FIELDS = [
	"status", "initialBaselinePending", "supersessionCount", "updatedAt", "runId", "admissionId", "reason",
	"skippedReason", "failure", "outcome", "notBeforeAt",
] satisfies readonly (keyof MissionReviewAdmission)[];
const REVIEW_CANDIDATE_FIELDS = [
	"id", "objectiveVersion", "worktreeFingerprint", "admittedWorktreeFingerprint", "scopePaths", "scopeRevisions",
] satisfies readonly (keyof MissionReviewCandidate)[];
const REVIEW_ADJUDICATION_FIELDS = [
	"history", "suggestedVerdict", "adjudicatedCandidateId", "adjudicatedVerdict", "historyComplete",
] satisfies readonly (keyof MissionReviewAdjudication)[];
const REVIEW_FINDINGS_FIELDS = [
	"blockingCount", "backlogCount", "highestSeverity", "items", "accepted",
] satisfies readonly (keyof MissionReviewFindings)[];
const REVIEW_CORRECTION_FIELDS = ["count", "limit", "acceptedRevisions"] satisfies readonly (keyof MissionReviewCorrection)[];
const COMPLETION_LATCH_FIELDS = ["candidateId", "reviewStatus"] satisfies readonly (keyof MissionCompletionLatch)[];
const PROGRESS_FIELDS = [
	"missionId", "at", "summary", "evidence", "remaining", "validation", "checkpoint", "blocked", "blockerId",
] satisfies readonly (keyof MissionProgressRecord)[];
const VALIDATION_FIELDS = ["command", "exitCode", "objectiveVersion", "summary", "artifact"] as const;
const USAGE_FIELDS = [
	"mainTokens", "subagentTokens", "totalTokens", "mainCostUsd", "subagentCostUsd", "totalCostUsd",
] satisfies readonly (keyof MissionUsage)[];
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
		if (entry.isSymbolicLink() && entry.name.endsWith(".json")) {
			throw new Error(`Mission state path is not a real file: ${join(stateDir, entry.name)}`);
		}
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

/** The session fields Mission ownership is derived from; an ExtensionContext satisfies it. */
interface MissionSessionSource {
	sessionManager: {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
}

export function currentMissionOwner(ctx: MissionSessionSource): MissionOwner | undefined {
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
		if (!isRealDirectory(info)) throw new Error(`Mission state path is not a real directory: ${directory}`);
	}
}

function ensureDirectory(directory: string): void {
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (!isErrorCode(error, "EEXIST")) throw error;
	}
	const info = lstatSync(directory);
	if (!isRealDirectory(info)) throw new Error(`Mission state path is not a real directory: ${directory}`);
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
			const ownerRecord = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
			writeFileSync(join(candidate, "owner.json"), ownerRecord, { encoding: "utf8", mode: 0o600 });
			renameSync(candidate, lock);
			return;
		} catch (error) {
			rmSync(candidate, { recursive: true, force: true });
			if (!isLockContention(error)) throw error;
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
		if (owner.startedAt !== undefined) nonnegativeInteger(owner.startedAt, "Mission lock owner start time");
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
	const unsupported = record.version !== SNAPSHOT_VERSION
		|| !isFiniteNumber(revision)
		|| !Number.isSafeInteger(revision)
		|| revision < 0;
	if (unsupported) throw new Error("Unsupported Mission snapshot version or revision.");
	const ownerValue = object(record.owner, "Mission owner", OWNER_FIELDS);
	const owner: MissionOwner = {
		sessionId: text(ownerValue.sessionId, "owner session id", 200),
		sessionFile: text(ownerValue.sessionFile, "owner session file", 2_000),
	};
	const rawMission = object(record.mission, "Mission", MISSION_FIELDS);
	const slug = text(rawMission.slug, "Mission slug", 120);
	if (slug !== expectedSlug || !validSlug(slug)) throw new Error("Mission snapshot slug does not match its directory.");
	const mission = validateMission(rawMission, cwd, slug);
	const progress = array(record.progress, "Mission progress", 10_000).map(validateProgress);
	const continuationProgressIndex = number(record.continuationProgressIndex, "continuation progress index");
	const indexOutOfRange = !Number.isInteger(continuationProgressIndex)
		|| continuationProgressIndex < 0
		|| continuationProgressIndex > progress.length;
	if (indexOutOfRange) throw new Error("Invalid Mission continuation progress index.");
	return {
		version: SNAPSHOT_VERSION,
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
		review: validateMissionReview(value.review),
	};
	if (value.tokenBudget !== undefined) mission.tokenBudget = nonnegativeInteger(value.tokenBudget, "tokenBudget");
	if (value.costBudgetUsd !== undefined) mission.costBudgetUsd = nonnegative(value.costBudgetUsd, "costBudgetUsd");
	if (value.turnBudget !== undefined) mission.turnBudget = nonnegativeInteger(value.turnBudget, "turnBudget");
	if (value.wallDeadlineAt !== undefined) mission.wallDeadlineAt = nonnegativeInteger(value.wallDeadlineAt, "wallDeadlineAt");
	if (value.objectiveVersion !== undefined) mission.objectiveVersion = nonnegativeInteger(value.objectiveVersion, "objectiveVersion");
	if (value.blockerCount !== undefined) mission.blockerCount = nonnegativeInteger(value.blockerCount, "blockerCount");
	if (value.turnCount !== undefined) mission.turnCount = nonnegativeInteger(value.turnCount, "turnCount");
	if (value.lastReason !== undefined) mission.lastReason = text(value.lastReason, "lastReason", 20_000);
	if (value.lastSummary !== undefined) mission.lastSummary = text(value.lastSummary, "lastSummary", 20_000);
	if (value.generation !== undefined) mission.generation = text(value.generation, "generation", 20_000);
	if (value.completionId !== undefined) mission.completionId = text(value.completionId, "completionId", 20_000);
	if (value.completionEffectsStatus !== undefined) {
		const effectsStatus = text(value.completionEffectsStatus, "completionEffectsStatus", 20_000);
		if (effectsStatus !== "pending" && effectsStatus !== "done") throw new Error("Invalid Mission completion effects status.");
		mission.completionEffectsStatus = effectsStatus;
	}
	if (value.blockerFingerprint !== undefined) mission.blockerFingerprint = text(value.blockerFingerprint, "blockerFingerprint", 20_000);
	if (value.completionAudit !== undefined) {
		mission.completionAudit = array(value.completionAudit, "Mission completion audit", 12).map((item) => {
			const audit = object(item, "Mission completion audit item", COMPLETION_AUDIT_FIELDS);
			return {
				requirementIndex: boundedInteger(audit.requirementIndex, "requirement index", 0, 11),
				evidence: text(audit.evidence, "requirement evidence", 2_000),
			};
		});
	}
	if (value.lastContinuationAt !== undefined) mission.lastContinuationAt = number(value.lastContinuationAt, "lastContinuationAt");
	return mission;
}

function validateMissionReview(value: PersistedInput): MissionReview {
	const record = object(value, "Mission review", REVIEW_FIELDS);
	return {
		admission: validateReviewAdmission(record.admission),
		candidate: validateReviewCandidate(record.candidate),
		adjudication: validateReviewAdjudication(record.adjudication),
		findings: validateReviewFindingsSection(record.findings),
		correction: validateReviewCorrection(record.correction),
		completionLatch: validateCompletionLatch(record.completionLatch),
	};
}

function validateReviewAdmission(value: PersistedInput): MissionReviewAdmission {
	const record = object(value, "Mission review admission", REVIEW_ADMISSION_FIELDS);
	const admission: MissionReviewAdmission = {
		status: enumValue(record.status, REVIEW_STATUSES, "Mission review status"),
		initialBaselinePending: boolean(record.initialBaselinePending, "Mission initial baseline pending marker"),
		supersessionCount: nonnegativeInteger(record.supersessionCount, "reviewSupersessionCount"),
	};
	if (record.updatedAt !== undefined) admission.updatedAt = nonnegativeInteger(record.updatedAt, "reviewUpdatedAt");
	if (record.runId !== undefined) admission.runId = text(record.runId, "reviewRunId", 20_000);
	if (record.admissionId !== undefined) admission.admissionId = text(record.admissionId, "reviewAdmissionId", 20_000);
	if (record.reason !== undefined) admission.reason = text(record.reason, "reviewReason", 20_000);
	if (record.skippedReason !== undefined) admission.skippedReason = text(record.skippedReason, "reviewSkippedReason", 20_000);
	if (record.failure !== undefined) admission.failure = record.failure === true;
	if (record.outcome !== undefined) admission.outcome = enumValue(record.outcome, REVIEW_OUTCOMES, "reviewOutcome");
	if (record.notBeforeAt !== undefined) admission.notBeforeAt = nonnegativeInteger(record.notBeforeAt, "reviewNotBeforeAt");
	return admission;
}

function validateReviewCandidate(value: PersistedInput): MissionReviewCandidate {
	const record = object(value, "Mission review candidate", REVIEW_CANDIDATE_FIELDS);
	const candidate: MissionReviewCandidate = {};
	if (record.id !== undefined) candidate.id = text(record.id, "reviewCandidateId", 20_000);
	if (record.objectiveVersion !== undefined) {
		candidate.objectiveVersion = nonnegativeInteger(record.objectiveVersion, "reviewCandidateObjectiveVersion");
	}
	if (record.worktreeFingerprint !== undefined) {
		candidate.worktreeFingerprint = text(record.worktreeFingerprint, "reviewWorktreeFingerprint", 20_000);
	}
	if (record.admittedWorktreeFingerprint !== undefined) {
		candidate.admittedWorktreeFingerprint = text(record.admittedWorktreeFingerprint, "admittedWorktreeFingerprint", 20_000);
	}
	if (record.scopePaths !== undefined) {
		candidate.scopePaths = stringArray(record.scopePaths, "Mission review scope paths", 1_000, 2_000);
		if (candidate.scopePaths.some((path) => !reviewPath(path))) throw new Error("Invalid Mission review scope path.");
	}
	if (record.scopeRevisions !== undefined) {
		candidate.scopeRevisions = reviewRevisions(record.scopeRevisions, "Mission review scope revisions");
	}
	return candidate;
}

const SUGGESTED_VERDICTS: readonly string[] = ["clear", "changes_requested", "unknown"];

function isSuggestedVerdict(value: string): value is MissionReviewVerdict | "unknown" {
	return SUGGESTED_VERDICTS.includes(value);
}

function validateReviewAdjudication(value: PersistedInput): MissionReviewAdjudication {
	const record = object(value, "Mission review adjudication state", REVIEW_ADJUDICATION_FIELDS);
	const adjudication: MissionReviewAdjudication = { history: reviewAdjudicationHistory(record.history) };
	if (record.suggestedVerdict !== undefined) {
		const verdict = text(record.suggestedVerdict, "reviewSuggestedVerdict", 20_000);
		if (!isSuggestedVerdict(verdict)) {
			throw new Error("Invalid Mission suggested review verdict.");
		}
		adjudication.suggestedVerdict = verdict;
	}
	if (record.adjudicatedCandidateId !== undefined) {
		adjudication.adjudicatedCandidateId = text(record.adjudicatedCandidateId, "reviewAdjudicatedCandidateId", 20_000);
	}
	if (record.adjudicatedVerdict !== undefined) {
		adjudication.adjudicatedVerdict = enumValue(record.adjudicatedVerdict, REVIEW_VERDICTS, "reviewAdjudicatedVerdict");
	}
	if (record.historyComplete !== undefined) {
		if (record.historyComplete !== true) throw new Error("Invalid Mission review adjudication history completeness marker.");
		adjudication.historyComplete = true;
	}
	if (adjudication.adjudicatedCandidateId && adjudication.adjudicatedVerdict) {
		const candidateKnown = adjudication.history.some((item) => item.candidateId === adjudication.adjudicatedCandidateId);
		if (!candidateKnown && adjudication.history.length >= MAX_MISSION_REVIEW_ADJUDICATIONS) {
			throw new Error("Mission review adjudication history cannot include the latest adjudicated candidate without exceeding capacity.");
		}
		const others = adjudication.history.filter((item) => item.candidateId !== adjudication.adjudicatedCandidateId);
		adjudication.history = [...others, { candidateId: adjudication.adjudicatedCandidateId, verdict: adjudication.adjudicatedVerdict }];
	}
	return adjudication;
}

function reviewAdjudicationHistory(value: PersistedInput): MissionReviewAdjudication["history"] {
	if (value === undefined) return [];
	return array(value, "Mission review adjudications", MAX_MISSION_REVIEW_ADJUDICATIONS).map((item) => {
		const adjudication = object(item, "Mission review adjudication", ADJUDICATION_FIELDS);
		return {
			candidateId: text(adjudication.candidateId, "Mission review adjudication candidate", 200),
			verdict: enumValue(adjudication.verdict, REVIEW_VERDICTS, "Mission review adjudication verdict"),
		};
	});
}

function validateReviewFindingsSection(value: PersistedInput): MissionReviewFindings {
	const record = object(value, "Mission review findings state", REVIEW_FINDINGS_FIELDS);
	const findings: MissionReviewFindings = {
		blockingCount: nonnegativeInteger(record.blockingCount, "reviewBlockingFindingCount"),
		backlogCount: nonnegativeInteger(record.backlogCount, "reviewBacklogFindingCount"),
	};
	if (record.highestSeverity !== undefined) {
		findings.highestSeverity = enumValue(record.highestSeverity, REVIEW_SEVERITIES, "reviewHighestSeverity");
	}
	if (record.items !== undefined) findings.items = reviewFindings(record.items, "Mission review findings");
	if (record.accepted !== undefined) findings.accepted = reviewFindings(record.accepted, "Mission accepted review findings");
	return findings;
}

function validateReviewCorrection(value: PersistedInput): MissionReviewCorrection {
	const record = object(value, "Mission review correction state", REVIEW_CORRECTION_FIELDS);
	const correction: MissionReviewCorrection = {
		count: nonnegativeInteger(record.count, "reviewCorrectionCount"),
		limit: nonnegativeInteger(record.limit, "reviewCorrectionLimit"),
	};
	if (record.acceptedRevisions !== undefined) {
		correction.acceptedRevisions = reviewRevisions(record.acceptedRevisions, "Mission accepted review revisions");
	}
	return correction;
}

function validateCompletionLatch(value: PersistedInput): MissionCompletionLatch {
	const record = object(value, "Mission completion latch", COMPLETION_LATCH_FIELDS);
	const latch: MissionCompletionLatch = {};
	if (record.candidateId !== undefined) latch.candidateId = text(record.candidateId, "completionLatchCandidateId", 20_000);
	if (record.reviewStatus !== undefined) {
		latch.reviewStatus = enumValue(record.reviewStatus, CONVERGED_REVIEW_STATUSES, "completionLatchReviewStatus");
	}
	return latch;
}

function reviewRevisions(value: PersistedInput, label: string): MissionReviewRevision[] {
	return array(value, label, 100).map((item) => {
		const revision = object(item, "Mission review revision", REVISION_FIELDS);
		const root = text(revision.root, "Mission review revision root", 2_000);
		const base = text(revision.base, "Mission review revision base", 64);
		const head = text(revision.head, "Mission review revision head", 64);
		const validRevision = reviewPath(root)
			&& /^[0-9a-f]{40,64}$/.test(base)
			&& /^[0-9a-f]{40,64}$/.test(head);
		if (!validRevision) throw new Error("Invalid Mission review revision.");
		return { root, base, head };
	});
}

function reviewFindings(value: PersistedInput, label: string): MissionReviewFinding[] {
	return array(value, label, 1_000).map((item) => {
		const finding = object(item, "Mission review finding", FINDING_FIELDS);
		const severity = enumValue(finding.severity, REVIEW_SEVERITIES, "Mission review finding severity");
		const criticalImpact = finding.criticalImpact === undefined
			? undefined
			: enumValue(finding.criticalImpact, REVIEW_CRITICAL_IMPACTS, "Mission review critical impact");
		const path = finding.path === undefined ? undefined : text(finding.path, "Mission review finding path", 2_000);
		if (path !== undefined && !reviewPath(path)) throw new Error("Invalid Mission review finding path.");
		const result: MissionReviewFinding = {
			index: boundedInteger(finding.index, "Mission review finding index", 0, 999),
			severity,
			summary: text(finding.summary, "Mission review finding summary", 4_000),
		};
		if (path !== undefined) result.path = path;
		if (finding.line !== undefined) result.line = boundedInteger(finding.line, "Mission review finding line", 1, Number.MAX_SAFE_INTEGER);
		if (finding.requirementIndex !== undefined) {
			result.requirementIndex = boundedInteger(finding.requirementIndex, "Mission review finding requirement", 0, 11);
		}
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

function object<const Fields extends readonly string[]>(
	value: PersistedObjectInput,
	name: string,
	allowedFields: Fields,
): PersistedFields<Fields> {
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
	const invalid = `${name} must be a non-empty string of at most ${max} characters.`;
	if (!isString(value)) throw new Error(invalid);
	if (!value) throw new Error(invalid);
	if (value.length > max) throw new Error(invalid);
	return value;
}

function number(value: PersistedInput, name: string): number {
	if (!isFiniteNumber(value)) throw new Error(`${name} must be finite.`);
	return value;
}

function boolean(value: PersistedInput, name: string): boolean {
	if (!isBoolean(value)) throw new Error(`${name} must be a boolean.`);
	return value;
}

function nonnegative(value: PersistedInput, name: string): number {
	const result = number(value, name);
	if (result < 0) throw new Error(`${name} must be nonnegative.`);
	return result;
}

/** A persisted nonnegative counter or timestamp: an integer from 0 to Number.MAX_SAFE_INTEGER. */
function nonnegativeInteger(value: PersistedInput, name: string): number {
	return boundedInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: PersistedInput, name: string, min: number, max: number): number {
	const result = number(value, name);
	if (!Number.isInteger(result)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	if (result < min || result > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return result;
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; } catch { return false; }
}

function isPersistedObject(value: PersistedObjectInput): value is PersistedObject {
	return value !== undefined && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function hasOnlyFields<const Fields extends readonly string[]>(
	value: PersistedObject,
	allowedFields: Fields,
): value is PersistedFields<Fields> {
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

/** Another process won the lock-directory race, or left a partial candidate behind. */
function isLockContention(cause: unknown): boolean {
	if (!isNodeError(cause)) return false;
	return cause.code === "EEXIST" || cause.code === "ENOTEMPTY";
}
