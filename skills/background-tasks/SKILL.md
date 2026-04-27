---
name: background-tasks
description: Use when starting, supervising, reading, or stopping long-running commands such as dev servers, test watchers, build/watch loops, REPLs, services, workers, or any command that should keep running while the conversation continues. Prefer managed proc_* tools over bash backgrounding.
---

# Background Tasks

Use Pi's managed process tools for long-running work.

## Core rule

Do **not** start background work with shell detachment patterns:

```bash
cmd &
nohup cmd ...
disown
setsid cmd ...
```

Use `proc_start` instead. Managed tasks are visible, bounded, readable, signalable, and cleaned up by Pi.

## When to use this skill

Use this workflow for:

- dev servers (`npm run dev`, `vite`, `next dev`, `rails server`, etc.)
- test watchers
- build/watch loops
- file watchers
- workers and queues
- REPL-like tools that need stdin
- scripts expected to run longer than a normal blocking command
- commands the user wants to inspect later
- commands that should survive `/reload` when explicitly requested

For short one-shot commands, normal shell tools are fine.

## Default workflow

1. Start the task with `proc_start`.
2. Give the task a clear `name` based on its purpose.
3. Set `waitMs` to capture initial readiness/failure output.
4. Use `proc_read` with `afterSeq` to poll new output.
5. Use `proc_logs` or `/proc:logs` for larger history.
6. Use `proc_write` for stdin.
7. Use `proc_signal` or `/proc:kill` to stop it.
8. Use `proc_clear` after it is terminal, optionally with `deleteLogs: true`.

Example:

```json
{
  "name": "dev-server",
  "command": "npm run dev",
  "waitMs": 1000,
  "maxBytes": 4000,
  "watches": [
    {
      "pattern": "ready",
      "mode": "substring",
      "stream": "stdout",
      "triggerTurn": false
    }
  ]
}
```

## Backend choice

Use this decision tree:

1. Use the default `pipe` backend for most tasks.
2. Use `backend: "pty"` when the command needs a TTY, colors, terminal prompts, or `test -t` behavior.
3. Use `backend: "tmux"` for terminal-style tasks that benefit from tmux behavior.
4. Use `persistent: true` only when the user wants the task to survive Pi reloads; this uses tmux-backed persistence.

Do not choose tmux just because a task is long-running. The pipe backend is the clean default.

## Watches and alerts

Add watches when there is a useful readiness or failure marker.

Good watch patterns:

- server ready: `ready`, `listening`, `Local:`, `compiled successfully`
- tests failed: `FAIL`, `failed`, `panic`, `Error:`
- worker ready: `connected`, `subscribed`, `processed`

Use `triggerTurn: false` for informational readiness if the agent does not need to wake up immediately.

Use `repeat: true` only when repeated alerts are actually useful. One-shot watches are the safer default.

## Reading output

Prefer cursor reads:

```json
{
  "id": "p_abc_1",
  "afterSeq": 12,
  "waitMs": 1000,
  "maxBytes": 8000,
  "stream": "combined"
}
```

Keep track of `nextSeq` and pass it back as `afterSeq` on the next read.

Use `/proc:logs [id|name]` for human log inspection. It opens a searchable overlay when Pi UI is available.

## Stopping and cleanup

For graceful shutdown:

```json
{
  "id": "p_abc_1",
  "signal": "SIGTERM",
  "tree": true,
  "timeoutMs": 5000
}
```

If graceful shutdown fails, use `SIGKILL`.

After a task exits, clear it if it is no longer useful:

```json
{
  "id": "p_abc_1",
  "deleteLogs": true
}
```

To stop all managed tasks when the user asks for cleanup, use `/proc:kill-all` or signal all running records with `proc_signal`.

## Human UI commands

Mention these when useful:

```text
/proc                                  # interactive task panel
/proc:list                             # text task list
/proc:dock show                        # compact status dock
/proc:logs [id|name] [combined|stdout|stderr]
/proc:settings                         # session defaults
/proc:kill [id|name|--all]
/proc:clear [id|name|--exited]
```

## Persistent tasks

Only use `persistent: true` when requested or clearly required.

Persistent tasks:

- are tmux-backed
- survive `/reload`
- restore metadata on the next Pi session start
- preserve one-shot watch fired state

Do not promise pipe-backed persistence. Pipe stdio cannot be reattached after Pi reloads.

## Communication style

When starting long-running work, report:

- process name
- process ID
- what command was launched
- how to inspect logs or stop it

Example response:

```text
Started dev-server as p_abc_1. Use /proc or /proc:logs dev-server to inspect it; /proc:kill dev-server stops it.
```
