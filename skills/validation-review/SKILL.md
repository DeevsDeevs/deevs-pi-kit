---
name: validation-review
description: Run a bounded test and review pass for completed or proposed changes. Use when the user asks to test, verify, review before merge, check requirements, run e2e/smoke tests, or make sure a change is not sloppy.
---

# Validation Review

Answer one question: **is this change good enough to ship under the user's review budget?** This is post-change validation, not open-ended debugging — if checks expose a concrete failure, report it in the verdict; switch to `diagnose` only when asked to root-cause.

## 1. Set the budget

Identify or ask for scope (files/diff/branch), budget (max time, commands, subagents, e2e depth), and required evidence (unit/integration/e2e/manual smoke/signoff). Default budget when none given: inspect the diff and nearby tests, run narrow relevant checks, at most one focused subagent, and ask before full-workspace, expensive, destructive, or full-e2e runs.

## 2. Review matrix

Four angles — for each, know what evidence would change the verdict:

1. **Requirements** — satisfies the request and acceptance criteria?
2. **Logic** — edge cases, invariants, errors, state, concurrency, security.
3. **Evidence** — tests/e2e/smoke that prove behavior.
4. **Slop** — overbuild, fake confidence, brittle mocks, ignored failures, noisy docs.

## 3. Inspect and run checks

Use project-native facts (changed files, callers, tests, CI conventions, specs/chains) and the narrowest meaningful command — e.g. `cargo check -p <crate>`, `cargo test -p <crate> <filter>`, `cargo clippy -p <crate> --all-targets` — full workspace or e2e only when budget and conventions justify it.

Build a small dependency graph before running checks. Launch independent read-only checks and perspectives together; do not wait for typecheck before starting an unrelated docs/security review. Keep fix → targeted recheck and final-diff → review gates sequential. Do not parallelize commands that write the same outputs, contend heavily for the same resource, or would review a changing diff. Once the diff is frozen, full validation and independent final review should usually run concurrently, then be reconciled into one verdict.

For servers/browsers/e2e: Herdr for persistent processes; `job_start` with readiness watches for bounded commands; run the smoke action with real assertions; capture concise evidence; `job_stop` when done. No large log dumps.

## 4. Perspectives

Subagents only within budget, each scoped with `cwd`, exact files/diff, command limits, and output shape. Batch independent perspectives in one `tasks` group and settle it once with `subagent_wait`. Useful: `tester` (missing tests, e2e plan), `reviewer` (requirements, correctness), `anti-slop` (overbuild, fake tests), `rust-dev`, `devops`. Never delegate what one local command or file read proves.

A cross-session Mission takeover invalidates old running or awaiting-adjudication review state. Re-fingerprint the current workspace and obtain a fresh independent review before completion.

## 5. Judge test quality

Good evidence exercises observable behavior through the right public seam, would catch the regression, is deterministic, and asserts meaning — not just "does not crash". Bad evidence: implementation-detail tests, unexplained snapshot updates, mocks bypassing the risky path, e2e actions without assertions, green checks unrelated to the change.

## Verdict format

```text
Verdict: Ship | Ship with follow-ups | Do not ship yet

Requirements
- met/missing: ...

Checks run
- command/e2e action — pass/fail — what it proves

Review findings
- Blocker/Major/Minor/Nit — file/path — issue — recommended fix

Subagent perspectives
- persona: key finding or "not used: reason"

Remaining risk / Next action
- ...
```

Severity: **Blocker** wrong behavior, data loss, security, failing required check · **Major** requirement gap or untested risky path · **Minor** maintainability · **Nit** optional polish, never blocks.

## Pitfalls

- "Tests pass" is not proof requirements are met.
- Never run expensive checks just to look thorough, ignore failed commands, or fake e2e coverage with unasserted actions.
- Keep subagents inside budget; name remaining risk instead of shipping hidden uncertainty.
