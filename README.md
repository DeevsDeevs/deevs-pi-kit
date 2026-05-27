# deevs-pi-kit

Portable Pi package with managed background tasks, curated subagents, persistent missions, durable chains, markdown wiki helpers, arXiv tools, session todos, and focused skills.

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
extensions/processes/   Managed background processes (`proc_*`)
extensions/subagents/   Curated background staff agents (`agent_*`)
extensions/mission/     Branch-scoped persistent objectives (`mission_*`)
extensions/chains/      Durable markdown handoffs (`chain_*`)
extensions/wiki/        Curated markdown wiki helpers (`wiki_*`)
extensions/arxiv/       arXiv search, lookup, and BibTeX tools
extensions/todos/       Session-scoped todo list (`todo_list`)
extensions/ask-user/    Interactive clarification UI (`ask_user`)
extensions/codex-fast/  OpenAI Codex Fast mode service tier (`/codex-fast`)
extensions/notifier/    Ready-for-input terminal notifications
skills/                 Agent behavior guidance
prompts/                Optional project prompt templates
```

## Extensions

### Background tasks

Run long-lived commands without shell detaching hacks.

Tools: `proc_start`, `proc_read`, `proc_list`, `proc_write`, `proc_signal`, `proc_logs`, `proc_clear`.

Commands: `/proc`, `/proc:list`, `/proc:read`, `/proc:logs`, `/proc:kill`, `/proc:signal`, `/proc:clear`, `/proc:dock`, `/proc:settings`.

Project settings persist to `.pi/processes.json`. See [`extensions/processes/README.md`](extensions/processes/README.md).

### Subagents

Run focused staff agents in the background. Built-in agents include `explorer`, `architect`, `reviewer`, `tester`, `devops`, `python-dev`, `cpp-dev`, `rust-dev`, and `anti-slop`.

Tools: `agent_list`, `agent_start`, `agent_parallel_start`, `agent_read`, `agent_status`, `agent_stop`, `agent_logs`, `agent_clear`.

Subagents are read-only unless `allowWrite: true` is explicitly passed. Advisory `tokenBudget` and `costBudgetUsd` inputs are recorded with child-session usage when available. Project settings persist to `.pi/subagents.json`. See [`extensions/subagents/README.md`](extensions/subagents/README.md).

### Mission

Create a branch-scoped objective with compact idle continuation, optional token/cost budgets, chain binding, and durable artifacts under `.missions/`.

Tools: `mission_get`, `mission_create`, `mission_progress`, `mission_search`, `mission_complete`.

Commands: `/mission <objective> [--name short-title] [--req criterion] [--budget 200k] [--cost $2] [--chain name]`, `/mission status`, `/mission pause`, `/mission resume`, `/mission clear`, `/mission complete`/`end`/`stop`.

Mission runtime state is reconstructed from the current Pi session branch; short title-derived slugs/chains avoid full-objective path spam; `.missions/<slug>/` stores human-readable generated artifacts including `mission.md`, `plan.md`, `audit.md`, and searchable `log.md`. See [`extensions/mission/README.md`](extensions/mission/README.md).

### Chains

Save and search durable multi-session handoffs under `.chains/`.

Tools: `chain_save`, `chain_load`, `chain_fork`, `chain_context`, `chain_list`, `chain_search`.

Commands: `/chain-link`, `/chain-load`, `/chain-fork`, `/chain-list`, `/chain-search`, `/chain-discipline`.

Chain discipline settings persist to `.pi/chain-discipline.json`. See [`extensions/chains/README.md`](extensions/chains/README.md).

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

Requires `/login` → ChatGPT Plus/Pro (Codex), and only applies to `openai-codex` GPT-5.4/GPT-5.5.

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
npm pack --dry-run
```

For focused extension checks, build the relevant entrypoint with Bun and externalize Pi peer dependencies. Extension code should avoid Bun runtime APIs unless it explicitly launches a Bun helper, because Pi runs extensions on Node.
