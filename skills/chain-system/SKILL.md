---
name: chain-system
description: Create, fork, search, list, and load multi-session chain links under .chains. Use when saving work context, resuming a project from previous sessions, passing context to subagents, or finding prior decisions/next steps.
---

# Chain System

Use chains to preserve durable work context across Pi sessions. A chain is a set of markdown links:

```text
.chains/<chain-name>/<timestamp>-<slug>.md
```

New links include frontmatter metadata for branching:

```yaml
chain: my-feature
branch: main
parent: 2026-04-28-1200-previous.md
created: 2026-04-28T12:30:00.000Z
```

Older links without metadata are treated as branch `main`.

## Commands and tools

Human commands:

```text
/chain-link <chain> [--branch name] [--parent link.md]
/chain-load <chain> [--branch name] [link.md]
/chain-fork <chain> <new-branch> [--from link.md] [--from-branch name]
/chain-list [--branches]
/chain-search [chain] [--branch name] [--lookup|--text|--regex] <query>
```

Model tools:

```text
chain_save    save a markdown link; supports branch and parent
chain_load    load latest/specific link, optionally by branch
chain_fork    resolve a parent for a new branch; follow with chain_save
chain_context pack latest/parent/recent/search context for subagents or resume
chain_list    list chains, optionally branch/link metadata
chain_search  universal search: ranked lookup by default, exact text, or regex
```

## When to use

- Before ending a long or complex session.
- When the user says to save context, continue later, create a handoff, or chain link.
- At the start of resumed work, use `chain_load` or `/chain-load`.
- When looking for old decisions, files, bugs, or next steps, use `chain_search`; default lookup mode is relevance-ranked, while `mode: "text"` / `--text` and `mode: "regex"` / `--regex` are exact matching modes.
- When work diverges, use `chain_fork` or `/chain-fork` and save follow-up links on the new branch.
- When delegating to subagents, load/search the relevant chain branch and include the focused context in the subagent task.

## Branching model

- Default branch is `main`.
- A fork is a new branch whose first link has `parent` set to the source link filename.
- Use branches for experiments, UI alternatives, subagent research tracks, or parallel implementation approaches.
- Do not create branches for trivial one-off notes.

Typical flow:

```text
/chain-fork deevs-pi-kit semantic-search --from-branch main
/chain-link deevs-pi-kit --branch semantic-search
/chain-load deevs-pi-kit --branch semantic-search
```

## Link content rubric

Use the concise default rubric below. For important handoffs, load and follow `link-rubric.md` in this skill directory.

1. Primary Request and Intent
2. Key Technical Concepts
3. Work Completed
4. Decisions and Rationale
5. Files and Code Changes
6. Unresolved Issues and Blockers
7. Pending Tasks
8. Current Work
9. Next Step

Include exact file paths, command results, subagent run/group IDs, background process IDs, and unresolved errors when they matter. Skip noise and routine tool chatter.

## Subagent context passing

Chains are a context bus, not an automatic subagent memory system.

Recommended pattern:

1. Save or load a focused branch link.
2. Prefer passing `chainContext` to `agent_start` / per-task `agent_parallel_start` so the parent loads a bounded context pack.
3. Alternatively, call `chain_context` and paste the formatted excerpt into the task.
4. When the subagent returns, save a new link that references its run/group IDs and decision impact.

Example subagent task wording:

```text
agent_start({
  agent: "reviewer",
  task: "Focus only on search/index design and return migration risks.",
  chainContext: { chain: "deevs-pi-kit", branch: "semantic-search", mode: "pack", includeParents: 2, searchQuery: "index design", searchMode: "lookup", maxBytes: 12000 }
})
```

## Guardrails

- Use `chain_save`; do not hand-roll writes into `.chains` unless the tool is unavailable.
- Chain and branch names must be simple names without slashes.
- On load, treat stale links (>7 days), ambiguous next steps, or missing referenced context as questions to clarify before proceeding.
