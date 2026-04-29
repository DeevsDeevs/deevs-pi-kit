# deevs-pi-kit

Portable Pi kit for Deevs: managed background tasks, curated subagents, and the skills that teach the main agent when to use them.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit
# or project-local
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l
# local development
pi install /Users/deevs/programming/agents/deevs-pi-kit
```

Reload after local edits:

```text
/reload
```

## Contents

```text
extensions/processes/   Process-backed background task tools (`proc_*`)
extensions/subagents/   Curated background staff agents
extensions/chains/      Durable multi-session work chains
extensions/wiki/        Deterministic markdown wiki helpers
extensions/arxiv/       arXiv paper search/lookup/BibTeX tools
extensions/todos/       Session-scoped managed todo list (`todo_list`)
extensions/notifier/     Ready-for-input terminal notifications
skills/background-tasks User-intent workflow for `extensions/processes`
skills/subagents/       Guidance for agent_* usage
skills/chain-system/    Guidance for chain handoffs/search
skills/wiki/            Curated markdown knowledge-base workflow
skills/concept-diagrams Compact Mermaid/SVG visual explanations
skills/arxiv/           arXiv research workflow
skills/todos/           Guidance for effective `todo_list` usage
skills/datadog-pup/     Safe Datadog operations through the `pup` CLI
skills/grill-me/        One-question-at-a-time plan/design grilling
skills/diagnose/        Repro-first debugging and root-cause workflow
skills/codebase-orientation/ Map unfamiliar repo areas before acting
skills/validation-review/ Bounded test/review pass before shipping
prompts/                Prompt templates
docs/                   Design notes and plans
```

## Extensions

### Background tasks / managed processes

Background tasks are powered by `extensions/processes/` and exposed as `proc_*` tools plus `/proc:*` commands. The folder/API name is implementation-oriented: Pi manages OS processes. The skill name, `skills/background-tasks`, is intent-oriented: use it when a command should keep running while the conversation continues.

Use it for dev servers, watchers, workers, REPLs, and long-lived commands without shell detaching hacks (`&`, `nohup`, `disown`, `setsid`).

Tools:

```text
proc_start   proc_read   proc_list   proc_write
proc_signal  proc_logs   proc_clear
```

Commands:

```text
/proc                         interactive task panel
/proc:list                    text task list
/proc:read <id|name>          buffered output
/proc:logs <id|name> [stream] searchable log overlay
/proc:kill <id|name|--all>    SIGTERM
/proc:signal <id|name> <sig>  SIGINT/SIGTERM/SIGKILL
/proc:clear <id|name|--exited>
/proc:dock [show|hide|toggle]
/proc:settings
```

Active non-subagent tasks show a compact blue footer status. Full docs: [`extensions/processes/README.md`](extensions/processes/README.md).

### Subagents

`extensions/subagents/` runs curated staff agents as managed background jobs.

Built-in staff:

```text
explorer   architect  reviewer  tester  devops
python-dev cpp-dev    rust-dev   anti-slop
```

Tools:

```text
agent_list    agent_start  agent_parallel_start  agent_read
agent_status  agent_stop   agent_logs            agent_clear
```

Commands:

```text
/agents                       dashboard if runs exist, catalog otherwise
/agents:catalog               staff browser
/agents:browse                alias for /agents:catalog
/agents:list                  text staff list
/agents:run <agent> -- <task>
/agents:parallel a,b -- <task>
/agents:status                run/group dashboard
/agents:read <id> [--raw]
/agents:logs <id> [source] [--raw]
/agents:stop <id>
/agents:clear <id|--completed>
/agents:dock [show|hide|toggle]
/agents:settings
```

Subagents are read-only by default. Pass write permission only when explicitly requested. Use `chainContext` for parent-loaded chain handoffs. Active runs show a footer status and completion wakes the parent agent. Backing process logs default to compact activity summaries; use `raw:true` / `--raw` only for full JSON log debugging. Full docs: [`extensions/subagents/README.md`](extensions/subagents/README.md).

### Chains

`extensions/chains/` stores resumable work handoffs in project-local `.chains/` markdown files.

```text
/chain-link <name>             summarize current work and save a link
/chain-load <name>             load latest link as working context
/chain-fork <name> <branch>    fork a branch from an existing link
/chain-list [--branches]       list chains
/chain-search [name] <query>   universal ranked/text/regex chain search
```

Tools: `chain_save`, `chain_load`, `chain_fork`, `chain_context`, `chain_list`, `chain_search`. `chain_search` defaults to dependency-free BM25-style ranked lookup; use `mode: "text"` or `mode: "regex"` for exact matching. `chain_context` packs current/parent/recent/search context within a byte budget; subagents can receive it through `agent_start.chainContext` or per-task `chainContext` in `agent_parallel_start`.

Chain discipline hooks nudge the model to search/load chains for resumed or durable project work and remind after meaningful unsaved work. Default mode is non-blocking `nudge`; opt into guarded behavior with `.pi/chain-discipline.json` if you want mutating tools blocked until chain context is checked.

### Wiki

`extensions/wiki/` provides deterministic helpers for curated markdown wikis used with `skills/wiki`.

```text
/wiki:init <path> --domain "..."  create standard wiki files/dirs
/wiki:status <path>               show counts, graph summary, top issues
/wiki:lint <path>                 report links/index/frontmatter/tag issues
/wiki:graph <path>                parse [[wikilinks]] into graph health
/wiki:search <path> <query>       ranked/text/regex wiki search
/wiki:context <path> <query>      pack bounded wiki context
```

Tools: `wiki_init`, `wiki_status`, `wiki_lint`, `wiki_graph`, `wiki_search`, `wiki_context`. All require an explicit project-local wiki path. The standard layout uses `sources/` for immutable saved source artifacts and `sources/assets/` for images/binaries. For codebase wikis, cite repo paths directly rather than copying code into `sources/`. The extension does not fetch URLs or auto-write wiki pages; curation stays deliberate via `skills/wiki` and normal `write`/`edit`.

### arXiv

`extensions/arxiv/` searches the official arXiv export API for paper metadata and abstracts.

```text
/arxiv:search <query>       search papers by query/title/author/category
/arxiv:get <id[,id]>        fetch exact paper metadata and abstracts
/arxiv:bibtex <id[,id]>     generate simple BibTeX entries
```

Tools: `arxiv_search`, `arxiv_get`, `arxiv_bibtex`. Results are bounded, no API key is required, and the extension does not download PDFs or fetch arbitrary URLs. Use `skills/arxiv` for research triage and citation discipline.

### Todos

`extensions/todos/` provides a minimal session-scoped todo list for non-trivial multi-step work. The `todo_list` tool supports `read`, `write` (complete replacement), and `clear`; items have `pending`, `in_progress`, `blocked`, or `done` status. It uses a compact widget plus a read-only `/todos` overlay; `/todos clear` resets it. Todos are for current-session progress, not durable memory; use chains for handoffs.

### Notifier

`extensions/notifier/` sends a ready-for-input signal on Pi's `agent_end` event. It uses terminal protocols only: Kitty OSC 99 when available, Ghostty OSC 9 + OSC 777 when running in Ghostty, otherwise OSC 777. It also sends BEL by default so terminal bell/audio settings can handle sound. Run `/notifier:test` after `/reload` to test it.

Optional project config lives at `.pi/notifier.json`:

```json
{
  "enabled": true,
  "title": "Pi",
  "body": "Ready for input",
  "terminal": true,
  "bell": true,
  "terminalRequiresTty": true,
  "command": ["cmux", "notify", "--title", "{title}", "--body", "{body}"],
  "jsonl": ".pi/notifier-events.jsonl"
}
```

## Skills

### Concept diagrams

`skills/concept-diagrams/` teaches the assistant to create compact visual explanations. It defaults to Mermaid in Markdown for architecture maps, data flows, sequence diagrams, state machines, lifecycle diagrams, and concept maps. When the user asks for a polished visual artifact, it can use a self-contained HTML/SVG template under `skills/concept-diagrams/templates/`.

For codebase diagrams, inspect source files first and cite the paths used. Prefer several small diagrams over one unreadable mega-diagram.

### arXiv research

`skills/arxiv/` teaches bounded paper discovery, abstract-level triage, arXiv ID lookup, BibTeX generation, and when to save findings to chains or a wiki. It explicitly warns not to treat preprints as peer-reviewed truth or abstracts as full-paper evidence.

### Todos

`skills/todos/` teaches when and how to use `todo_list`: create compact current-session plans for non-trivial work, mark exactly what is `in_progress`, use `blocked` with notes instead of fake progress, update via complete replacement writes, and clear stale lists. It explicitly separates ephemeral todo progress from durable chain handoffs.

### Datadog Pup

`skills/datadog-pup/` teaches safe Datadog investigation and operations through the `pup` CLI. It emphasizes live command discovery (`pup agent schema --compact`, `pup <domain> --help`), auth/site checks, `--read-only` exploration, bounded time ranges and limits, API-side aggregation, JSON output, redaction of sensitive log data, and explicit approval before creates/updates/deletes/debugger probes/workflow runs.

### Diagnose

`skills/diagnose/` teaches a repro-first debugging loop for broken behavior, failing builds, flaky commands, hung subagents, process issues, and performance regressions. It emphasizes fast feedback loops, falsifiable hypotheses, targeted probes, cleanup, and verification against the original symptom.

It points agents toward project-native evidence and Pi-managed supervision: focused build/test commands, fixture repros, `proc_*` for long-running loops, and tightly scoped subagent help when useful.

### Codebase orientation

`skills/codebase-orientation/` teaches the assistant to map an unfamiliar repo area before editing or debugging. It is useful for large codebases, especially Rust workspaces, where safe changes depend on crate boundaries, callers, key types/traits, state flow, and narrow validation commands.

It uses Pi-native orchestration (`agent_start`, `agent_read`, diagrams, chains) while keeping the target repo's own structure and commands as the source of truth.

### Validation review

`skills/validation-review/` teaches a bounded post-change review workflow: check requirements, logic, tests/e2e evidence, and slop before shipping. It uses project-native checks plus scoped subagent perspectives such as `tester`, `reviewer`, `anti-slop`, `rust-dev`, or `devops` within the user's requested review budget.

## Development checks

```bash
bun build extensions/processes/index.ts --outdir /tmp/deevs-proc-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/subagents/index.ts --outdir /tmp/deevs-subagents-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/chains/index.ts --outdir /tmp/deevs-chains-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/wiki/index.ts --outdir /tmp/deevs-wiki-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/arxiv/index.ts --outdir /tmp/deevs-arxiv-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/todos/index.ts --outdir /tmp/deevs-todos-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty

bun build extensions/notifier/index.ts --target node --outdir /tmp/deevs-notifier-build \
  --external @mariozechner/pi-coding-agent

npm pack --dry-run
```

Pi currently runs extensions on Node, so extension code should avoid Bun runtime APIs unless it explicitly spawns a Bun helper.
