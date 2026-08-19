# Mission

Single-controller autonomous objectives using Pi 0.82 lifecycle, durable workspace state, and session-entry mirrors.

## Commands

```text
/mission <objective> [--name title] [--req criterion] [--path cwd-relative-scope]... [--budget 200k] [--cost $2] [--chain name]
/mission status
/mission takeover [mission-id-or-artifact-slug]
/mission update [--objective ...] [--req ...] [--path ...] [--budget 400k|none] [--cost $5|none] [--turns 40|none] [--deadline <ms>|none] [--reason ...]
/mission pause
/mission resume
/mission clear
/mission complete   # authorize the exact current candidate; completion still obeys evidence gates
/mission end        # explicit human stop; alias: stop
```

## Tools

```text
mission_get
mission_takeover
mission_resume
mission_create
mission_update
mission_progress
mission_search
mission_complete
```

## Runtime behavior

- Active Mission authorization survives restart and permits reversible best judgment without routine questions.
- Exactly one persisted Pi session controls a Mission. `mission_takeover` or `/mission takeover` transfers control after explicit user authorization when the previous session is stopped or broken; takeover resumes immediately when limits permit.
- Takeover never stops the previous Pi process or its children. The confirmation is an operator attestation that the old session is quiescent; an upgraded old session is fenced from later Mission mutations by controller and revision checks.
- Takeover carries progress and usage, creates a new controller generation, preserves an unchanged adjudicated objective/scope/fingerprint candidate, recovers unresolved review as due, and marks the Mission Chain checkpoint due.
- Pre-upgrade recovery imports only the exact same-cwd Pi session branch. Generated markdown is never parsed as Mission authority.
- Authorization never auto-approves tools or crosses credential, safety, irreversible, or material approval boundaries.
- Autonomous continuation normally advances from `agent_settled`, using a hidden triggering `followUp` after idle/user-priority admission.
- Session start/tree recovery reconciles already-settled reviews. Reviewer terminal evidence is recorded silently, and Mission owns the single review-ready wake; no parent polling or duplicate generic Subagent wake is required.
- A failed synchronous follow-up admission gets one delayed retry. Mission does not use Cron or polling loops: session Cron cannot recover a closed Pi process, while reopening the exact session re-arms Mission from durable state.
- Typed interactive/RPC mid-stream steering gets user priority without permanently pausing autonomy. Explicit or otherwise unmatched aborts still pause; retryable provider behavior remains Pi-owned; terminal errors, recurring blockers, budget limits, and usage limits have distinct states.
- Paused/blocked state is injected into every model turn with the exact Chain, artifact path, and recorded next work. `mission_resume` lets the agent resume only after explicit user authorization or resolution of the recorded blocker.
- The dashboard intentionally omits a one-key destructive End action; type `/mission end` for the explicit human confirmation path.
- Objective edits create a new objective version and require a reason.
- Mission `paths` are typed cwd-relative ownership scope. When cwd is a non-Git workspace containing several repositories, each path resolves to its canonical containing Git root; fingerprints combine scoped HEAD/diff/untracked state per root, and missing/escaping/non-Git paths fail review and completion closed. A path-less Mission in a Git repository intentionally fingerprints the whole repository; use explicit paths when concurrent sessions edit unrelated scopes. Review candidates bind objective version, scope, and fingerprint; reservation plus its internal Subagent admission ID is durable before child launch, ambiguous recovery reuses that ID across reload, and an unchanged adjudicated candidate cannot spawn another reviewer generation.
- Wall, provider-turn, token, and cost limits are supported. Token usage is unbounded by default; USD cost defaults to $1,000 unless explicitly set. `mission_update` (or the trusted `/mission update` command when headless) revises or removes token/cost/turn caps and wall deadlines with a recorded reason; raise the exhausted limit before `mission_resume`. Limit arrival permits one bounded handoff/checkpoint wrap-up, not new substantive work.
- Individual Subagent terminal events contribute exact per-run usage without double-counting group/workflow aggregates.

## Completion gate

Material worktree mutation sets independent review due. Mission durably reserves one candidate before launching a fresh read-only `reviewer`; the child submits findings through the schema-validated `review_report` tool, and the parent adjudicates that exact run. Runtime derives the release decision from typed severity: `blocker|major` require changes, while `minor|nit` remain non-blocking backlog. The fourth valid correction cycle blocks until trusted UI authorization adds three more cycles. Missing or malformed reports remain `unknown`, never implicit clearance. Completion is vetoed until:

- every ordered requirement index has concrete audit evidence;
- at least one structured validation record has `exitCode: 0`;
- review is severity-derived clear or explicitly skipped with a recorded reason;
- trusted user authorization is latched to the exact current objective/scope/fingerprint candidate;
- all child execution has settled;
- the active Chain checkpoint is saved or explicitly waived.

`authorizeCompletion: true` opens trusted UI confirmation and latches only the exact current candidate plus its converged review disposition. Automatic recovery restores `clear`, `skipped`, or `not_required` without launching another reviewer while that candidate is unchanged; a typed candidate change invalidates the latch. `userRequested: true` is a recoverable end transition governed by the model tool contract: call it only for an explicit user request, and record remaining work without claiming objective completion. `/mission complete` is the trusted latch path; `/mission end|stop` is the direct human stop path.

## Naming contract

- `--name`/`--title` (or the `title` tool input) sets the human-readable display title; surrounding whitespace is removed and internal whitespace is collapsed before the result is capped at 80 characters.
- Without an explicit title, Mission derives a compact display title from the normalized requirements. When requirements are omitted, Mission first infers them from the objective, so the objective supplies the fallback title indirectly.
- Without `--chain`, Mission reuses an existing Chain only when exactly one Chain matches the title/slug. With zero or multiple matches, it uses the stable, title-derived fallback `mission-<title-slug>`. The Mission-specific suffix is not added to the Chain name.
- Artifact directories add a six-character suffix from the Mission ID: `.missions/<title-slug>-<mission-suffix>/`. This collision-resistant (not collision-proof) suffix normally gives repeated Mission creations separate artifact names while retaining the same display title and default Chain name.

## Storage and takeover

Canonical machine state is a validated, revisioned snapshot under `.missions/.state/<slug>.json`, outside replaceable generated artifact directories. Every mutation uses an exclusive local-filesystem lock and atomic snapshot replacement; custom Pi session entries are append-only transcript mirrors. Locks fail closed rather than guessing process liveness; concurrent takeover attempts admit exactly one controller.

Human/search projections remain under `.missions/<slug>/`:

- `mission.md` — generated status, requirements, latest progress, and completion audit
- `log.md` — generated searchable progress history

Takeover requires the same workspace cwd because Mission paths, artifact location, Git roots, and legacy session discovery are cwd-relative. Local atomic rename semantics are required; shared/network filesystems are unsupported. If exact source-session usage is unavailable, bounded Missions fail takeover closed. Multi-writer collaboration, automatic owner killing, cross-machine takeover, and markdown recovery are intentionally unsupported.
