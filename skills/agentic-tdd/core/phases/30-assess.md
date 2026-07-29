# Phase: ASSESS

Attempt to falsify that the candidate satisfies the frozen plan and contract.
Fresh context, initially read-only. Assessment never silently repairs code.

## Enter

`engine transition <feature> ASSESSING` — the engine rejects a HEAD that is not the
candidate commit. `engine verify <feature>` must be clean.

Spawn assessment packets fresh: logic-hunter (semantic), tester-qa (verification), plus
language/systems review where the profile requires. Packets receive: feature brief,
frozen plan/contract/oracle, baseline+candidate commits, diff, protected test manifest,
loop handoff and discoveries, challenge focus items. They do NOT receive the
implementation transcript, developer confidence, or failed-approach narratives.

## Layers

A. **Artifact integrity** — `engine verify` plus: did the candidate weaken/skip tests,
   change tolerances, replace reference outputs, alter benchmark inputs, disable checks,
   expand scope beyond the plan? Any hit is a finding, not a discussion.
B. **Deterministic verification** — run the applicable subset per profile: clean build,
   unit/integration, protected acceptance tests, property/metamorphic, differential,
   replay, fuzz, sanitizers, static analysis, performance protocol. Record real command
   outputs in `assess/run-NNN/` result files.
C. **Semantic** — P/Q/invariant conformance, violation and recovery policy, numerical
   and rounding semantics, temporal ordering, sequence/duplicate/gap/reset/idempotence,
   oracle applicability and common-mode risk, lookahead/data leakage, downstream
   compatibility.
D. **Systems** (per profile) — lifetime/ownership, UB, overflow/narrowing, exceptions,
   atomics and memory ordering, races, allocations and layout on hot paths, build flags.

## Findings

Every blocking finding follows `templates/finding.json`: falsifiable claim, violated
clause or exact code path, evidence or minimal counterexample, discriminating check,
route. Routing: implementation defect / test hole → tester-qa **adds** a protected
failing test (add-only; never modify existing), then `CHANGES_REQUIRED → LOOP_RUNNING`;
contract/architecture defect → `PLANNING`; oracle disagreement → `PLANNING` or user
authority; missing/noisy evidence → rerun ASSESS; waiver-class decisions →
`WAITING_FOR_USER_ASSESS`.

The assessor never asks the USER to judge ordinary technical correctness.

## Exit

`assess/run-NNN/`: `assessment.md`, `findings.json`, `verdict.json`, machine results,
`result.json` with status `PASS | PASS_WITH_NONBLOCKING_FINDINGS | CHANGES_REQUIRED |
PLAN_AMENDMENT_REQUIRED | HUMAN_DECISION_REQUIRED | ASSESSMENT_INCONCLUSIVE |
BUDGET_EXHAUSTED`.

```text
engine transition <feature> ASSESSMENT_READY --result .tdd/<feature>/assess/run-NNN/result.json
```

If `options.challenges.assess`: run `phases/90-external-challenge.md` (it challenges the
assessment's coverage and verdict, not a free-form re-review), then
`transition ASSESSMENT_ACCEPTED`. Otherwise transition directly.
