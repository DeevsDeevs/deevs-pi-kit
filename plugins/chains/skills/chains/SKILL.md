---
name: chains
description: "Save, load, fork and search .chains handoffs: resume prior work across sessions and tools, checkpoint before context runs out, hand focused context to a delegate."
---

# Chains

A Chain is a markdown handoff under `.chains/<chain>/<timestamp>-<slug>.md`, shared by Pi, Claude Code and Codex in the same project.

- **Resume**: `chain_search` for a topic, `chain_load` for the latest link of a chain (or a named `link`), `chain_list` to see what exists.
- **Save** with `chain_save` at durable milestones, not after every edit: the request, decisions, files changed or read, blockers, pending tasks, and a structured `nextStep`. One concise link beats several noisy ones.
- **Branch** a divergent line of work with `chain_fork`, then `chain_save` with its `branch` and `parent`.
- **Delegate** with `chain_context` (`mode: pack`) to hand a subagent bounded context.

At 80% context the first stop is refused once as a reminder to save a link; save it, then carry on. After compaction the latest link is handed back automatically.
