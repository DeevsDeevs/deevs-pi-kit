# Chains

Durable multi-session work handoffs for Pi. Links are markdown files stored under project-local `.chains/`.

## Commands

```text
/chain-link <chain> [--branch name] [--parent link.md]
/chain-load <chain> [--branch name] [link.md]
/chain-fork <chain> <new-branch> [--from link.md] [--from-branch name]
/chain-list [--branches]
/chain-search [chain] [--branch name] [--lookup|--text|--regex] <query>
```

## Tools

```text
chain_save    save a markdown chain link; supports branch/parent metadata
chain_load    load latest/specific link, optionally by branch
chain_fork    prepare a new branch from an existing link
chain_context pack latest/parent/recent/search context for subagents or resume
chain_list    list chains, latest links, and optional branch summaries
chain_search  universal search: ranked lookup by default, exact text, or regex
```

## Storage

```text
.chains/<chain-name>/<timestamp>-<slug>.md
```

New links include frontmatter:

```yaml
chain: deevs-pi-kit
branch: main
parent: 2026-04-28-0031-previous.md
created: 2026-04-28T00:31:00.000Z
```

Older links without metadata are treated as branch `main`.

## Workflow

- `/chain-link` asks the model to summarize using the `chain-system` skill, then save via `chain_save`.
- `/chain-fork` queues the first branch-link summary and sets `parent` to the source link.
- `/chain-load` injects loaded context into the next turn.
- `/chain-search` defaults to ranked BM25-style lookup with section/recency boosts; add `--text` for exact text or `--regex` for JavaScript regex matching.

Chains can pass focused context to subagents: pass `chainContext` to `agent_start` / per-task `agent_parallel_start`, or use `chain_context` and paste the packed block manually. `chain_context` defaults to pack mode: current link, parent trail, recent link summaries, and optional `searchQuery` hits within a byte budget. `searchMode` controls lookup/text/regex packing. Save a follow-up link with run/group IDs and accepted recommendations.

## Discipline nudges

The extension includes lightweight chain-discipline hooks so chains are used more consistently without noisy auto-journaling.

Default mode is `nudge`:

- before resume-like or durable project prompts, Pi appends a concise reminder to search/load chain context when relevant;
- after meaningful mutating work without `chain_save`, Pi notifies that a handoff link may be useful;
- it never auto-saves chain links.

Optional project config lives at `.pi/chain-discipline.json`:

```json
{
  "enabled": true,
  "mode": "nudge",
  "defaultChain": "deevs-pi-kit",
  "guardResumePrompts": true,
  "guardDurablePrompts": false,
  "nudgeAfterMutatingTools": true,
  "notifyOnStart": false
}
```

Modes:

- `off` — disable discipline hooks.
- `nudge` — reminders and end-of-run notifications only.
- `guarded` — block mutating tools on high-confidence resumed work until `chain_search`, `chain_load`, `chain_context`, or `chain_list` runs. Set `guardDurablePrompts: true` to also guard broader durable project prompts.
- `strict` — opt-in hard mode for any reminded prompt; likely noisy.

Environment overrides:

```text
DEEVS_CHAIN_DISCIPLINE_MODE=off|nudge|guarded|strict
DEEVS_CHAIN_DISCIPLINE_ENABLED=true|false
```

Bypass for one prompt with wording like “do not use chains” or “no chains”.
