# Subagents

Curated background agents for focused exploration, review, testing, architecture, DevOps, and language-specific feedback. Subagents run as managed background processes.

## Staff

```text
explorer    code/context reconnaissance
architect   design and migration planning
reviewer    correctness, security, and performance review
tester      validation strategy and coverage gaps
logic-hunter spec-vs-implementation logic bug hunting
devops      runtime, config, and deployment investigation
python-dev  Python-specific review
cpp-dev     C++ correctness and performance review
rust-dev    Rust ownership, async, and API review
anti-slop   simplify overbuilt or noisy changes
```

## Defaults

- read-only unless `allowWrite: true` is explicitly passed
- completion, failure, and timeout wake the parent agent
- backing process alerts are suppressed to avoid duplicates
- active runs show a compact footer status
- optional `chainContext` is loaded by the parent and prepended to the task
- optional `tokenBudget` and `costBudgetUsd` are passed as advisory task constraints and reconciled from child Pi session usage when available
- repeated `agent_read` calls for active runs/groups are throttled to one per 60 seconds by default; first and terminal reads return immediately

## Tools

```text
agent_list            list available staff agents
agent_start           start one subagent
agent_parallel_start  start a parallel group
agent_read            read friendly output or raw process chunks
agent_status          inspect runs and groups
agent_stop            stop a run or group
agent_logs            inspect artifacts or compact process logs
agent_clear           clear completed records and artifacts
```

Use `agent_read` first. Its `waitMs` parameter controls the minimum interval since the previous non-terminal read (default `60000`; `0` disables throttling). Use `agent_logs` when you need artifacts, metadata, or raw process logs. Terminal run metadata includes parsed usage and budget status when the child session recorded usage.

## Commands

```text
/agents                       dashboard if runs exist, catalog otherwise
/agents:catalog               staff browser
/agents:list                  text staff list
/agents:run <agent> -- <task>
/agents:parallel a,b -- <task>
/agents:status
/agents:read <id> [--raw]
/agents:logs <id> [source] [--raw]
/agents:stop <id>
/agents:clear <id|--completed> [--delete-artifacts]
/agents:dock [show|hide|toggle]
/agents:settings [status|reset|...]
```

Log sources: `result`, `task`, `system-prompt`, `metadata`, `combined`, `stdout`, `stderr`. Process-log sources are compact by default; use `--raw` only for debugging the child process stream.

## Project settings

Settings persist to `.pi/subagents.json` when changed through `/agents:settings`, `/agents:dock`, or the settings overlay.

Persisted settings include models, timeouts, concurrency, dock preferences, wake-up behavior, and the write default. `defaultAllowWrite` defaults to `false`; persist `true` only deliberately.
