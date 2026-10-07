# Chains

Work handoffs as markdown links under the project's `.chains/`. The model writes every link; nothing is saved automatically. When to save and what a link holds is in [skills/chain-system](../../skills/chain-system/SKILL.md).

## Tool

One `chain` tool with an `action`: `save`, `load`, `fork`, `context` (a bounded pack for resume or an Agent), `list`, `search` (ranked, text or regex). Its JSON Schema and dispatcher live in `tool.ts`, which `npm run sync:chains-plugin` copies into the Claude Code / Codex plugin with the rest of the core, so both harnesses serve the same tool.

## Command

```text
/chains [query]    browse Chains, or search them
```

Saving, loading, forking and searching go through the lead's `chain` tool; ask in chat.

## Checkpoint reminder

Pi session entries track the active chain and branch, `saved` or `checkpoint due`, whether the reminder was shown and the latest link, and are restored on resume and tree navigation.

- At 80% context the checkpoint becomes due and one reminder to save a link joins the system prompt as the `chain_checkpoint` section for one turn; it is recorded as shown, so a reload does not repeat it. No tool is blocked and Pi's compaction runs as configured. Dropping below 80% or compacting re-arms it. Nothing else makes a checkpoint due.
- After a restart, resume or compaction in a session with an active chain, the next turn is told once to load it.
- A successful `chain` call updates the state; a save clears it.
- The footer shows `chain!` only while a checkpoint is due.

## Storage

```text
.chains/<chain>/<timestamp>-<slug>.md
```

Links carry frontmatter for chain, branch, parent, next step and creation time; a link without it is on branch `main`. `.chains/` is the format shared across sessions and with the Claude Code and Codex plugin.
