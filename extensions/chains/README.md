# Chains

Durable work handoffs stored as markdown links under project-local `.chains/`.

Use chains when work may span sessions, needs resumable context, or should be handed to subagents. Chains are deliberate summaries; the extension never auto-saves model notes.

## Tools

```text
chain_save     save a markdown handoff link
chain_load     load the latest or a selected link
chain_fork     create a branch from an existing link
chain_context  pack bounded context for resume or subagents
chain_list     list chains and branches
chain_search   ranked, text, or regex search
```

## Commands

```text
/chain-link <chain> [--branch name] [--parent link.md]
/chain-load <chain> [--branch name] [link.md]
/chain-fork <chain> <new-branch> [--from link.md]
/chain-list [--branches]
/chain-search [chain] [--lookup|--text|--regex] <query>
/chain-discipline [status|mode|default-chain|enable|disable|reset|set]
```

## Storage

```text
.chains/<chain>/<timestamp>-<slug>.md
```

Links include frontmatter for chain, branch, parent, and creation time. Older links without metadata are treated as branch `main`.

## Chain discipline

Chain discipline adds reminders so durable work checks existing context and saves useful handoffs.

Modes:

```text
off       disabled
nudge     reminders only; default
guarded   block mutating tools on high-confidence resumed work until context is checked
strict    harder opt-in guarding; can be noisy
```

Project settings live in `.pi/chain-discipline.json` and can be changed with `/chain-discipline`. Environment variables can override project settings:

```text
DEEVS_CHAIN_DISCIPLINE_MODE=off|nudge|guarded|strict
DEEVS_CHAIN_DISCIPLINE_ENABLED=true|false
```

Use wording like “no chains” or “do not use chains” to bypass for a single prompt.
