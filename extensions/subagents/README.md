# Subagents

Curated Deevs staff agents for Pi. Each subagent runs as a managed background job backed by the `processes` extension.

## Staff

```text
explorer    code/context reconnaissance
architect   design and migration planning
reviewer    correctness/security/performance review
tester      test strategy and validation gaps
devops      runtime/config/process/deployment investigation
python-dev  Python-specific review
cpp-dev     C++ correctness/UB/performance review
rust-dev    Rust ownership/async/API review
anti-slop   remove AI-generated complexity and noise
```

## Defaults

- read-only unless `allowWrite: true` is explicitly passed
- completion/failure/timeout messages wake the parent agent
- backing process notifications are suppressed to avoid duplicate alerts
- active runs show a compact footer status
- `/agents` opens the dashboard when runs exist, otherwise the staff catalog
- optional `chainContext` is packed by the parent and prepended to the task

## Tools

```text
agent_list            list available staff agents
agent_start           start one background subagent; accepts optional chainContext
agent_parallel_start  start a parallel group; each task accepts optional chainContext
agent_read            read friendly output, or raw process chunks
agent_status          inspect runs/groups
agent_stop            stop a run/group
agent_logs            inspect artifacts or compact backing process logs; raw:true for full JSON stream
agent_clear           clear completed records/artifacts
```

## Commands

```text
/agents                       dashboard/status if runs exist; catalog otherwise
/agents:catalog               staff browser
/agents:browse                alias for /agents:catalog
/agents:list                  text staff list
/agents:run <agent> -- <task>
/agents:parallel a,b -- <task>
/agents:status                run/group dashboard
/agents:read <id> [--raw]
/agents:logs <id> [source] [--raw]
/agents:stop <id>
/agents:clear <id|--completed> [--delete-artifacts]
/agents:dock [show|hide|toggle]
/agents:settings                         settings overlay; persists changes
/agents:settings status                  show project-persistent settings
/agents:settings reset                   reset settings and persist defaults
```

Log sources:

```text
result  task  system-prompt  metadata  combined  stdout  stderr
```

For `combined`, `stdout`, and `stderr`, `agent_logs` and `/agents:logs` default to compact activity summaries that omit JSON token deltas, tool deltas, and model reasoning. Use `raw:true` or `--raw` only when debugging the backing process log format itself.

## Examples

```json
{
  "agent": "explorer",
  "task": "Map how the process extension starts and reads managed processes."
}
```

```json
{
  "agent": "reviewer",
  "task": "Review the current plan using the saved handoff context.",
  "chainContext": { "chain": "deevs-pi-kit", "branch": "main", "mode": "pack", "includeParents": 2, "searchQuery": "handoff", "maxBytes": 12000 }
}
```

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "Review the current diff for correctness." },
    { "agent": "tester", "task": "Find missing validation coverage." },
    { "agent": "anti-slop", "task": "Identify avoidable complexity in the current diff." }
  ],
  "concurrency": 3
}
```

```text
/agents:parallel reviewer,tester,anti-slop -- Review current diff
```

## Runtime model

Subagents launch child Pi processes in isolated JSON-print mode with a run-specific session directory and safety runtime. Artifacts live under:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/subagent-runs/<project-hash>/<run-id>/
```

The live status index is session-scoped/in-memory. Artifacts remain on disk until cleared with `deleteArtifacts` / `--delete-artifacts`.

## Project settings

Subagent defaults persist to `.pi/subagents.json` when changed through `/agents:settings`, `/agents:dock`, or the settings overlay.

Persisted settings include model allowlists/defaults, timeout/concurrency defaults, dock settings, write default, and terminal wake-up behavior. `defaultAllowWrite` still defaults to `false`; only persist `true` deliberately.
