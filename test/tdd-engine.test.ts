import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as engine from "../skills/agentic-tdd/core/scripts/tdd-engine.mjs";

const roots: string[] = [];

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

function result(root: string, phase: string, status: string, to: string): string {
	const file = path.join(root, `result-${phase}-${to}.json`);
	fs.writeFileSync(file, JSON.stringify({ phase, run_id: `${phase}-r1`, status, requested_transition: to }));
	return path.relative(root, file);
}

function advance(root: string, feature: string, steps: Array<[string, string?, string?]>): void {
	for (const [to, phase, status] of steps) {
		engine.transition(root, feature, to, phase ? { resultFile: result(root, phase, status ?? to, to) } : {});
	}
}

const TO_CLOSED: Array<[string, string?, string?]> = [
	["PLANNING"],
	["PLAN_READY", "plan", "PLAN_READY"],
	["PLAN_APPROVED", "plan", "PLAN_READY"],
	["LOOP_RUNNING"],
	["CANDIDATE_READY", "loop", "CANDIDATE_READY"],
	["ASSESSING"],
	["ASSESSMENT_READY", "assess", "PASS"],
	["ASSESSMENT_ACCEPTED", "assess", "PASS"],
	["RELEASING"],
	["CLOSED", "release", "RELEASE_APPROVED"],
];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("init", () => {
	it("creates a NEW manifest bound to the baseline commit", () => {
		const root = repo();
		const manifest = initFeature(root);
		expect(manifest.workflow.state).toBe("NEW");
		expect(manifest.repository.baseline_commit).toMatch(/^[0-9a-f]{40}$/);
		expect(manifest.repository.candidate_commit).toBeNull();
		expect(fs.existsSync(path.join(root, ".tdd/feat/manifest.json"))).toBe(true);
	});

	it("rejects re-init, bad feature ids, and unknown settings", () => {
		const root = repo();
		initFeature(root);
		expect(() => initFeature(root)).toThrow(/already exists/);
		expect(() => initFeature(root, "../evil")).toThrow(/Feature id/);
		expect(() => initFeature(root, "x", { protection: "prayer" })).toThrow(/protection_mode/);
	});

	it("rejects a dirty worktree unless allowDirty is set", () => {
		const root = repo();
		fs.writeFileSync(path.join(root, "src.txt"), "changed\n");
		expect(() => initFeature(root)).toThrow(/DIRTY|modified/i);
		expect(initFeature(root, "feat", { allowDirty: true }).workflow.state).toBe("NEW");
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
		advance(root, "feat", TO_CLOSED);
		expect(engine.status(root, "feat").state).toBe("CLOSED");
		expect(engine.status(root, "feat").allowed_next).toEqual([]);
	});

	it("rejects illegal transitions and unknown states", () => {
		const root = repo();
		initFeature(root);
		expect(() => engine.transition(root, "feat", "LOOP_RUNNING")).toThrow(/not a legal transition/);
		expect(() => engine.transition(root, "feat", "SHIPPED")).toThrow(/Unknown state/);
	});

	it("requires a schema-valid result for phase-exit transitions", () => {
		const root = repo();
		initFeature(root);
		engine.transition(root, "feat", "PLANNING");
		expect(() => engine.transition(root, "feat", "PLAN_READY")).toThrow(/requires a phase result/);

		const bad = path.join(root, "bad.json");
		fs.writeFileSync(bad, JSON.stringify({ phase: "plan", run_id: "r", status: "VIBES_GOOD", requested_transition: "PLAN_READY" }));
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: "bad.json" })).toThrow(/Unknown result status/);

		fs.writeFileSync(bad, JSON.stringify({ phase: "plan", run_id: "r", status: "PLAN_READY", requested_transition: "PLANNING" }));
		expect(() => engine.transition(root, "feat", "PLAN_READY", { resultFile: "bad.json" })).toThrow(/RESULT_MISMATCH|requests/);

		engine.transition(root, "feat", "PLAN_READY", { resultFile: result(root, "plan", "PLAN_READY", "PLAN_READY") });
		expect(engine.status(root, "feat").state).toBe("PLAN_READY");
	});

	it("binds the candidate commit and rejects stale assessment", () => {
		const root = repo();
		initFeature(root);
		advance(root, "feat", TO_CLOSED.slice(0, 5));
		const candidate = engine.status(root, "feat").repository as { candidate_commit: string };
		expect(candidate.candidate_commit).toMatch(/^[0-9a-f]{40}$/);

		fs.writeFileSync(path.join(root, "src.txt"), "moved on\n");
		execFileSync("git", ["commit", "-aqm", "unrelated"], { cwd: root });
		expect(() => engine.transition(root, "feat", "ASSESSING")).toThrow(/STALE_CANDIDATE|does not match/);
	});

	it("refuses writes while another writer holds the lock", () => {
		const root = repo();
		initFeature(root);
		fs.mkdirSync(path.join(root, ".tdd/feat/.lock"));
		expect(() => engine.transition(root, "feat", "PLANNING")).toThrow(/locked/i);
		fs.rmdirSync(path.join(root, ".tdd/feat/.lock"));
		expect(engine.transition(root, "feat", "PLANNING").state).toBe("PLANNING");
	});
});

describe("protected surfaces", () => {
	it("detects modification and deletion of protected files", () => {
		const root = repo();
		initFeature(root);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert a\n");
		fs.writeFileSync(path.join(root, "test-b.txt"), "assert b\n");
		engine.protect(root, "feat", ["test-a.txt", "test-b.txt"]);
		expect(engine.verify(root, "feat").ok).toBe(true);

		fs.chmodSync(path.join(root, "test-a.txt"), 0o644);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert weakened\n");
		fs.rmSync(path.join(root, "test-b.txt"));
		const report = engine.verify(root, "feat");
		expect(report.ok).toBe(false);
		expect(report.problems.map((p) => p.code).sort()).toEqual(["PROTECTED_FILE_DELETED", "PROTECTED_FILE_MODIFIED"]);
	});

	it("detects tampering with the protected manifest itself", () => {
		const root = repo();
		initFeature(root);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert a\n");
		engine.protect(root, "feat", ["test-a.txt"]);
		const manifestFile = path.join(root, ".tdd/feat/protected-manifest.json");
		fs.writeFileSync(manifestFile, JSON.stringify([]));
		expect(engine.verify(root, "feat").problems.some((p) => p.code === "PROTECTED_MANIFEST_TAMPERED")).toBe(true);
	});

	it("rejects path escapes and symlinks", () => {
		const root = repo();
		initFeature(root);
		expect(() => engine.protect(root, "feat", ["../outside.txt"])).toThrow(/escapes repository root/);
		fs.symlinkSync(path.join(root, "src.txt"), path.join(root, "sneaky.txt"));
		expect(() => engine.protect(root, "feat", ["sneaky.txt"])).toThrow(/Symlinks/);
	});

	it("allows unprotect only in terminal states", () => {
		const root = repo();
		initFeature(root);
		fs.writeFileSync(path.join(root, "test-a.txt"), "assert a\n");
		engine.protect(root, "feat", ["test-a.txt"]);
		expect(() => engine.unprotect(root, "feat")).toThrow(/Unprotect allowed only/);

		advance(root, "feat", TO_CLOSED);
		expect(engine.unprotect(root, "feat").released).toBe(1);
		fs.accessSync(path.join(root, "test-a.txt"), fs.constants.W_OK);
	});
});

describe("freeze and budgets", () => {
	it("detects drift in frozen planning artifacts", () => {
		const root = repo();
		initFeature(root);
		const contract = path.join(root, ".tdd/feat/plan/contract.json");
		fs.writeFileSync(contract, JSON.stringify({ invariants: ["INV-1"] }));
		engine.freeze(root, "feat", "plan", [path.relative(root, contract)]);
		expect(engine.verify(root, "feat").ok).toBe(true);

		fs.writeFileSync(contract, JSON.stringify({ invariants: [] }));
		expect(engine.verify(root, "feat").problems.some((p) => p.code === "FROZEN_ARTIFACT_MODIFIED")).toBe(true);
	});

	it("consumes budgets monotonically and fails at zero", () => {
		const root = repo();
		initFeature(root);
		expect(engine.consumeBudget(root, "feat", "implementation_repairs_remaining").remaining).toBe(0);
		expect(() => engine.consumeBudget(root, "feat", "implementation_repairs_remaining")).toThrow(/Budget exhausted/);
		expect(() => engine.consumeBudget(root, "feat", "vibes_remaining")).toThrow(/Unknown budget/);
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
