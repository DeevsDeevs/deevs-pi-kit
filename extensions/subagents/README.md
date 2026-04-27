# Subagents Extension

Curated Deevs staff agents for Pi. Subagents run as managed background jobs on top of the `processes` extension.

## Built-in staff

- `explorer` — targeted code/context recon
- `architect` — design and migration planning
- `reviewer` — strict correctness/security/performance review
- `tester` — test strategy and validation gaps
- `devops` — runtime/config/process/deployment investigation
- `python-dev` — Python-specific review
- `cpp-dev` — C++ correctness/UB/performance review
- `rust-dev` — Rust ownership/async/API review
- `anti-slop` — remove AI-generated complexity and noise

## Tools

- `agent_list`
- `agent_start`
- `agent_parallel_start`
- `agent_read`
- `agent_status`
- `agent_stop`
- `agent_logs`
- `agent_clear`

Subagents are read-only by default. Pass `allowWrite: true` only when writes were explicitly requested.

Subagent completion/failure/timeout notifications wake the parent agent by default. Backing `agent:`/`agent-group:` process notifications are suppressed so users do not get duplicate background-task alerts for the same subagent lifecycle event.

## Commands

```text
/agents                 # dashboard/status when runs exist, staff catalog otherwise
/agents:catalog         # staff catalog browser
/agents:list            # text staff catalog
/agents:run explorer -- Map this feature
/agents:parallel reviewer,tester,anti-slop -- Review current diff
/agents:status
/agents:read a_...
/agents:stop a_...
/agents:logs a_... result
/agents:clear a_...
/agents:dock show
/agents:settings
```

## Runtime model

Each run launches a child Pi process in JSON print mode using:

- `--no-skills`
- `--no-extensions`
- explicit child safety runtime extension
- `--append-system-prompt`
- run-specific `--session-dir`

Run artifacts live under:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/subagent-runs/<project-hash>/<run-id>/
```

The status index is session-scoped/in-memory for MVP, matching `/proc:settings` and non-persistent process records.
