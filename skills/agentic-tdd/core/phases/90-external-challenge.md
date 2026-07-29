# Phase: External challenge (optional)

Independent, read-only criticism of a frozen phase result by a fresh context — a
different model/CLI where available, else a fresh same-model context. Enabled per phase
at init (`options.challenges`); each invocation consumes
`budget <feature> external_challenges_remaining`.

## Lifecycle: PREPARE → REVIEW → INGEST → DISPOSITION

1. **PREPARE** — export a bounded, self-contained packet to
   `challenges/<phase>-<version>/request.md`: the phase's frozen artifacts, the specific
   challenge questions below, and the required response shape
   (`templates/challenge-response.json`). No author identity, no internal transcript, no
   persuasive rationale.
2. **REVIEW** — run `roles/external-challenger.md` with the packet, using
   `options.models.challenge` if set. Manual cross-CLI mode: hand `request.md` to the
   other CLI and save its `response.json`.
3. **INGEST** — validate the response is schema-shaped; record findings.
4. **DISPOSITION** — for each finding, the coordinator records exactly one:
   `ACCEPTED` (route to PLAN/LOOP/ASSESS) | `REJECTED_WITH_EVIDENCE` |
   `MORE_EVIDENCE_REQUIRED` | `USER_DECISION_REQUIRED` | `PARKED_NONBLOCKING` |
   `DUPLICATE`. Write `challenges/<phase>-<version>/disposition.json` and set
   `manifest.challenges.<phase>`.

## Phase-specific questions

- **plan**: LIGHT/FULL routing sound? contract ambiguous? oracle independent and
  domain-complete? missing failure modes, controls, or user questions?
- **loop**: drift from approved plan? scope expansion? concrete semantic/state/numerical
  defect? weakened tests, tolerances, benchmarks? suspicious special-casing? which
  scenarios should assessment prioritize?
- **assess**: every critical clause and risk control covered? claimed checks actually
  executed against the candidate commit? findings reproducible and correctly classified?
  high-impact hypothesis dismissed without evidence? verdict follows from evidence?

## Rules

- Critical/major findings require an executable check, trace, exact code-path argument,
  authoritative source, or numerical counterexample — otherwise non-blocking hypothesis.
- One challenge, one disposition, at most one targeted clarification. No critic-of-critic
  loops. The challenger never edits canonical artifacts; an unsupported hypothesis never
  causes code churn.
- Model consensus is not evidence; no vote count overrides a reproducible check.
