# Mission

Branch-scoped persistent objectives for Pi, inspired by Codex goals.

## Commands

```text
/mission <objective> [--name short-title] [--req criterion] [--budget 200k] [--cost $2] [--chain name]
/mission status
/mission pause
/mission resume
/mission clear
/mission complete   # aliases: end, stop
```

## Tools

```text
mission_get
mission_create
mission_progress
mission_search
mission_complete
```

## Storage

- Runtime state is stored as Pi custom session entries and reconstructed from the current session branch.
- Durable artifacts are created immediately under `.missions/<mission-slug>/`:
  - `mission.md`
  - `plan.md`
  - `decisions.md`
  - `audit.md`
  - `log.md`
- Mission names/slugs are short title-derived identifiers, not the full objective text.
- Long objectives are decomposed into requirement bullets when possible; provide `--name`/`title` and `--req`/`requirements` when you want exact control.
- Chain binding defaults to a matching existing chain or a derived short `mission-<slug>` chain.
- `mission_progress` records compact progress/evidence/remaining/validation entries and regenerates searchable artifacts, reducing manual artifact edits.
- `mission_search` searches `.missions/**.md` so agents can reuse prior Mission tracking before repeating work.

## Behavior

Mission continuation is compact and idle-driven: creating or resuming a mission can enqueue a hidden continuation turn when Pi is idle, no messages are pending, and budget remains. After each completed continuation with assistant/tool progress, Mission may continue again while idle. When context usage reaches 75%, Mission asks Pi to compact first with Mission-specific summary instructions, then resumes continuation. It can resume on startup/reload/resume, while explicit abort pauses the mission so Escape remains an exit hatch. User prompts take priority.

Token budgets use Codex-like accounted tokens over Pi's normalized usage fields: `input + cacheWrite + output`, excluding `cacheRead`. Cost budgets use Pi's reported `cost.total`. Objective completion should be backed by concrete audit evidence; explicit user-requested completion/end/stop records an honest closure audit and can be resumed with `/mission resume` if needed. Normal continuation should prefer `mission_progress` over manually editing mission artifacts, and should reserve chain links for checkpoints, handoffs, or final cleanup.
