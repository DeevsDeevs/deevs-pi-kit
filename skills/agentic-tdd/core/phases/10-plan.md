# Phase: PLAN

Define what correct behavior means, how the change fits the repository, how it will be
falsified, and whether LIGHT or FULL depth is justified.

## Enter

`transition <feature> PLANNING`. Read `.tdd/memory.jsonl` and prior `decisions/` if present.

## Steps

1. **Engineering intake** — localize affected components and downstream consumers;
   identify state ownership, temporal assumptions, concurrency, and hot-path impact;
   find precedents, existing tests, oracles, and benchmark infrastructure. Confirm or
   revise LIGHT/FULL with evidence (any high-risk dimension routes FULL: new domain
   semantics, statefulness, concurrency, missing oracle, irreversibility, hot path,
   uncertain blast radius, weak production detection). Write `plan/vNNN/intake.json`.
2. **Role briefs** — spawn fresh-context critiques in parallel (architect, logic-hunter,
   tester-qa packets from `roles/`), full mode or where risk warrants. Architect: design,
   seams, dependencies, rollout. Logic-hunter: contract (P, Q, invariants, violation
   policy, tolerances), oracle candidates with provenance. Tester-qa: partitions,
   adversarial cases, testability objections.
3. **User-question gate** — after evidence gathering, batch blocking domain/policy
   questions (`templates/question.json`). If any `BLOCKING_*` remains unanswered:
   `transition WAITING_FOR_USER_PLAN` and stop.
4. **Synthesis and critique** — developer critiques feasibility and test seams;
   tester-qa checks falsifiability; logic-hunter checks semantic coverage and oracle
   domain; architect checks composition and downstream effects.
5. **Gate** — write `plan/vNNN/`: `plan.md`, `architecture.md`, `contract.json` (stable
   clause IDs), `oracle.json` (provenance, independence, domain, exclusions),
   `risks.json`, `test-plan.md`, `performance-plan.json` (hot path only), `result.json`.

## Exit requirements

Affected components enumerated with evidence; contract explicit (P/Q/invariants/violation
policy/tolerances); oracle provenance recorded — for high-risk logic, two independent
evidence sources; risks mapped to planned controls; QA has a path to discriminating
tests; developer confirms seams are implementable; no blocking question open.

Then:

```text
engine freeze <feature> plan --files .tdd/<feature>/plan/vNNN/contract.json,.tdd/<feature>/plan/vNNN/oracle.json,...
engine transition <feature> PLAN_READY --result .tdd/<feature>/plan/vNNN/result.json
```

If `options.challenges.plan`: run `phases/90-external-challenge.md`, then
`transition PLAN_APPROVED`. Otherwise `transition PLAN_APPROVED` directly (record the
challenge as `not_invoked`).

## Revision

Amendments consume `budget <feature> planning_revisions_remaining` and produce a new
`plan/vNNN`; downstream evidence bound to older versions is invalid. Statuses:
`PLAN_READY | WAITING_FOR_USER | NEEDS_REPOSITORY_EVIDENCE | NEEDS_HUMAN_DOMAIN_INPUT |
ESCALATE_FULL | BUDGET_EXHAUSTED`.
