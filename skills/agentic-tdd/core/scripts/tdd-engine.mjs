#!/usr/bin/env node
// Deterministic gate engine for the agentic-tdd skill. Zero dependencies.
// All behavioral decisions consume typed fields; prose is display-only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TRANSITIONS = {
	NEW: ["PLANNING"],
	PLANNING: ["WAITING_FOR_USER_PLAN", "PLAN_READY", "BUDGET_EXHAUSTED"],
	WAITING_FOR_USER_PLAN: ["PLANNING"],
	PLAN_READY: ["PLAN_APPROVED", "PLANNING"],
	PLAN_APPROVED: ["LOOP_RUNNING", "PLANNING"],
	LOOP_RUNNING: ["BLOCKED_SPEC", "BLOCKED_ORACLE", "BLOCKED_ENVIRONMENT", "CANDIDATE_READY", "BUDGET_EXHAUSTED"],
	BLOCKED_SPEC: ["PLANNING"],
	BLOCKED_ORACLE: ["PLANNING"],
	BLOCKED_ENVIRONMENT: ["LOOP_RUNNING"],
	CANDIDATE_READY: ["ASSESSING", "LOOP_RUNNING"],
	ASSESSING: ["WAITING_FOR_USER_ASSESS", "CHANGES_REQUIRED", "ASSESSMENT_READY", "BUDGET_EXHAUSTED"],
	WAITING_FOR_USER_ASSESS: ["ASSESSING"],
	CHANGES_REQUIRED: ["LOOP_RUNNING"],
	ASSESSMENT_READY: ["ASSESSMENT_ACCEPTED", "ASSESSING", "LOOP_RUNNING", "PLANNING"],
	ASSESSMENT_ACCEPTED: ["RELEASING"],
	RELEASING: ["WAITING_FOR_USER_RELEASE", "RELEASE_BLOCKED", "CLOSED", "PLANNING", "LOOP_RUNNING", "ASSESSING"],
	WAITING_FOR_USER_RELEASE: ["RELEASING"],
	RELEASE_BLOCKED: ["PLANNING"],
	BUDGET_EXHAUSTED: ["PLANNING", "LOOP_RUNNING", "ASSESSING"],
	CLOSED: [],
};

// Transitions that start or resume work; every other transition must carry a
// schema-checked phase result file.
const START_TRANSITIONS = new Set([
	"NEW>PLANNING",
	"WAITING_FOR_USER_PLAN>PLANNING",
	"PLAN_APPROVED>LOOP_RUNNING",
	"BLOCKED_ENVIRONMENT>LOOP_RUNNING",
	"CANDIDATE_READY>ASSESSING",
	"WAITING_FOR_USER_ASSESS>ASSESSING",
	"CHANGES_REQUIRED>LOOP_RUNNING",
	"ASSESSMENT_ACCEPTED>RELEASING",
	"WAITING_FOR_USER_RELEASE>RELEASING",
	"BUDGET_EXHAUSTED>PLANNING",
	"BUDGET_EXHAUSTED>LOOP_RUNNING",
	"BUDGET_EXHAUSTED>ASSESSING",
]);

const RESULT_PHASES = new Set(["plan", "loop", "assess", "release", "challenge"]);
const RESULT_STATUSES = new Set([
	"PLAN_READY", "WAITING_FOR_USER", "NEEDS_REPOSITORY_EVIDENCE", "NEEDS_HUMAN_DOMAIN_INPUT",
	"ESCALATE_FULL", "BUDGET_EXHAUSTED", "CANDIDATE_READY", "BLOCKED_SPEC", "BLOCKED_ORACLE",
	"BLOCKED_ENVIRONMENT", "IMPLEMENTATION_FAILED", "PASS", "PASS_WITH_NONBLOCKING_FINDINGS",
	"CHANGES_REQUIRED", "PLAN_AMENDMENT_REQUIRED", "HUMAN_DECISION_REQUIRED", "ASSESSMENT_INCONCLUSIVE",
	"RELEASE_APPROVED", "RETURN_TO_PLAN", "RETURN_TO_LOOP", "RETURN_TO_ASSESS", "USER_SIGNOFF_REQUIRED",
	"RELEASE_BLOCKED", "NO_BLOCKERS", "PLAN_REVISION_REQUIRED", "USER_DECISION_REQUIRED",
	"ESCALATE_LIGHT_TO_FULL", "INCONCLUSIVE", "ASSESSMENT_ACCEPTED", "MORE_EVIDENCE_REQUIRED",
	"NEW_IMPLEMENTATION_FINDING", "PLAN_AMBIGUITY_FOUND", "FINDING_RECLASSIFICATION_REQUIRED",
]);

const PROTECTION_MODES = new Set(["auto", "flags", "chmod", "none"]);
const UNPROTECT_STATES = new Set(["CLOSED", "RELEASE_BLOCKED"]);
const BUDGET_COUNTERS = new Set([
	"planning_revisions_remaining",
	"semantic_replans_remaining",
	"implementation_repairs_remaining",
	"external_challenges_remaining",
]);

class EngineError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

const fail = (code, message) => { throw new EngineError(code, message); };

function git(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (file) => `sha256:${sha256(fs.readFileSync(file))}`;
const hashObject = (obj) => `sha256:${sha256(canonicalJson(obj))}`;

function featureDir(root, feature) {
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(feature) || feature.includes("..")) {
		fail("INVALID_FEATURE_ID", `Feature id must be [a-z0-9._-], got: ${feature}`);
	}
	return path.join(root, ".tdd", feature);
}

function resolveInsideRoot(root, file) {
	const resolved = path.resolve(root, file);
	const rel = path.relative(path.resolve(root), resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		fail("PATH_ESCAPE", `Path escapes repository root: ${file}`);
	}
	if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
		fail("SYMLINK_REJECTED", `Symlinks are not allowed: ${file}`);
	}
	return resolved;
}

function atomicWriteJson(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	fs.renameSync(tmp, file);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const manifestPath = (dir) => path.join(dir, "manifest.json");
const protectedPath = (dir) => path.join(dir, "protected-manifest.json");

function loadManifest(root, feature) {
	const file = manifestPath(featureDir(root, feature));
	if (!fs.existsSync(file)) fail("NOT_INITIALIZED", `No manifest for feature '${feature}'. Run init first.`);
	return readJson(file);
}

function saveManifest(root, feature, manifest) {
	atomicWriteJson(manifestPath(featureDir(root, feature)), manifest);
}

function withLock(root, feature, fn) {
	const lock = path.join(featureDir(root, feature), ".lock");
	try {
		fs.mkdirSync(lock);
	} catch (error) {
		if (error.code === "EEXIST") fail("LOCKED", `Feature '${feature}' is locked by another writer (${lock}).`);
		throw error;
	}
	try {
		return fn();
	} finally {
		fs.rmdirSync(lock);
	}
}

export function appendEvent(root, feature, type, data = {}) {
	const line = { ts: new Date().toISOString(), type, ...data };
	fs.appendFileSync(path.join(featureDir(root, feature), "events.jsonl"), `${JSON.stringify(line)}\n`);
	return line;
}

function worktreeStatus(root) {
	const lines = git(root, ["status", "--porcelain"]).split("\n").filter(Boolean);
	return {
		modified: lines.filter((l) => !l.startsWith("??")).map((l) => l.slice(3)),
		untracked: lines.filter((l) => l.startsWith("??")).map((l) => l.slice(3)),
	};
}

function detectTestCommand(root) {
	const pkg = path.join(root, "package.json");
	if (fs.existsSync(pkg) && readJson(pkg).scripts?.test) return "npm test";
	if (fs.existsSync(path.join(root, "CMakeLists.txt"))) return "ctest --test-dir build";
	if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "pytest.ini"))) return "pytest";
	if (fs.existsSync(path.join(root, "Cargo.toml"))) return "cargo test";
	return null;
}

export function init(root, feature, options = {}) {
	const mode = options.mode ?? "light";
	if (!["light", "full", "cpp-hft"].includes(mode)) fail("INVALID_MODE", `Unknown mode: ${mode}`);
	const protection = options.protection ?? "auto";
	if (!PROTECTION_MODES.has(protection)) fail("INVALID_PROTECTION", `Unknown protection_mode: ${protection}`);

	const dir = featureDir(root, feature);
	if (fs.existsSync(manifestPath(dir))) fail("ALREADY_INITIALIZED", `Feature '${feature}' already exists.`);

	let baseline;
	try {
		baseline = git(root, ["rev-parse", "HEAD"]);
	} catch {
		fail("NOT_A_GIT_REPO", `Target root is not a git repository with commits: ${root}`);
	}
	const status = worktreeStatus(root);
	if (status.modified.length && !options.allowDirty) {
		fail("DIRTY_WORKTREE", `Tracked files modified: ${status.modified.join(", ")}. Ask the USER, then re-run with allowDirty.`);
	}

	fs.mkdirSync(dir, { recursive: true });
	for (const sub of ["input", "decisions", "plan", "loop", "assess", "challenges", "release"]) {
		fs.mkdirSync(path.join(dir, sub), { recursive: true });
	}

	const manifest = {
		schema_version: 1,
		feature: { id: feature, title: options.title ?? feature, mode },
		workflow: { state: "NEW", required_next: ["plan"] },
		repository: {
			baseline_commit: baseline,
			candidate_commit: null,
			branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
			test_command: options.testCommand ?? detectTestCommand(root),
			untracked_at_init: status.untracked,
		},
		current: { plan_version: null, loop_run: null, assessment_run: null },
		options: {
			protection_mode: protection,
			challenges: {
				plan: options.challenges?.includes("plan") ?? false,
				loop: options.challenges?.includes("loop") ?? false,
				assess: options.challenges?.includes("assess") ?? false,
			},
			models: options.models ?? {},
		},
		integrity: {},
		budgets: mode === "light"
			? { planning_revisions_remaining: 1, semantic_replans_remaining: 1, implementation_repairs_remaining: 1, external_challenges_remaining: 1 }
			: { planning_revisions_remaining: 3, semantic_replans_remaining: 2, implementation_repairs_remaining: 3, external_challenges_remaining: 3 },
		user_decisions: { unresolved_blocking: 0 },
		challenges: { plan: "not_invoked", loop: "not_invoked", assess: "not_invoked" },
		release: { reviewer_status: "not_started" },
	};
	saveManifest(root, feature, manifest);
	appendEvent(root, feature, "init", { mode, baseline_commit: baseline });
	return manifest;
}

function validateResult(result) {
	for (const field of ["phase", "run_id", "status", "requested_transition"]) {
		if (typeof result?.[field] !== "string" || !result[field]) fail("INVALID_RESULT", `Result missing required string field: ${field}`);
	}
	if (!RESULT_PHASES.has(result.phase)) fail("INVALID_RESULT", `Unknown result phase: ${result.phase}`);
	if (!RESULT_STATUSES.has(result.status)) fail("INVALID_RESULT", `Unknown result status: ${result.status}`);
	if (!(result.requested_transition in TRANSITIONS)) fail("INVALID_RESULT", `Unknown requested_transition: ${result.requested_transition}`);
}

export function transition(root, feature, to, options = {}) {
	return withLock(root, feature, () => {
		const manifest = loadManifest(root, feature);
		const from = manifest.workflow.state;
		if (!(to in TRANSITIONS)) fail("UNKNOWN_STATE", `Unknown state: ${to}`);
		if (!TRANSITIONS[from].includes(to)) fail("ILLEGAL_TRANSITION", `${from} → ${to} is not a legal transition.`);

		let result = null;
		if (!START_TRANSITIONS.has(`${from}>${to}`)) {
			if (!options.resultFile) fail("RESULT_REQUIRED", `${from} → ${to} requires a phase result file.`);
			result = readJson(resolveInsideRoot(root, options.resultFile));
			validateResult(result);
			if (result.requested_transition !== to) {
				fail("RESULT_MISMATCH", `Result requests ${result.requested_transition}, transition is to ${to}.`);
			}
		}

		if (to === "CANDIDATE_READY") manifest.repository.candidate_commit = git(root, ["rev-parse", "HEAD"]);
		if (to === "LOOP_RUNNING" && from !== "BLOCKED_ENVIRONMENT") manifest.repository.candidate_commit = null;
		if (to === "ASSESSING") {
			const head = git(root, ["rev-parse", "HEAD"]);
			if (manifest.repository.candidate_commit && head !== manifest.repository.candidate_commit) {
				fail("STALE_CANDIDATE", `HEAD ${head} does not match candidate ${manifest.repository.candidate_commit}.`);
			}
		}

		manifest.workflow.state = to;
		saveManifest(root, feature, manifest);
		appendEvent(root, feature, "transition", { from, to, run_id: result?.run_id ?? null, status: result?.status ?? null });
		return { from, to, state: to };
	});
}

export function freeze(root, feature, phase, files) {
	return withLock(root, feature, () => {
		const manifest = loadManifest(root, feature);
		const hashes = {};
		for (const file of files) {
			const resolved = resolveInsideRoot(root, file);
			if (!fs.existsSync(resolved)) fail("MISSING_ARTIFACT", `Cannot freeze missing file: ${file}`);
			hashes[path.relative(root, resolved)] = hashFile(resolved);
		}
		manifest.integrity[phase] = { commit: git(root, ["rev-parse", "HEAD"]), files: hashes };
		saveManifest(root, feature, manifest);
		appendEvent(root, feature, "freeze", { phase, files: Object.keys(hashes) });
		return manifest.integrity[phase];
	});
}

function applyProtection(file, mode) {
	if (mode === "none") return "hash_only";
	const useFlags = mode === "flags" || (mode === "auto" && (process.platform === "darwin" || process.getuid?.() === 0));
	if (useFlags) {
		try {
			if (process.platform === "darwin") execFileSync("chflags", ["uchg", file]);
			else execFileSync("chattr", ["+i", file]);
			return process.platform === "darwin" ? "chflags" : "chattr";
		} catch {
			if (mode === "flags") fail("PROTECTION_FAILED", `Immutable flag failed for ${file}; requires root on linux. Use protection_mode chmod or none.`);
		}
	}
	fs.chmodSync(file, 0o444);
	return "chmod";
}

function removeProtection(file, method) {
	if (method === "chflags") execFileSync("chflags", ["nouchg", file]);
	else if (method === "chattr") execFileSync("chattr", ["-i", file]);
	else if (method === "chmod") fs.chmodSync(file, 0o644);
}

export function protect(root, feature, files) {
	return withLock(root, feature, () => {
		const manifest = loadManifest(root, feature);
		const file = protectedPath(featureDir(root, feature));
		const entries = fs.existsSync(file) ? readJson(file) : [];
		const known = new Set(entries.map((e) => e.path));
		for (const raw of files) {
			const resolved = resolveInsideRoot(root, raw);
			if (!fs.existsSync(resolved)) fail("MISSING_ARTIFACT", `Cannot protect missing file: ${raw}`);
			const rel = path.relative(root, resolved);
			if (known.has(rel)) continue;
			const method = applyProtection(resolved, manifest.options.protection_mode);
			entries.push({ path: rel, hash: hashFile(resolved), method });
		}
		atomicWriteJson(file, entries);
		manifest.integrity.protected_manifest_hash = hashObject(entries);
		saveManifest(root, feature, manifest);
		appendEvent(root, feature, "protect", { files: entries.map((e) => e.path) });
		return entries;
	});
}

export function unprotect(root, feature) {
	return withLock(root, feature, () => {
		const manifest = loadManifest(root, feature);
		if (!UNPROTECT_STATES.has(manifest.workflow.state)) {
			fail("UNPROTECT_FORBIDDEN", `Unprotect allowed only in ${[...UNPROTECT_STATES].join("/")}; state is ${manifest.workflow.state}.`);
		}
		const file = protectedPath(featureDir(root, feature));
		const entries = fs.existsSync(file) ? readJson(file) : [];
		for (const entry of entries) removeProtection(path.resolve(root, entry.path), entry.method);
		atomicWriteJson(file, []);
		manifest.integrity.protected_manifest_hash = hashObject([]);
		saveManifest(root, feature, manifest);
		appendEvent(root, feature, "unprotect", { files: entries.map((e) => e.path) });
		return { released: entries.length };
	});
}

export function verify(root, feature) {
	const manifest = loadManifest(root, feature);
	const problems = [];

	const file = protectedPath(featureDir(root, feature));
	const entries = fs.existsSync(file) ? readJson(file) : [];
	if (manifest.integrity.protected_manifest_hash && manifest.integrity.protected_manifest_hash !== hashObject(entries)) {
		problems.push({ code: "PROTECTED_MANIFEST_TAMPERED", path: path.relative(root, file) });
	}
	for (const entry of entries) {
		const target = path.resolve(root, entry.path);
		if (!fs.existsSync(target)) problems.push({ code: "PROTECTED_FILE_DELETED", path: entry.path });
		else if (hashFile(target) !== entry.hash) problems.push({ code: "PROTECTED_FILE_MODIFIED", path: entry.path });
	}

	for (const [phase, record] of Object.entries(manifest.integrity)) {
		if (typeof record !== "object" || !record.files) continue;
		for (const [rel, hash] of Object.entries(record.files)) {
			const target = path.resolve(root, rel);
			if (!fs.existsSync(target)) problems.push({ code: "FROZEN_ARTIFACT_DELETED", phase, path: rel });
			else if (hashFile(target) !== hash) problems.push({ code: "FROZEN_ARTIFACT_MODIFIED", phase, path: rel });
		}
	}

	if (manifest.repository.candidate_commit) {
		const head = git(root, ["rev-parse", "HEAD"]);
		if (head !== manifest.repository.candidate_commit) {
			problems.push({ code: "STALE_CANDIDATE", expected: manifest.repository.candidate_commit, actual: head });
		}
	}

	const status = worktreeStatus(root);
	return { ok: problems.length === 0, state: manifest.workflow.state, problems, untracked: status.untracked, modified: status.modified };
}

export function consumeBudget(root, feature, counter) {
	if (!BUDGET_COUNTERS.has(counter)) fail("UNKNOWN_BUDGET", `Unknown budget counter: ${counter}`);
	return withLock(root, feature, () => {
		const manifest = loadManifest(root, feature);
		if (manifest.budgets[counter] <= 0) fail("BUDGET_EXHAUSTED", `Budget exhausted: ${counter}. Transition to BUDGET_EXHAUSTED or ask the USER for a grant.`);
		manifest.budgets[counter] -= 1;
		saveManifest(root, feature, manifest);
		appendEvent(root, feature, "budget", { counter, remaining: manifest.budgets[counter] });
		return { counter, remaining: manifest.budgets[counter] };
	});
}

export function status(root, feature) {
	const manifest = loadManifest(root, feature);
	return {
		feature: manifest.feature,
		state: manifest.workflow.state,
		allowed_next: TRANSITIONS[manifest.workflow.state],
		repository: manifest.repository,
		budgets: manifest.budgets,
		options: manifest.options,
		challenges: manifest.challenges,
	};
}

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			const key = argv[i].slice(2);
			flags[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
		} else positional.push(argv[i]);
	}
	return { positional, flags };
}

function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const [command, feature, ...rest] = positional;
	const root = path.resolve(flags.root ?? process.cwd());

	const run = () => {
		switch (command) {
			case "init":
				return init(root, feature, {
					mode: flags.mode, title: flags.title, protection: flags.protection,
					challenges: flags.challenges ? flags.challenges.split(",") : [],
					testCommand: flags["test-command"], allowDirty: flags["allow-dirty"] === true,
					models: flags.models ? JSON.parse(flags.models) : {},
				});
			case "status": return status(root, feature);
			case "transition": return transition(root, feature, rest[0], { resultFile: flags.result });
			case "freeze": return freeze(root, feature, rest[0], (flags.files ?? "").split(",").filter(Boolean));
			case "protect": return protect(root, feature, rest);
			case "unprotect": return unprotect(root, feature);
			case "verify": return verify(root, feature);
			case "budget": return consumeBudget(root, feature, rest[0]);
			case "event": return appendEvent(root, feature, rest[0], flags.data ? JSON.parse(flags.data) : {});
			default:
				fail("USAGE", "Usage: tdd-engine.mjs <init|status|transition|freeze|protect|unprotect|verify|budget|event> <feature> [args] [--root DIR]");
		}
	};

	try {
		const output = run();
		process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		if (command === "verify" && !output.ok) process.exit(2);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code ?? "ENGINE_ERROR" })}\n`);
		process.exit(1);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
