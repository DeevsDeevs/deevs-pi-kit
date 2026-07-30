import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../skills/agentic-tdd/core/scripts/tdd-engine.mjs";

const roots: string[] = [];
const PASS_CHECK = [process.execPath, "-e", "process.exit(0)"];
const FAIL_CHECK = [process.execPath, "-e", "process.exit(1)"];

function repo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdd-engine-"));
	roots.push(root);
	const g = (...args: string[]) => execFileSync("git", args, { cwd: root });
	g("init", "-q");
	g("config", "user.email", "t@example.com");
	g("config", "user.name", "t");
	fs.writeFileSync(path.join(root, "src.txt"), "code\n");
	fs.writeFileSync(path.join(root, ".gitignore"), ".tdd/\n");
	g("add", "src.txt", ".gitignore");
	g("commit", "-qm", "init");
	return root;
}

// Tests use protection "chmod"; immutable flags would survive rmSync cleanup.
const initFeature = (root: string, feature = "feat", options = {}) =>
	engine.init(root, feature, { protection: "chmod", ...options });

// Artifact files live under gitignored .tdd so they never drift the candidate tree.
function artifact(root: string, name: string, body: unknown): string {
	const file = path.join(root, ".tdd/feat/results", name);
	fs.writeFileSync(file, JSON.stringify(body));
	return path.relative(root, file);
}

const res = (root: string, phase: string, status: string, to: string) =>
	artifact(root, `${phase}-${to}.json`, { phase, run_id: `${phase}-r1`, status, requested_transition: to });

function advance(root: string, feature: string, steps: Array<[string, string?, string?]>): void {
	for (const [to, phase, status] of steps) {
		engine.transition(root, feature, to, phase ? { resultFile: res(root, phase, status ?? to, to) } : {});
	}
}

const TO_ASSESSING: Array<[string, string?, string?]> = [
	["PLANNING"],
	["PLAN_READY", "plan", "PLAN_READY"],
	["PLAN_APPROVED", "plan", "PLAN_READY"],
	["LOOP_RUNNING"],
	["CANDIDATE_READY", "loop", "CANDIDATE_READY"],
	["ASSESSING"],
];

function toReleasing(root: string, feature = "feat"): void {
	advance(root, feature, TO_ASSESSING);
	engine.runCheck(root, feature, "acceptance-tests", PASS_CHECK);
	advance(root, feature, [
		["ASSESSMENT_READY", "assess", "PASS"],
		["ASSESSMENT_ACCEPTED", "assess", "PASS"],
		["RELEASING"],
	]);
}

function toClosed(root: string, feature = "feat"): void {
	toReleasing(root, feature);
	const tree = engine.status(root, feature).repository.candidate_tree;
	engine.reviewIngest(root, feature, artifact(root, "review.json", { decision: "RELEASE_APPROVED", candidate_tree: tree }));
	advance(root, feature, [["CLOSED", "release", "RELEASE_APPROVED"]]);
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("init", () => {
	it("creates a NEW manifest bound to the baseline commit", () => {
		const root = repo();
		const manifest = initFeature(root);
		expect(manifest.workflow.state).toBe("NEW");
		expect(manifest.feature.depth).toBe("auto");
		expect(manifest.repository.baseline_commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.repository.candidate_tree).toBeNull();
	});

	it("rejects re-init, bad feature ids, and unknown settings", () => {
		const root = repo();
		initFeature(root);
		expect(() => initFeature(root)).toThrow(/already exists/);
		expect(() => initFeature(root, "../evil")).toThrow(/Feature id/);
		expect(() => initFeature(root, "x", { protection: "prayer" })).toThrow(/protection_mode/);
		expect(() => initFeature(root, "y", { depth: "medium" })).toThrow(/depth/);
	});

	it("rejects a dirty worktree and reports exact unmangled paths", () => {
		const root = repo();
		fs.writeFileSync(path.join(root, "src.txt"), "changed\n");
		expect(() => initFeature(root)).toThrow(/src\.txt/);
		const manifest = initFeature(root, "feat", { allowDirty: true });
		expect(manifest.workflow.state).toBe("NEW");
		expect(engine.verify(root, "feat").modified).toEqual(["src.txt"]);
	});

	it("detects the repository test command", () => {
		const root = repo();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
		expect(initFeature(root).repository.test_command).toBe("npm test");
	});
});

describe("transitions", () => {
	it("walks the full happy path to CLOSED", () => {
		const root = repo();
		initFeature(root);
		toClosed(root);
		expect(engine.status(root, "feat").state).toBe("CLOSED");
		expect(engine.status(root, "feat").allowed_next).toEqual([]);
	});

	it("rejects illegal transitions and unknown states", () => {
		const root = repo();
		initFeature(root);
		expect(() => engine.transition(root, "feat", "LOOP_RUNNING")).toThrow(/not a legal transition/);
		expect(() => engine.transition(root, "feat", "SHIPPED")).toThrow(/Unknown state/);
	});

	it("binds results to edges: phase and status must match the transition", () => {
		const root = repo();
		initFeature(root);
		engine.transition(root, "feat", "PLANNING");
		expect(() => engine.transition(root, "feat", "PLAN_READY")).toThrow(/requires a phase result/);
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "release", "RELEASE_APPROVED", "PLAN_READY") }))
			.toThrow(/accepts result phases/);
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "plan", "WAITING_FOR_USER", "PLAN_READY") }))
			.toThrow(/accepts statuses/);
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "plan", "PLAN_READY", "PLANNING") }))
			.toThrow(/requests PLANNING/);
		engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "plan", "PLAN_READY", "PLAN_READY") });
		expect(engine.status(root, "feat").state).toBe("PLAN_READY");
	});

	it("snapshots the uncommitted candidate and rejects drift before assessment", () => {
		const root = repo();
		initFeature(root);
		advance(root, "feat", TO_ASSESSING.slice(0, 4));
		fs.writeFileSync(path.join(root, "src.txt"), "the actual candidate\n");
		advance(root, "feat", [["CANDIDATE_READY", "loop", "CANDIDATE_READY"]]);

		const status = engine.status(root, "feat");
		expect(status.repository.candidate_tree).toMatch(/^[0-9a-f]{40}$/);
		expect(status.repository.candidate_commit).not.toBe(status.repository.baseline_commit);
		expect(engine.verify(root, "feat").ok).toBe(true);

		fs.writeFileSync(path.join(root, "src.txt"), "post-freeze tamper\n");
		expect(engine.verify(root, "feat").problems.map((p) => p.code)).toContain("CANDIDATE_TREE_DRIFT");
		expect(() => engine.transition(root, "feat", "ASSESSING")).toThrow(/CANDIDATE_TREE_DRIFT/);
	});

	it("routes contract defects from ASSESSING back to PLANNING", () => {
		const root = repo();
		initFeature(root);
		advance(root, "feat", TO_ASSESSING);
		engine.transition(root, "feat", "PLANNING", { resultFile: res(root, "assess", "PLAN_AMENDMENT_REQUIRED", "PLANNING") });
		expect(engine.status(root, "feat").state).toBe("PLANNING");
	});

	it("refuses writes under a held lock and recovers stale locks", () => {
		const root = repo();
		initFeature(root);
		const lock = path.join(root, ".tdd/feat/.lock");
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, "meta.json"), JSON.stringify({ pid: 999999999, host: os.hostname(), started_at: new Date().toISOString() }));
		expect(() => engine.transition(root, "feat", "PLANNING")).toThrow(/locked/i);
		expect(() => engine.unlock(root, "feat")).toThrow(/Refusing to unlock/);
		expect(engine.unlock(root, "feat", { stale: true })).toMatchObject({ released: true, reason: "dead_holder" });
		expect(engine.transition(root, "feat", "PLANNING").state).toBe("PLANNING");
	});
});

describe("protected surfaces", () => {
	it("detects modification and deletion, and blocks transitions on drift", () => {
		const root = repo();
		initFeature(root);
		engine.transition(root, "feat", "PLANNING");
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert a\n");
		fs.writeFileSync(path.join(root, "test-b.txt"), "assert b\n");
		engine.protect(root, "feat", ["test-a.txt", "test-b.txt"]);
		expect(engine.verify(root, "feat").ok).toBe(true);

		fs.chmodSync(path.join(root, "test-a.txt"), 0o644);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert weakened\n");
		fs.rmSync(path.join(root, "test-b.txt"));
		const report = engine.verify(root, "feat");
		expect(report.problems.map((p) => p.code).sort()).toEqual(["PROTECTED_FILE_DELETED", "PROTECTED_FILE_MODIFIED"]);
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "plan", "PLAN_READY", "PLAN_READY") }))
			.toThrow(/PROTECTED_FILE_MODIFIED/);
	});

	it("detects tampering with the protected manifest itself", () => {
		const root = repo();
		initFeature(root);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert a\n");
		engine.protect(root, "feat", ["test-a.txt"]);
		fs.writeFileSync(path.join(root, ".tdd/feat/protected-manifest.json"), JSON.stringify([]));
		expect(engine.verify(root, "feat").problems.some((p) => p.code === "PROTECTED_MANIFEST_TAMPERED")).toBe(true);
	});

	it("rejects escapes, direct symlinks, and symlinked ancestors", () => {
		const root = repo();
		initFeature(root);
		engine.transition(root, "feat", "PLANNING");
		expect(() => engine.protect(root, "feat", ["../outside.txt"])).toThrow(/escapes repository root/);

		fs.symlinkSync(path.join(root, "src.txt"), path.join(root, "sneaky.txt"));
		expect(() => engine.protect(root, "feat", ["sneaky.txt"])).toThrow(/Symlink/);

		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tdd-outside-"));
		roots.push(outside);
		fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
		fs.symlinkSync(outside, path.join(root, "linked"));
		expect(() => engine.freeze(root, "feat", "plan", ["linked/secret.txt"])).toThrow(/Symlink/);
	});

	it("allows unprotect only in terminal states", () => {
		const root = repo();
		initFeature(root);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert a\n");
		engine.protect(root, "feat", ["test-a.txt"]);
		expect(() => engine.unprotect(root, "feat")).toThrow(/Unprotect allowed only/);
		toClosed(root);
		expect(engine.unprotect(root, "feat").released).toBe(1);
		fs.accessSync(path.join(root, "test-a.txt"), fs.constants.W_OK);
	});
});

describe("challenge gates", () => {
	it("blocks approval while an enabled challenge is unresolved; skip requires a reason", () => {
		const root = repo();
		initFeature(root, "feat", { challenges: ["plan"] });
		advance(root, "feat", [["PLANNING"], ["PLAN_READY", "plan", "PLAN_READY"]]);
		expect(() => engine.transition(root, "feat", "PLAN_APPROVED", { resultFile: res(root, "plan", "PLAN_READY", "PLAN_APPROVED") }))
			.toThrow(/CHALLENGE_PENDING|disposition or skip/);
		expect(() => engine.challengeSkip(root, "feat", "plan", "")).toThrow(/reason/);
		engine.challengeSkip(root, "feat", "plan", "user waived after review");
		engine.transition(root, "feat", "PLAN_APPROVED", { resultFile: res(root, "plan", "PLAN_READY", "PLAN_APPROVED") });
		expect(engine.status(root, "feat").state).toBe("PLAN_APPROVED");
	});

	it("runs prepare → ingest → dispose and protects critical findings from prose dismissal", () => {
		const root = repo();
		initFeature(root, "feat", { challenges: ["plan"] });
		advance(root, "feat", [["PLANNING"], ["PLAN_READY", "plan", "PLAN_READY"]]);
		expect(engine.challengePrepare(root, "feat", "plan").state).toBe("prepared");

		expect(() => engine.challengeIngest(root, "feat", "plan",
			artifact(root, "bad-response.json", { verdict: { value: "VIBES" }, findings: [] }))).toThrow(/verdict/);
		engine.challengeIngest(root, "feat", "plan", artifact(root, "response.json", {
			verdict: { value: "PLAN_REVISION_REQUIRED" },
			findings: [{ id: "F-1", severity: "critical", claim: "Contract misses sequence reset." }],
			provenance: { model: "other-model" },
		}));

		expect(() => engine.challengeDispose(root, "feat", "plan",
			artifact(root, "d1.json", { dispositions: [{ finding: "F-1", disposition: "PARKED_NONBLOCKING" }] }))).toThrow(/cannot be parked/);
		expect(() => engine.challengeDispose(root, "feat", "plan",
			artifact(root, "d2.json", { dispositions: [{ finding: "F-1", disposition: "REJECTED_WITH_EVIDENCE", evidence: [] }] }))).toThrow(/requires evidence/);
		engine.challengeDispose(root, "feat", "plan",
			artifact(root, "d3.json", { dispositions: [{ finding: "F-1", disposition: "ACCEPTED" }] }));
		expect(engine.status(root, "feat").challenges.plan.state).toBe("dispositioned");
	});

	it("consumes the external challenge budget at prepare", () => {
		const root = repo();
		initFeature(root, "feat", { depth: "light", challenges: ["plan"] });
		advance(root, "feat", [["PLANNING"], ["PLAN_READY", "plan", "PLAN_READY"]]);
		engine.challengePrepare(root, "feat", "plan");
		engine.challengeSkip(root, "feat", "plan", "restart");
		expect(() => engine.challengePrepare(root, "feat", "plan")).toThrow(/Budget exhausted/);
	});
});

describe("questions and budgets", () => {
	it("blocks checkpoints while blocking questions are open", () => {
		const root = repo();
		initFeature(root);
		engine.transition(root, "feat", "PLANNING");
		engine.questionOpen(root, "feat", artifact(root, "q1.json", { id: "UQ-1", class: "BLOCKING_DOMAIN", question: "Reject or best-effort after a gap?" }));
		engine.questionOpen(root, "feat", artifact(root, "q2.json", { id: "UQ-2", class: "NONBLOCKING_ASSUMPTION", question: "Naming?" }));
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "plan", "PLAN_READY", "PLAN_READY") }))
			.toThrow(/blocking user question/);
		engine.questionAnswer(root, "feat", "UQ-1", "strict_resync");
		engine.transition(root, "feat", "PLAN_READY", { resultFile: res(root, "plan", "PLAN_READY", "PLAN_READY") });
		expect(engine.status(root, "feat").unresolved_blocking).toBe(0);
	});

	it("consumes budgets monotonically; grants require authority and restore headroom", () => {
		const root = repo();
		initFeature(root, "feat", { depth: "light" });
		expect(engine.consumeBudget(root, "feat", "implementation_repairs").remaining).toBe(0);
		expect(() => engine.consumeBudget(root, "feat", "implementation_repairs")).toThrow(/Budget exhausted/);
		expect(() => engine.grantBudget(root, "feat", "implementation_repairs", 1, "")).toThrow(/authorized-by/);
		expect(engine.grantBudget(root, "feat", "implementation_repairs", 2, "user").remaining).toBe(2);
		expect(engine.consumeBudget(root, "feat", "implementation_repairs").remaining).toBe(1);
	});

	it("set-depth works only during PLANNING and rescales budgets", () => {
		const root = repo();
		initFeature(root);
		expect(() => engine.setDepth(root, "feat", "full")).toThrow(/PLANNING/);
		engine.transition(root, "feat", "PLANNING");
		engine.setDepth(root, "feat", "full", { evidence: "stateful + no oracle" });
		expect(engine.status(root, "feat").budgets.planning_revisions).toBe(3);
		expect(engine.status(root, "feat").required_check_ids).toContain("build");
	});
});

describe("evidence execution and release gates", () => {
	it("requires a passing engine-executed check bound to the candidate", () => {
		const root = repo();
		initFeature(root);
		advance(root, "feat", TO_ASSESSING);
		expect(() => engine.transition(root, "feat", "ASSESSMENT_READY", { resultFile: res(root, "assess", "PASS", "ASSESSMENT_READY") }))
			.toThrow(/REQUIRED_CHECKS_MISSING|acceptance-tests/);

		const failing = engine.runCheck(root, "feat", "acceptance-tests", FAIL_CHECK);
		expect(failing.exit_code).toBe(1);
		expect(failing.bound_to_candidate).toBe(true);
		expect(() => engine.transition(root, "feat", "ASSESSMENT_READY", { resultFile: res(root, "assess", "PASS", "ASSESSMENT_READY") }))
			.toThrow(/acceptance-tests/);

		const passing = engine.runCheck(root, "feat", "acceptance-tests", PASS_CHECK);
		expect(passing).toMatchObject({ exit_code: 0, bound_to_candidate: true, seq: 2, truncated: false });
		engine.transition(root, "feat", "ASSESSMENT_READY", { resultFile: res(root, "assess", "PASS", "ASSESSMENT_READY") });
		expect(engine.status(root, "feat").state).toBe("ASSESSMENT_READY");
	});

	it("closes only with a reviewer report bound to the exact candidate tree", () => {
		const root = repo();
		initFeature(root);
		toReleasing(root);
		expect(() => engine.transition(root, "feat", "CLOSED", { resultFile: res(root, "release", "RELEASE_APPROVED", "CLOSED") }))
			.toThrow(/REVIEW_MISSING|reviewer decision/);
		expect(() => engine.reviewIngest(root, "feat", artifact(root, "stale-review.json", { decision: "RELEASE_APPROVED", candidate_tree: "deadbeef" })))
			.toThrow(/REVIEW_STALE|exact current candidate_tree/);

		const tree = engine.status(root, "feat").repository.candidate_tree;
		engine.reviewIngest(root, "feat", artifact(root, "review.json", { decision: "RELEASE_APPROVED", candidate_tree: tree }));
		engine.transition(root, "feat", "CLOSED", { resultFile: res(root, "release", "RELEASE_APPROVED", "CLOSED") });
		expect(engine.status(root, "feat").state).toBe("CLOSED");
	});

	it("creates a detached assessment worktree at the candidate snapshot", () => {
		const root = repo();
		initFeature(root);
		advance(root, "feat", TO_ASSESSING.slice(0, 4));
		fs.writeFileSync(path.join(root, "src.txt"), "candidate body\n");
		advance(root, "feat", [["CANDIDATE_READY", "loop", "CANDIDATE_READY"]]);

		const worktree = engine.assessWorktree(root, "feat") as { path: string };
		expect(fs.readFileSync(path.join(worktree.path, "src.txt"), "utf8")).toBe("candidate body\n");
		engine.assessWorktree(root, "feat", { remove: true });
		expect(fs.existsSync(worktree.path)).toBe(false);
	});

	it("rejects expired waivers at authorization time", () => {
		const root = repo();
		initFeature(root);
		expect(() => engine.waiverAuthorize(root, "feat", artifact(root, "w1.json", { id: "W-1", authorized_by: "user", rationale: "r", expires: "2001-01-01" })))
			.toThrow(/future date/);
		expect(engine.waiverAuthorize(root, "feat", artifact(root, "w2.json", { id: "W-2", authorized_by: "user", rationale: "r", expires: "2999-01-01" })).id).toBe("W-2");
	});
});

describe("runs and audit log", () => {
	it("publishes transactional run directories and tracks the current run", () => {
		const root = repo();
		initFeature(root);
		const begun = engine.runBegin(root, "feat", "plan");
		expect(begun.run_id).toBe("v001");
		expect(fs.existsSync(path.join(root, ".tdd/feat/plan/v001.partial"))).toBe(true);
		engine.runPublish(root, "feat", "plan", "v001");
		expect(fs.existsSync(path.join(root, ".tdd/feat/plan/v001"))).toBe(true);
		expect(engine.status(root, "feat").current.plan_version).toBe("v001");
		expect(() => engine.runPublish(root, "feat", "plan", "v001")).toThrow(/No partial run/);
	});

	it("appends an auditable event log", () => {
		const root = repo();
		initFeature(root);
		engine.transition(root, "feat", "PLANNING");
		const events = fs.readFileSync(path.join(root, ".tdd/feat/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(events.map((e) => e.type)).toEqual(["init", "transition"]);
		expect(events[1]).toMatchObject({ from: "NEW", to: "PLANNING" });
	});
});
