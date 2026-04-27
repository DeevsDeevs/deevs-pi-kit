---
name: subagents
description: Use curated Deevs staff subagents for background exploration, review, testing, architecture, devops, language-specific review, and anti-slop passes.
---

# Subagents

Use the `agent_*` tools to delegate focused work to curated background staff agents.

## When to delegate

- Use `agent_start` with `explorer` for non-trivial reconnaissance before editing.
- Use `reviewer`, `tester`, and `anti-slop` for independent pre-merge perspectives.
- Use `architect` for design boundaries and migration plans.
- Use `devops` for runtime/config/process/log/deployment failures.
- Use `python-dev`, `cpp-dev`, or `rust-dev` for language-specific review.
- Use `agent_parallel_start` when perspectives are independent and can run at the same time.
- When a subagent needs durable handoff context, pass `chainContext` or call `chain_context` first and paste the bounded excerpt into the task.

Do not over-delegate trivial tasks. If the answer is obvious from one file or one command, do it directly.

## Lifecycle

Subagents are background jobs. After starting one:

1. Use `agent_status` to see state.
2. Use `agent_read` for friendly output.
3. Use `agent_logs` for artifacts/process logs.
4. Use `agent_stop` if a run is stuck or no longer useful.
5. Use `agent_clear` only for terminal records.

Backing processes also appear in `/proc` because the subagents extension uses the background process manager.

## Safety

- Built-in agents are read-only by default.
- Only pass `allowWrite: true` when the user explicitly asked for a subagent to write.
- `allowWrite: true` enables `edit` and `write` for that child run.
- Prefer `context: "fresh"` unless the subagent needs current conversation context; use `context: "fork"` only when needed.
- Model overrides must be configured in `/agents:settings`.
- `chainContext` is loaded by the parent and passed as untrusted reference data; subagents do not get chain write tools by default.
