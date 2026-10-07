# Chains

Durable work handoffs stored as markdown links under project-local `.chains/`.

Chains remain deliberate human-readable summaries; Pi Kit never auto-generates noisy links.

## Tool

One `chain` tool with an `action`: `save`, `load`, `fork`, `context` (a bounded pack for resume or an Agent), `list`, `search` (ranked, text or regex). Its JSON Schema and dispatcher live in `tool.ts`, which `npm run sync:chains-plugin` copies into the Claude Code / Codex plugin with the rest of the core, so both harnesses serve the same tool.

## Command

```text
/chains [query]    browse Chains, or search them
```

Saving, loading, forking and searching go through the lead's `chain` tool; ask in chat.

## State-aware checkpoint discipline

Pi custom entries track:

- the active Chain and branch;
- `saved` versus `checkpoint due`;
- concrete due reasons;
- latest saved link.

Checkpoint state is restored after resume/tree navigation. At 80% context usage the checkpoint becomes due and one reminder to save a concise Chain link joins the system prompt; no tool is blocked and Pi's own compaction runs as configured. Dropping below 80% or compacting resets the one-shot threshold. Successful `chain` calls update state directly. Descendant advances of repository HEAD are detected without parsing shell commands, while sideways checkouts and resets are ignored. Chain forks also mark checkpoints due. Ordinary edits and bounded Jobs do not: activity is not automatically a durable milestone.

The footer stays quiet while saved and shows compact `chain!` only when attention is needed. Before the next agent turn, a due/resume reminder is set as the `chain_checkpoint` system-prompt section from state.

## Storage

```text
.chains/<chain>/<timestamp>-<slug>.md
```

Links include frontmatter for chain, branch, parent, and creation time. Older links without metadata are treated as branch `main`. Checkpoint operations live in Pi session entries; `.chains` remains the cross-session/cross-harness content format.
