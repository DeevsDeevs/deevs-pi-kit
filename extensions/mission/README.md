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
- Objective edits create a new objective version and require a reason.
- Wall, provider-turn, token, and cost limits are supported. Limit arrival permits one bounded handoff/checkpoint wrap-up, not new substantive work.
- Individual Subagent terminal events contribute exact per-run usage without double-counting group/workflow aggregates.

## Completion gate

Material mutation sets independent review due. Mission launches a fresh read-only `reviewer`, records its run, adjudicates the structured verdict, and requires focused fresh re-review after fixes. Completion is vetoed until:

- every requirement has concrete audit evidence;
- validation evidence exists;
- review is clear or explicitly skipped with a recorded reason;
- all child execution has settled;
- the active Chain checkpoint is saved or explicitly waived.

`userRequested: true` is accepted only when the latest real user message explicitly requests ending the Mission. `/mission end|stop|complete` is the trusted direct human path.

## Naming contract

- `--name`/`--title` (or the `title` tool input) sets the human-readable display title; surrounding whitespace is removed and internal whitespace is collapsed before the result is capped at 80 characters.
- Without an explicit title, Mission derives a compact display title from the normalized requirements. When requirements are omitted, Mission first infers them from the objective, so the objective supplies the fallback title indirectly.
- Without `--chain`, Mission reuses an existing Chain only when exactly one Chain matches the title/slug. With zero or multiple matches, it uses the stable, title-derived fallback `mission-<title-slug>`. The Mission-specific suffix is not added to the Chain name.
- Artifact directories add a six-character suffix from the Mission ID: `.missions/<title-slug>-<mission-suffix>/`. This collision-resistant (not collision-proof) suffix normally gives repeated Mission creations separate artifact names while retaining the same display title and default Chain name.

## Storage

Pi custom session entries are authoritative. Human/search projections remain under `.missions/<slug>/`:

- `mission.md`
- `plan.md`
- `audit.md`
- `log.md`
