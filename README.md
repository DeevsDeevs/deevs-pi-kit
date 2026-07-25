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
extensions/mission/     Autonomous branch-scoped objectives (`mission_*`)
extensions/cron/        Process-local session schedules (`cron`, `/cron`)
extensions/chains/      Durable markdown handoffs (`chain_*`)
extensions/wiki/        Curated markdown wiki helpers (`wiki_*`)
extensions/arxiv/       arXiv search, lookup, and BibTeX tools
extensions/todos/       Session-scoped todo list (`todo_list`)
extensions/ask-user/    Interactive clarification UI (`ask_user`)
extensions/codex-fast/  OpenAI Codex Fast mode service tier (`/codex-fast`)
extensions/notifier/    Ready-for-input terminal notifications
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

Subagents are read-only unless `allowWrite: true` is explicitly authorized by the latest user message. Read-only personas receive `safe_read`, `safe_list`, and `safe_search`—never unrestricted `bash`. The process-isolated executor supports parallel groups, hard cancellation, exact per-run usage, detached recovery, persistent agent identity, and resume into the exact private Pi session. Omitted turn/token/cost limits are unbounded; wall time defaults to six hours and is capped at 24 hours. Explicit orchestrator limits always win. Project model/concurrency settings remain in `.pi/subagents.json`.

### Workflows

Run foreground JavaScript function bodies in a terminable worker with `await agent({ agent, task })`. Workflows require a trusted project, force child agents read-only, cap concurrency, aggregate real usage, and settle children before returning. Trusted workflow JavaScript is **not** a security sandbox.

Tool: `workflow`.

### Mission

Create a branch-scoped objective with `agent_settled` autonomous continuation, user-priority admission, wall/turn/token/cost limits, objective versions, independent review convergence, child-settlement and Chain completion vetoes, and durable artifacts under `.missions/`.

Tools: `mission_get`, `mission_create`, `mission_update`, `mission_progress`, `mission_search`, `mission_complete`.

Commands: `/mission <objective> [--name short-title] [--req criterion] [--budget 200k] [--cost $2] [--chain name]`, `/mission status`, `/mission pause`, `/mission resume`, `/mission clear`, `/mission complete`/`end`/`stop`.

Mission runtime state is reconstructed from the current Pi session branch; short title-derived slugs/chains avoid full-objective path spam; `.missions/<slug>/` stores human-readable generated artifacts including `mission.md`, `plan.md`, `audit.md`, and searchable `log.md`. See [`extensions/mission/README.md`](extensions/mission/README.md).

### Cron

Schedule a prompt for the current Pi session with a standard five-field local-time cron expression. Tasks persist by exact Pi session id, fire only while that session process is idle, boundedly coalesce missed recurring occurrences on resume, and advance only after Pi admits the generated `<cron-fire>` follow-up.

Tool: `cron` with `create`, `list`, and `delete` actions. Command: `/cron` or `/cron delete <id>`.

Cron is process-local: it cannot wake a closed Pi process or machine. Use Herdr/OS scheduling for reliable unattended wakeups. See [`extensions/cron/README.md`](extensions/cron/README.md).

### Chains

Save and search durable multi-session handoffs under `.chains/`.

Tools: `chain_save`, `chain_load`, `chain_fork`, `chain_context`, `chain_list`, `chain_search`.

Commands: `/chain-link`, `/chain-load`, `/chain-fork`, `/chain-list`, `/chain-search`.

Pi session entries track active `saved` versus `checkpoint due` state across resume, durable milestones, and a one-shot checkpoint forced at 80% context usage before compaction. See [`extensions/chains/README.md`](extensions/chains/README.md).

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

## Skills

Skills provide progressive guidance for when and how to use the tools:

```text
background-tasks  subagents       chain-system    wiki
concept-diagrams  arxiv           todos           ask-user
datadog-pup       grill-me        diagnose        codebase-orientation
validation-review
```

## Development

```bash
npm install
npm run check
```

`npm run check` runs strict typechecking, the unit/integration/UI suite, reproducible RPC/print/JSON mode smokes, a production-dependency audit, and a package dry run against Pi 0.82.
