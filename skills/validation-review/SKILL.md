---
name: validation-review
description: Run a bounded test and review pass for completed or proposed changes. Use when the user asks to test, verify, review before merge, check requirements, run e2e/smoke tests, or make sure a change is not sloppy.
---

# Validation Review

Use this skill to answer: **is this change good enough to ship under the user's review budget?**

This is post-change validation, not open-ended debugging or architecture exploration. If checks expose a concrete failure, report it in the verdict; switch to `diagnose` only when the user asks to root-cause or fix it.

## 1. Set the budget

Identify or ask for:

```text
Scope: files/diff/branch/feature under review
Budget: max time, commands, subagents, and e2e depth
Required evidence: unit/integration/e2e/manual smoke/reviewer signoff
```

If no budget is given, use compact default:

- inspect diff and nearby tests
- run narrow relevant checks only
- use at most one focused subagent if it adds a distinct perspective
- ask before full-workspace, expensive, destructive, or full-e2e runs

## 2. Review matrix

Check four angles:

1. **Requirements** — does it satisfy the request and acceptance criteria?
2. **Logic** — edge cases, invariants, errors, state, concurrency, security.
3. **Evidence** — tests/e2e/smoke checks that prove behavior.
4. **Slop** — overbuild, fake confidence, brittle mocks, ignored failures, noisy docs.

For each angle, know what evidence would change the verdict.

## 3. Inspect and run checks

Use project-native facts: changed files, callers, tests, fixtures, project instructions, CI conventions, specs/issues/chains supplied by the user.

Prefer the narrowest meaningful command.

Rust examples:

```bash
cargo check -p <crate>
cargo test -p <crate> <filter> -- --nocapture
cargo nextest run -p <crate> <filter>
cargo clippy -p <crate> --all-targets --all-features
```

Use clippy/full workspace/e2e only when budget and project conventions justify it.

For servers, browsers, workers, or e2e flows:

- use Herdr for persistent servers/watchers; use `job_start` only for bounded commands
- wait for bounded readiness with `job_start` readiness watches
- run the smoke/e2e action with real assertions
- capture concise evidence
- stop bounded Jobs with `job_stop`

Do not dump large logs unless needed.

## 4. Use multiple perspectives

Use subagents only within the user's budget. Scope every task with `cwd`, exact files/diff, command limits, exclusions, and output shape.

Useful perspectives:

- `tester` — missing tests, test quality, e2e/smoke plan
- `reviewer` — requirements, correctness, maintainability
- `anti-slop` — overbuild, fake tests, ignored failures, vague docs
- `rust-dev` — Rust ownership, async, traits, feature flags, errors
- `devops` — CI, runtime config, deployment/process concerns

Prefer separate `subagent` calls with explicit `cwd` when cwd matters. Use `subagent_wait` for settlement/output and `/agents <run-id>` for artifact details.

Do not delegate what one local command or one file read can prove.

## 5. Judge test quality

Good evidence:

- exercises observable behavior through the right public seam
- would catch the regression or requirement gap
- is deterministic and appropriately narrow
- checks meaningful assertions, not just “does not crash”

Bad evidence:

- tests implementation details only
- snapshots/goldens updated without explanation
- mocks bypass the risky path
- e2e clicks/requests without assertions
- green checks unrelated to changed code

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
- tester/reviewer/anti-slop/rust-dev/devops: key finding or “not used: reason”

Remaining risk
- ...

Next action
- ...
```

Severity:

- **Blocker** — wrong behavior, data loss, security issue, or failing required check.
- **Major** — requirement gap, important edge case, or untested risky path.
- **Minor** — maintainability/cleanup issue.
- **Nit** — optional polish; never blocks shipping.

## Pitfalls

- Do not treat “tests pass” as proof requirements are met.
- Do not run expensive checks just to look thorough.
- Do not ignore failed commands.
- Do not create fake e2e coverage with unasserted actions.
- Do not let subagents broaden scope beyond budget.
- Do not ship with hidden uncertainty; name remaining risk.
