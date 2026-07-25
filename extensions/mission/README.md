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
- Autonomous continuation happens only from `agent_settled`, using a hidden triggering `followUp` after idle/user-priority admission.
- There are no Mission continuation timers, polling loops, or Mission-owned compaction retries.
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

## Storage

Pi custom session entries are authoritative. Human/search projections remain under `.missions/<slug>/`:

- `mission.md`
- `plan.md`
- `audit.md`
- `log.md`
