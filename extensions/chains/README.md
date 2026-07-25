# Chains

Durable work handoffs stored as markdown links under project-local `.chains/`.

Chains remain deliberate human-readable summaries; Pi Kit never auto-generates noisy links.

## Tools

```text
chain_save     save a markdown handoff link
chain_load     load the latest or a selected link
chain_fork     create a branch from an existing link
chain_context  pack bounded context for resume or Subagents
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
```

## State-aware checkpoint discipline

Pi custom entries track:

- the active Chain and branch;
- `saved` versus `checkpoint due`;
- concrete due reasons;
- latest saved link or explicit waiver reason.

Checkpoint state is restored after resume/tree navigation. At 80% context usage, Pi must save one concise Chain link before any other work; compaction resets that one-shot threshold. Successful Chain tools update state directly. Descendant advances of repository HEAD are detected without parsing shell commands, while sideways checkouts and resets are ignored. Mission lifecycle changes, explicit Mission milestones/review adjudication, Chain forks, and write-enabled Subagents also mark checkpoints due. Ordinary edits and bounded Jobs do not: activity is not automatically a durable milestone.

The footer stays quiet while saved and shows `checkpoint due: name@branch` only when attention is needed. Before the next agent turn, a due/resume reminder is injected from state. Mission completion vetoes a due checkpoint unless it is explicitly waived with a reason.

## Storage

```text
.chains/<chain>/<timestamp>-<slug>.md
```

Links include frontmatter for chain, branch, parent, and creation time. Older links without metadata are treated as branch `main`. Checkpoint operations live in Pi session entries; `.chains` remains the cross-session/cross-harness content format.
