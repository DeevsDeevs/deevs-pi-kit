# Chains

Work handoffs as markdown links under the project's `.chains/`. The model writes every link; nothing is saved automatically. When to save and what a link holds is in [skills/chain-system](../../skills/chain-system/SKILL.md).

## Tools

```text
chain_save     save a markdown handoff link
chain_load     load the latest or a selected link
chain_fork     create a branch from an existing link
chain_context  pack bounded context for resume or Subagents
chain_list     list chains and branches
chain_search   ranked, text, or regex search
```

## Command

```text
/chains [query]    browse Chains, or search them
```

Saving, loading, forking and searching are the lead's `chain_*` tools; ask in chat.

## Checkpoint reminder

Pi session entries track the active chain and branch, `saved` or `checkpoint due`, the due reasons and the latest link, and are restored on resume and tree navigation.

- At 80% context the checkpoint becomes due and one reminder to save a link joins the system prompt as the `chain_checkpoint` section. No tool is blocked and Pi's compaction runs as configured. Dropping below 80% or compacting re-arms it.
- A descendant advance of the repository HEAD (not a sideways checkout or reset) and a chain fork also make it due; ordinary edits and jobs do not.
- A successful chain tool updates the state; `chain_save` clears it.
- The footer shows `chain!` only while a checkpoint is due.

## Storage

```text
.chains/<chain>/<timestamp>-<slug>.md
```

Links carry frontmatter for chain, branch, parent, next step and creation time; a link without it is on branch `main`. `.chains/` is the format shared across sessions and with the Claude Code and Codex plugin.
