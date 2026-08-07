# deevs-pi-kit

Portable Pi package with bounded Jobs, process-isolated curated Subagents, trusted workflows, autonomous Missions, session Cron, durable Chains, markdown wiki helpers, arXiv tools, session todos, and focused skills.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l   # project-local
pi install .                                           # from a local checkout
```

Reload Pi after installing or editing:

```text
/reload
```

## Contents

```text
extensions/jobs/        Bounded non-agent commands (`job_*`)
extensions/subagents/   Owned curated personas and isolated runtime (`subagent*`)
extensions/workflow/    Trusted-project JavaScript workflows (`workflow`)
extensions/mission/     Autonomous single-controller objectives (`mission_*`)
extensions/cron/        Process-local session schedules (`cron`, `/cron`)
extensions/chains/      Durable markdown handoffs (`chain_*`)
extensions/wiki/        Curated markdown wiki helpers (`wiki_*`)
extensions/arxiv/       arXiv search, lookup, and BibTeX tools
extensions/todos/       Session-scoped todo list (`todo_list`)
extensions/ask-user/    Interactive clarification UI (`ask_user`)
extensions/codex-fast/  OpenAI Codex Fast mode service tier (`/codex-fast`)
extensions/notifier/    Ready-for-input terminal notifications
extensions/herdr-compat/ Experimental Shift+Enter compatibility for Pi inside Herdr
extensions/runtime/     Idle delivery and rendering of terminal runtime events
skills/                 Agent behavior guidance
```

## Extensions

### Jobs

Run bounded non-interactive commands with capped output, readiness checks, hard timeouts, durable terminal events, and process-tree cancellation. Persistent shells, servers, REPLs, panes, and reliable unattended schedules belong in Herdr.

Tools: `job_start`, `job_wait`, `job_read`, `job_stop`.

Command: `/jobs` (`/jobs <id>`, `/jobs stop <id>`, `/jobs clear [id]`). On upgrade, legacy `~/.pi/agent/process-state` records are detected and reported but never adopted or killed; inspect old tmux sessions and hand persistent work to Herdr before removing those records.

### Subagents

Run focused staff agents in the background. Built-in agents include `explorer`, `architect`, `reviewer`, `tester`, `logic-hunter`, `devops`, `python-dev`, `cpp-dev`, `rust-dev`, and `anti-slop`.

Tools: `subagent`, `subagent_wait`. Command: `/agents [run-or-group-id]`, `/agents stop <id>`, `/agents resume <id> <task>`, or `/agents clear [id]`.

Subagents are read-only unless `allowWrite: true` is requested. Read-only personas receive `safe_read`, `safe_list`, and `safe_search`—never unrestricted `bash`. The process-isolated executor supports parallel groups, hard cancellation, exact per-run usage, detached recovery, persistent agent identity, and resume into the exact private Pi session. Omitted turn/token/cost limits are unbounded; wall time defaults to six hours and is capped at 24 hours. Explicit orchestrator limits always win.

`worktree: true` provisions a dedicated git worktree on a fresh `subagent/<persona>-<id>` branch off `HEAD` and runs the child there, so parallel writers never share a tree. Worktree and branch outlive the run for review; drop them with `git worktree remove`.

Settings live in `.pi/subagents.json` per project, with user-level defaults in `~/.pi/agent/subagents.json` (project values win): allowed/default models, per-persona models, timeout bounds, group concurrency, plus

```json
{
  "delegatedWrites": "worktree",
  "worktreeRoot": "../myrepo-worktrees",
  "worktreeSetup": ["git submodule update --init --recursive"]
}
```

`delegatedWrites` decides how write-capable runs are authorized: `prompt` (default) confirms every run in the TUI, `worktree` auto-authorizes runs isolated in a dedicated worktree (`worktree: true`, or an explicit `cwd` that is a linked worktree outside the orchestrator's own tree) and still prompts for anything that would write the orchestrator's tree, `always` authorizes unconditionally. `worktreeRoot` (default: `<repo>-worktrees` beside the repository) is where provisioned worktrees land; `worktreeSetup` shell commands run in each new worktree before the child starts, and a failing command removes the worktree and fails the run.

### Workflows

Run foreground JavaScript function bodies in a terminable worker with `await agent({ agent, task })`. Workflows require a trusted project, force child agents read-only, cap concurrency, aggregate real usage, and settle children before returning. Concurrent Workflows share one bounded below-editor dashboard: a single run shows agent detail, while multiple runs collapse to capped per-Workflow progress rows. Trusted workflow JavaScript is **not** a security sandbox.

Tool: `workflow`.

### Mission

Create a single-controller workspace objective with `agent_settled` autonomous continuation, user-priority admission, wall/turn/token/cost limits, objective versions, independent review convergence, child-settlement and Chain completion vetoes, and durable state under `.missions/`. A stopped or broken Pi session can hand control to a new same-cwd session through an explicit, confirmed takeover; Missions never use collaborative multi-writer merging. In a non-Git workspace containing several repositories, pass explicit cwd-relative Mission `paths`; review and mutation fingerprints then cover each selected Git root independently. Path-less Missions cover the whole current repository, so concurrent sessions should use explicit paths; three review-time fingerprint changes block instead of requeueing forever.

Tools: `mission_get`, `mission_takeover`, `mission_resume`, `mission_create`, `mission_update`, `mission_progress`, `mission_search`, `mission_complete`.

Commands: `/mission <objective> [--name short-title] [--req criterion] [--path cwd-relative-scope] [--budget 200k] [--cost $2] [--chain name]` (`--path` is repeatable), `/mission status`, `/mission takeover [mission-id-or-slug]`, `/mission pause`, `/mission resume`, `/mission clear`, `/mission complete`/`end`/`stop`.

Canonical Mission state is a validated, revisioned snapshot in `.missions/.state/<slug>.json`; Pi custom session entries remain transcript mirrors. Every mutation verifies the controlling session under an exclusive local-filesystem lock. Takeover imports exact same-cwd legacy session state when needed, carries usage/progress, creates a new generation, requires fresh review, and resumes immediately when limits permit. It does not stop the old Pi process or its children, so confirmation requires that the old session is already stopped. Requirements use stable indexes, validation uses command/exit-code records, blockers use explicit IDs, and reviewer verdicts come from a schema-validated child tool. `mission.md` and `log.md` are generated human/search projections. See [`extensions/mission/README.md`](extensions/mission/README.md).

### Cron

Schedule a prompt for the current Pi session with a standard five-field local-time cron expression. Tasks persist by exact Pi session id, fire only while that session process is idle, boundedly coalesce missed recurring occurrences on resume, and advance only after Pi admits the generated `<cron-fire>` follow-up.

Tool: `cron` with `create`, `list`, and `delete` actions. Command: `/cron` or `/cron delete <id>`.

Cron is process-local: it cannot wake a closed Pi process or machine. Use Herdr/OS scheduling for reliable unattended wakeups. See [`extensions/cron/README.md`](extensions/cron/README.md).

### Chains

Save and search durable multi-session handoffs under `.chains/`.

Tools: `chain_save`, `chain_load`, `chain_fork`, `chain_context`, `chain_list`, `chain_search`.

Commands: `/chains`, `/chain-link`, `/chain-load`, `/chain-fork`, `/chain-list`, `/chain-search`, `/chain-waive <reason>`.

Pi session entries track active `saved` versus `checkpoint due` state across resume and typed durable milestones. At 80% context usage, other tools are blocked until `chain_save`; after a saved checkpoint, 90% usage triggers native Pi compaction while idle so the next turn does not remain over threshold. See [`extensions/chains/README.md`](extensions/chains/README.md).

### Wiki

Maintain curated markdown knowledge bases with deterministic linting, graph checks, search, and context packing.

Tools: `wiki_init`, `wiki_status`, `wiki_lint`, `wiki_graph`, `wiki_search`, `wiki_context`.

Commands: `/wiki:init`, `/wiki:status`, `/wiki:lint`, `/wiki:graph`, `/wiki:search`, `/wiki:context`. See [`extensions/wiki/README.md`](extensions/wiki/README.md).

### arXiv

Search the official arXiv API, fetch exact paper metadata, and generate BibTeX.

Tools: `arxiv_search`, `arxiv_get`, `arxiv_bibtex`.

Commands: `/arxiv:search`, `/arxiv:get`, `/arxiv:bibtex`. See [`extensions/arxiv/README.md`](extensions/arxiv/README.md).

### Todos

Track compact current-session plans for non-trivial work.

Tool: `todo_list`.

Commands: `/todos`, `/todos clear`. See [`extensions/todos/README.md`](extensions/todos/README.md).

### Ask user

Collect focused clarifications or decisions through an interactive overlay.

Tool: `ask_user`.

Use it only after checking files, docs, and commands that could answer the question.

### Codex Fast

Enable OpenAI Codex Fast mode by injecting `service_tier: "priority"` into eligible ChatGPT-auth `openai-codex` requests. It does not change the selected model or thinking level.

Commands: `/codex-fast`, `/codex-fast status`, `/codex-fast on`, `/codex-fast off`, `/codex-fast auto`, `/codex-fast toggle`.

Optional config: `.pi/codex-fast.json` or `~/.pi/agent/extensions/codex-fast.json` with `{ "enabled": false, "showStatus": true }`.

Requires `/login` → ChatGPT Plus/Pro (Codex), and applies to any `openai-codex-responses` model instead of a version allowlist.

### Notifier

Send a ready-for-input terminal notification on agent completion.

Commands: `/notifier:test`, `/notifier:settings`.

Project settings persist to `.pi/notifier.json`.

### Herdr compatibility

When Pi runs inside Herdr (`HERDR_ENV=1`), normalize legacy and Kitty Alt+Enter sequences produced by Shift+Enter compatibility mappings into a newline. This is experimental: after a terminal multiplexer collapses Shift+Enter into Alt+Enter, genuine Alt+Enter cannot be distinguished and is also treated as a newline.

## Skills

Skills provide progressive guidance for when and how to use the tools:

```text
background-tasks  subagents       chain-system    wiki
concept-diagrams  arxiv           todos           ask-user
datadog-pup       grill-me        diagnose        codebase-orientation
validation-review missions
```

## Development

```bash
npm install
npm run check
```

`npm run check` runs strict typechecking, the unit/integration/UI suite, reproducible RPC/print/JSON mode smokes, a full lockfile supply-chain audit (including Pi/TypeScript/Vitest development tooling), and a package dry run against Pi 0.82. The audit has one narrow, expiring exception for `GHSA-mh99-v99m-4gvg`: Pi 0.82.x's published shrinkwrap pins dev-only `brace-expansion@5.0.7` and prevents downstream selection of fixed 5.0.8; the exception expires 2026-08-15 and all other high-severity findings fail the gate.
