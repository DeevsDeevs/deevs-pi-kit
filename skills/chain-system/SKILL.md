---
name: chain-system
description: "Loads chain. Save, fork, search and load .chains links: work context across sessions, handoff to subagents, prior decisions and next steps."
---

# Chain System

Chains preserve durable work context across Pi sessions as markdown links:

```text
.chains/<chain-name>/<timestamp>-<slug>.md
```

Frontmatter (links without it are treated as branch `main`; `nextStep` comes from the typed `nextStep` argument, never parsed from prose):

```yaml
chain: my-feature
branch: main
parent: 2026-04-28-120000000-previous.md
nextStep: Wire the new parser into service.ts
created: 2026-04-28T12:30:00.000Z
```

## Commands and tools

The user browses, searches and sees the active checkpoint with `/chains [query]`, and asks you for everything else. The `chain` tool takes an `action`:

```text
save     save a markdown link; branch, parent, nextStep
load     latest or a named link, optionally by branch
fork     resolve a parent for a new branch; follow with save
context  pack latest/parent/recent/query hits for a delegate or resume (mode pack|latest)
list     chains, optionally with branch/link metadata
search   ranked lookup by default; searchMode text|regex for exact matching
```

## When to load and save

- On "continue", "resume", "pick up", or references to prior work: `load` the named chain if known, else `list`/`search`.
- Before non-trivial work likely tied to an existing project: quick `search` before rediscovering old decisions.
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
- Creating a branch: `fork` to resolve the parent, save the first link with `branch` and `parent`, and state the branch scope and what would merge back. When the branch is accepted/rejected, save an outcome link on the parent branch.

```text
chain { action: "fork", chain: "project-work", branch: "experiment", fromBranch: "main" }
chain { action: "save", chain: "project-work", branch: "experiment", parent: <the fork's parent>, content: ... }
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

Include exact file paths, command results, agent, workflow and job ids, and unresolved errors when they matter. Skip routine tool chatter.

## Subagent context passing

Chains are a context bus, not automatic subagent memory: save or load a focused branch link, run `context` for a bounded pack, and include the formatted excerpt directly in the `Agent` prompt. If the report meets the save bar above (changed decisions, exposed risks, follow-up work), save a link naming its agentId and the impact.

```text
Agent({
  description: "Review index migration risks",
  subagent_type: "reviewer",
  prompt: "Focus only on search/index design and return migration risks.\n\nChain context:\n<bounded chain context output>"
})
```

## Guardrails

- A `<chain_checkpoint>` reminder comes once, at 80% context: save a link then. After a restart, a resume or a compaction with a chain active, that section instead says to load the active chain. Nothing auto-saves.
- Save through the tool; do not hand-roll writes into `.chains` unless the tool is unavailable.
- Chain and branch names must be simple names without slashes.
