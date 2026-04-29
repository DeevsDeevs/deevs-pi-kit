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

- Before ending a long or complex session; do not save links for trivial one-step tasks.
- When the user says to save context, continue later, create a handoff, or chain link.
- At the start of resumed work, use `chain_load` or `/chain-load`.
- When looking for old decisions, files, bugs, or next steps, use `chain_search`; default lookup mode is relevance-ranked, while `mode: "text"` / `--text` and `mode: "regex"` / `--regex` are exact matching modes.
- When work diverges, use `chain_fork` or `/chain-fork` and save follow-up links on the new branch.
- When delegating to subagents, load/search the relevant chain branch and include the focused context in the subagent task.

## Proactive chain triggers

Use chains without waiting for an explicit reminder when the work is clearly durable. Keep this lightweight; chains are for handoff-quality memory, not chat logs.

At the start of work:

- If the user says "continue", "resume", "pick up", "where were we", or references prior work, call `chain_load` for the named chain if known; otherwise use `chain_list`/`chain_search`.
- If the task is non-trivial and likely tied to an existing project, run a quick `chain_search` for the project/topic before rediscovering old decisions.
- If loaded context is stale, ambiguous, or conflicts with source files, state the uncertainty and verify against current files.

During work:

- Save after meaningful milestones: implemented feature, validated fix, design decision, failed/rejected approach worth remembering, or completed review.
- Save before context may be lost: long session, compaction risk, switching tasks, handing off to another agent, or stopping with pending work.
- For research tasks, save selected sources/queries/IDs only when findings affect future decisions.

With subagents:

- Before spawning subagents on ongoing project work, prefer `chainContext` so each child receives a bounded, parent-loaded context pack.
- After subagents return, save a link only if their findings changed decisions, exposed risks, or created follow-up work.

Do not save when:

- the task is a one-shot answer, tiny edit, or throwaway command;
- the link would only repeat visible git diff with no decisions or next steps;
- the user asks not to persist context.

## Branching model

- Default branch is `main`.
- A fork is a new branch whose first link has `parent` set to the source link filename.
- Use branches for experiments, UI alternatives, subagent research tracks, or parallel implementation approaches.
- Do not create branches for trivial one-off notes.

Branch when the work has a different hypothesis or merge policy from the current line:

- competing designs or implementations;
- risky refactors or experiments that may be abandoned;
- focused subagent/research tracks that should not pollute `main` until accepted;
- user-requested alternatives, spikes, or comparisons.

Stay on the current branch when:

- continuing the same implementation/review;
- adding validation results or follow-up fixes for the same decision line;
- saving a normal end-of-session handoff.

When creating a branch:

1. Use `chain_fork` to resolve and validate the parent link.
2. Save the first branch link with `branch` and `parent` metadata.
3. State branch scope, why it exists, and what would merge back.
4. When the branch is accepted/rejected, save a link on the parent branch (usually `main`) summarizing the outcome and the branch links that matter.

Typical flow:

```text
/chain-fork project-work experiment --from-branch main
/chain-link project-work --branch experiment
/chain-load project-work --branch experiment
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

## Extension discipline hooks

`extensions/chains` may add extra runtime discipline beyond this skill:

- default `nudge` mode appends reminders for resumed/durable project prompts and may notify after meaningful unsaved work;
- optional `guarded` mode can block mutating tools until `chain_search`, `chain_load`, `chain_context`, or `chain_list` has run;
- `/chain-discipline` shows or persists project-level mode/settings in `.pi/chain-discipline.json`;
- it never auto-saves chain links because durable links need handoff-quality summaries;
- respect explicit user wording such as “do not use chains” or “no chains”.

## Guardrails

- Use `chain_save`; do not hand-roll writes into `.chains` unless the tool is unavailable.
- Chain and branch names must be simple names without slashes.
- On load, treat stale links (>7 days), ambiguous next steps, or missing referenced context as questions to clarify before proceeding.
