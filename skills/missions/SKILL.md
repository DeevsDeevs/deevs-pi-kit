---
name: missions
description: Create, continue, take over, update, checkpoint, review, and complete durable Missions. Use when the user asks for a continuing autonomous objective, resumes Mission work, references a Mission owned by another or broken Pi session, or asks to finish/audit a Mission.
---

# Missions

Missions are durable single-controller workspace objectives. Canonical state lives under `.missions/.state/<slug>.json`; session entries are transcript mirrors and per-Mission markdown directories are generated projections.

## Normal flow

1. Use `mission_create` only when the user explicitly requests a continuing objective.
2. Use `mission_get` before continuing known Mission work.
3. If this session controls a paused/blocked Mission and the user authorizes continuation, call `mission_resume` before substantive work.
4. Record material milestones, validation, review adjudication, and genuine typed blockers with `mission_progress`. Candidate supersession is recovery, not reviewer failure; only typed launch/runtime/report failures consume the failure circuit.
5. The first review covers the typed Mission scope. After changes are requested, commit one bounded correction: Runtime persists accepted findings plus exact base/head and changed paths, then counts blocker/major only when linked to an enforced path and accepted requirement or typed security/data-loss impact. Unrelated discoveries become follow-up work.
6. Complete only after requirement audit, validation, review, settlement, and Chain gates pass.

## Cross-session takeover

Use `mission_takeover` only when the user explicitly asks to continue a Mission from another stopped or broken Pi session.

- Read `mission_get` first and use the exact Mission id or artifact slug.
- Confirm that the previous Pi session is stopped; takeover does not kill it or its Jobs/Subagents.
- Record a concrete takeover reason.
- Takeover resumes immediately when limits permit, carries progress/usage, creates a new generation, preserves an unchanged exact adjudicated candidate and completion latch, and recovers unresolved or changed review state.
- If takeover lands in a limit state, revise the limit only with explicit user authorization, then call `mission_resume`.
- Never reconstruct Mission authority from `mission.md` or `log.md`; legacy recovery must use the exact same-cwd Pi session branch.
- Never attempt multi-writer Mission collaboration. A foreign controller must be taken over explicitly or left alone.

Human command: `/mission takeover [mission-id-or-artifact-slug]`.

## Guardrails

- Treat malformed, missing, ambiguous, symlinked, or concurrently changed machine state as a blocker.
- Do not bypass credentials, safety, irreversible actions, tool confirmations, budgets, review, child settlement, or Chain checkpoints.
- After takeover, obtain fresh independent review unless the exact unchanged candidate already has a durable adjudication or user-authorized completion latch with its converged disposition; old running or awaiting-adjudication review state is invalid and must be recovered.
