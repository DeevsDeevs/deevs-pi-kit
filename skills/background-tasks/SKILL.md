---
name: background-tasks
description: Use when starting, supervising, reading, or stopping long-running commands such as dev servers, test watchers, build/watch loops, REPLs, services, workers, or any command that should keep running while the conversation continues. Prefer managed proc_* tools over bash backgrounding.
---

# Background Tasks

Use Pi's managed process tools for commands that should keep running while the conversation continues.

Core rule: never start background work with shell detachment patterns:

```bash
cmd &
nohup cmd ...
disown
setsid cmd ...
```

Use `proc_start` instead. Managed tasks are visible, readable, signalable, and cleanable by Pi.

## When to use

Use for:

- dev servers, workers, queues, and local services
- test/build/file watchers
- REPL-like tools that need stdin
- long flaky repro loops or scripts you need to inspect later
- commands that should survive `/reload` when explicitly requested

For short one-shot commands, use normal shell tools.

## Default workflow

1. Start with `proc_start` and a clear `name`.
2. Set `waitMs` to capture initial readiness/failure output.
3. Read incremental output with `proc_read` and `afterSeq`.
4. Use `proc_write` for stdin.
5. Stop with `proc_signal`.
6. Clear terminal records with `proc_clear` when no longer useful.

Example:

```json
{
  "name": "dev-server",
  "command": "npm run dev",
  "waitMs": 1000,
  "maxBytes": 4000,
  "watches": [{ "pattern": "ready", "mode": "substring", "stream": "stdout" }]
}
```

## Backend choice

- Default `pipe`: most tasks.
- `backend: "pty"`: command needs a TTY, colors, terminal prompts, or `test -t` behavior.
- `backend: "tmux"`: terminal-style tasks that specifically benefit from tmux behavior.
- `persistent: true`: only when the user wants the task to survive Pi reloads; this is tmux-backed.

Do not choose tmux just because a task is long-running. The pipe backend is the clean default.

## Watches and alerts

Add watches only for useful readiness/failure markers.

Good patterns:

- ready: `ready`, `listening`, `Local:`, `compiled successfully`
- failure: `FAIL`, `failed`, `panic`, `Error:`
- worker: `connected`, `subscribed`, `processed`

Use one-shot watches by default. Use `repeat: true` only when repeated alerts are useful. Use `triggerTurn: false` for informational readiness when the agent does not need to wake immediately.

## Reading output

Prefer cursor reads:

```json
{ "id": "p_abc_1", "afterSeq": 12, "waitMs": 1000, "maxBytes": 8000 }
```

Track `nextSeq` and pass it as `afterSeq` next time.

Use `proc_logs` or `/proc:logs` only when buffered reads are insufficient or a human needs searchable history. Do not dump large logs into context by default.

## Stopping and cleanup

Stop gracefully first:

```json
{ "id": "p_abc_1", "signal": "SIGTERM", "tree": true, "timeoutMs": 5000 }
```

Use `SIGKILL` only if graceful shutdown fails.

Clear exited records when they are no longer useful:

```json
{ "id": "p_abc_1", "deleteLogs": true }
```

## Persistent tasks

Only use `persistent: true` when requested or clearly required.

Persistent tasks:

- are tmux-backed
- survive `/reload`
- restore metadata on next Pi session start
- preserve one-shot watch fired state

Do not promise pipe-backed persistence. Pipe stdio cannot be reattached after Pi reloads.

## Report to user

When starting long-running work, report:

- process name and id
- command launched
- how to inspect output
- how to stop it

Example:

```text
Started dev-server as p_abc_1. Use /proc or /proc:logs dev-server to inspect it; /proc:kill dev-server stops it.
```
