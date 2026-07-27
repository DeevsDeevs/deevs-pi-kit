---
name: chain-system
description: Create, fork, search, list, and load multi-session chain links under .chains. Use when saving work context, resuming a project from previous sessions, passing context to subagents, or finding prior decisions/next steps.
---

# Chain System

Chains preserve durable work context across Pi sessions as markdown links:

```text
.chains/<chain-name>/<timestamp>-<slug>.md
```

Frontmatter (links without it are treated as branch `main`; `nextStep` comes from the typed `chain_save` field, never parsed from prose):

```yaml
chain: my-feature
branch: main
parent: 2026-04-28-120000000-previous.md
nextStep: Wire the new parser into service.ts
created: 2026-04-28T12:30:00.000Z
```

## Commands and tools

Human commands:

```text
/chains [query]
/chain-link <chain> [--branch name] [--parent link.md]
/chain-load <chain> [--branch name] [link.md]
/chain-fork <chain> <new-branch> [--from link.md] [--from-branch name]
/chain-list [--branches]
/chain-search [chain] [--branch name] [--lookup|--text|--regex] <query>
/chain-waive <reason>
```

Model tools:

```text
chain_save    save a markdown link; supports branch, parent, nextStep
chain_load    load latest/specific link, optionally by branch
chain_fork    resolve a parent for a new branch; follow with chain_save
chain_context pack latest/parent/recent/search context for subagents or resume
chain_list    list chains, optionally branch/link metadata
chain_search  ranked lookup by default; mode text/regex for exact matching
```

## When to load and save

- On "continue", "resume", "pick up", or references to prior work: `chain_load` the named chain if known, else `chain_list`/`chain_search`.
- Before non-trivial work likely tied to an existing project: quick `chain_search` before rediscovering old decisions.
- Save after meaningful milestones (implemented feature, validated fix, design decision, rejected approach worth remembering, completed review) and before context may be lost (long session, compaction risk, task switch, handoff, stopping with pending work).
- For research, save selected sources/queries/IDs only when findings affect future decisions.
- After subagents return, save a link only if their findings changed decisions, exposed risks, or created follow-up work.
- Treat stale (>7 days), ambiguous, or conflicting loaded context as questions to verify against current files before proceeding.
- Do not save for one-shot answers, tiny edits, links that would only repeat visible git diff, or when the user asks not to persist context.

Chains are handoff-quality memory, not chat logs.

## Branching

- Default branch is `main`. A fork is a new branch whose first link has `parent` set to the source link filename.
- Branch when the work has a different hypothesis or merge policy: competing designs, risky experiments that may be abandoned, focused subagent/research tracks that should not pollute `main`, user-requested alternatives or spikes.
- Stay on the current branch for continuations, follow-up fixes, validation results, and normal end-of-session handoffs. No branches for trivial one-off notes.
- Creating a branch: `chain_fork` to resolve the parent, save the first link with `branch` and `parent` metadata, and state the branch scope and what would merge back. When the branch is accepted/rejected, save an outcome link on the parent branch.

```text
/chain-fork project-work experiment --from-branch main
/chain-link project-work --branch experiment
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

Include exact file paths, command results, subagent run/group IDs, background process IDs, and unresolved errors when they matter. Skip routine tool chatter.

## Subagent context passing

Chains are a context bus, not automatic subagent memory: save or load a focused branch link, call `chain_context` for a bounded pack, include the formatted excerpt directly in the `subagent` task text, and after the run save a link referencing its run/group IDs and decision impact.

```text
subagent({
  agent: "reviewer",
  task: "Focus only on search/index design and return migration risks.\n\nChain context:\n<bounded chain_context output>",
  background: true
})
```

## Extension checkpoint hooks

`extensions/chains` tracks branch-local `saved` versus `checkpoint due` state:

- 80% context usage forces one immediate checkpoint before further work; non-`chain_save` tools are blocked and one hidden recovery turn follows an ignored reminder; after saving, 90% usage immediately triggers native Pi compaction and stops further same-turn tools, then resets that one-shot threshold;
- descendant HEAD advances, Mission lifecycle/milestones, review adjudication, new branches, and write-enabled Subagent settlement mark a checkpoint due; ordinary edits and bounded Jobs do not;
- `chain_save` clears due state; an explicit persisted waiver can also clear it with a reason;
- `/chains` browses active state and saved links; `/chains <query>` searches them;
- it never auto-saves because durable links need handoff-quality summaries.

## Guardrails

- Use `chain_save`; do not hand-roll writes into `.chains` unless the tool is unavailable.
- Chain and branch names must be simple names without slashes.
