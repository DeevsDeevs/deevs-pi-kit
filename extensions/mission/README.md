# Mission

Branch-scoped autonomous objectives using Pi 0.82 lifecycle and session entries.

## Commands

```text
/mission <objective> [--name title] [--req criterion] [--budget 200k] [--cost $2] [--chain name]
/mission status
/mission pause
/mission resume
/mission clear
/mission complete   # explicit human command; aliases: end, stop
```

## Tools

```text
mission_get
mission_resume
mission_create
mission_update
mission_progress
mission_search
mission_complete
```

## Runtime behavior

- Active Mission authorization survives restart and permits reversible best judgment without routine questions.
- Authorization never auto-approves tools or crosses credential, safety, irreversible, or material approval boundaries.
- Autonomous continuation normally advances from `agent_settled`, using a hidden triggering `followUp` after idle/user-priority admission.
- Session start/tree recovery reconciles already-settled reviews, and the Subagent executor wakes Mission directly when its reviewer settles; no parent model turn or polling is required.
- A failed synchronous follow-up admission gets one delayed retry. Mission does not use Cron or polling loops: session Cron cannot recover a closed Pi process, while reopening the exact session re-arms Mission from durable state.
- Interrupt pauses; retryable provider behavior remains Pi-owned; terminal errors, recurring blockers, budget limits, and usage limits have distinct states.
- Paused/blocked state is injected into every model turn with the exact Chain, artifact path, and recorded next work. `mission_resume` lets the agent resume only after explicit user authorization or resolution of the recorded blocker.
- The dashboard intentionally omits a one-key destructive End action; type `/mission end` for the explicit human confirmation path.
- Objective edits create a new objective version and require a reason.
- Mission `paths` are typed cwd-relative ownership scope. When cwd is a non-Git workspace containing several repositories, each path resolves to its canonical containing Git root; fingerprints combine scoped HEAD/diff/untracked state per root, and missing/escaping/non-Git paths fail review and completion closed.
- Wall, provider-turn, token, and cost limits are supported. Token usage is unbounded by default; USD cost defaults to $1,000 unless explicitly set. `mission_update` can revise or remove token/cost/turn caps and wall deadlines with a recorded reason. Limit arrival permits one bounded handoff/checkpoint wrap-up, not new substantive work.
- Individual Subagent terminal events contribute exact per-run usage without double-counting group/workflow aggregates.

## Completion gate

Material worktree mutation sets independent review due. Mission launches a fresh read-only `reviewer`; the child submits its verdict through the schema-validated `review_report` tool, and the parent adjudicates that exact run. Missing or malformed reports remain `unknown`, never implicit clearance. Completion is vetoed until:

- every ordered requirement index has concrete audit evidence;
- at least one structured validation record has `exitCode: 0`;
- review is clear or explicitly skipped with a recorded reason;
- all child execution has settled;
- the active Chain checkpoint is saved or explicitly waived.

`userRequested: true` is a recoverable control transition governed by the model tool contract: call it only for an explicit user request, and record remaining work without claiming objective completion. `/mission end|stop|complete` is the direct human path.

## Naming contract

- `--name`/`--title` (or the `title` tool input) sets the human-readable display title; surrounding whitespace is removed and internal whitespace is collapsed before the result is capped at 80 characters.
- Without an explicit title, Mission derives a compact display title from the normalized requirements. When requirements are omitted, Mission first infers them from the objective, so the objective supplies the fallback title indirectly.
- Without `--chain`, Mission reuses an existing Chain only when exactly one Chain matches the title/slug. With zero or multiple matches, it uses the stable, title-derived fallback `mission-<title-slug>`. The Mission-specific suffix is not added to the Chain name.
- Artifact directories add a six-character suffix from the Mission ID: `.missions/<title-slug>-<mission-suffix>/`. This collision-resistant (not collision-proof) suffix normally gives repeated Mission creations separate artifact names while retaining the same display title and default Chain name.

## Storage

Pi custom session entries are authoritative. Human/search projections remain under `.missions/<slug>/`:

- `mission.md` — canonical status, requirements, latest progress, and completion audit
- `log.md` — searchable generated progress history
