---
name: subagents
description: Use curated Deevs staff subagents for background exploration, review, testing, architecture, devops, language-specific review, and anti-slop passes.
---

# Subagents

Use the `agent_*` tools to delegate focused work to curated background staff agents.

## When to delegate

- Use `agent_start` with `explorer` for non-trivial reconnaissance before editing.
- Use `reviewer`, `tester`, and `anti-slop` for independent pre-merge perspectives.
- Use `logic-hunter` for language-agnostic spec-vs-implementation bug hunting and data/control-flow correctness.
- Use `architect` for design boundaries and migration plans.
- Use `devops` for runtime/config/process/log/deployment failures.
- Use `python-dev`, `cpp-dev`, or `rust-dev` for language-specific review.
- Use `agent_parallel_start` when perspectives are independent and can run at the same time.
- When a subagent needs durable handoff context, pass `chainContext` or call `chain_context` first and paste the bounded excerpt into the task.

Do not over-delegate trivial tasks. If the answer is obvious from one file or one command, do it directly.

## Scope every task

Always bound subagent scope before launch:

- Prefer `agent_start` with an explicit `cwd` set to the project or package under review.
- `agent_parallel_start` currently has no top-level `cwd`; it inherits the parent working directory. If the parent cwd is too broad, use separate `agent_start` calls with explicit `cwd`, or make each parallel task explicitly say which directory/files to inspect and what to avoid.
- Name the exact files, dirs, commands, or diff ranges to inspect when possible.
- Tell subagents not to search parent directories, `~/.pi`, process logs, `node_modules`, or unrelated sibling repos unless the task is specifically about those areas.
- Put hard limits in broad review tasks: max tool calls, max files, or "inspect only these paths".

Good bounded review task:

```text
Inspect only README.md and skills/grill-me/SKILL.md in this repo.
Do not search outside cwd, ~/.pi, process logs, node_modules, or sibling repos.
Use at most 3 inspection commands. Return final structured output immediately after inspection.
```

## Lifecycle

Subagents are background jobs. After starting one:

1. Use `agent_status` to see state.
2. Use `agent_read` for normal progress/final output.
3. Use `agent_stop` if a run is stuck or no longer useful.
4. Use `agent_clear` only for terminal records.

Do not read raw logs by default. `agent_logs` is for debugging or deliberate artifact inspection, such as:

- `agent_read` is missing, truncated, or confusing.
- The run appears stuck, cancelled, failed, or timed out.
- You need `metadata`, `task`, or `system-prompt` to debug launch/scope/tool issues.
- You are diagnosing subagent behavior itself.

Prefer `agent_read` first. `agent_logs source="combined"` now defaults to compact activity, but it is still a debugging path; `agent_logs raw:true` can dump verbose JSON streams, tool chatter, and model reasoning into context.

`agent_read` may say "No final assistant output yet" while a child is still thinking or using tools. Before treating that as a hang, check `agent_status`. Use `agent_logs` only if progress is suspicious or you need to diagnose what the child is doing. If logs show broad or recursive searches, stop the run and relaunch with tighter scope.

Backing processes also appear in `/proc` because the subagents extension uses the background process manager.

## Safety

- Built-in agents are read-only by default.
- Only pass `allowWrite: true` when the user explicitly asked for a subagent to write.
- `allowWrite: true` enables `edit` and `write` for that child run.
- Prefer `context: "fresh"` unless the subagent needs current conversation context; use `context: "fork"` only when needed.
- Model overrides must be configured in `/agents:settings`.
- `chainContext` is loaded by the parent and passed as untrusted reference data; subagents do not get chain write tools by default.
