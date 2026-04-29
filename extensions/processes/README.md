# Background Tasks / Managed Processes

This extension lives at `extensions/processes/` because it manages OS processes. In user-facing docs and skills, the workflow is called **background tasks** because that is the intent: run a command while the conversation continues.

Use the paired skill at [`skills/background-tasks`](../../skills/background-tasks/SKILL.md) for agent behavior guidance.

Run long-lived commands in Pi without detached shell hacks (`cmd &`, `nohup`, `disown`, `setsid`). Tasks stay visible, readable, bounded, and killable.

Use this for dev servers, watch loops, workers, REPL-like tools, and anything that should continue while the conversation proceeds.

## What you get

- managed IDs like `p_abc_1`
- cursor reads with `nextSeq` / `afterSeq`
- stdin writes and signal control
- bounded memory buffers and disk logs
- output watches with optional agent wake-up
- `pipe`, `pty`, and `tmux` backends
- tmux-backed persistence across Pi reloads
- blue footer status for active non-subagent tasks
- `/proc` panel, `/proc:logs` viewer, optional `/proc:dock`

## Quick start

```json
{
  "name": "dev-server",
  "command": "npm run dev",
  "waitMs": 1000,
  "maxBytes": 4000,
  "watches": [{ "pattern": "ready", "stream": "stdout", "triggerTurn": false }]
}
```

Inspect from Pi:

```text
/proc
/proc:read dev-server
/proc:logs dev-server
/proc:kill dev-server
```

## Naming map

```text
User intent / skill:     background tasks
Extension implementation: extensions/processes/
Tool prefix:             proc_*
Slash commands:          /proc and /proc:*
Footer/status label:     background-tasks
```

## Tools

```text
proc_start   start a task: command or argv; backend pipe|pty|tmux
proc_read    read buffered output by cursor
proc_list    list running/recent/persistent tasks
proc_write   write to stdin
proc_signal  send SIGINT, SIGTERM, or SIGKILL
proc_logs    inspect bounded log tails and paths
proc_clear   clear terminal records, optionally deleting logs
```

Useful `proc_start` options:

```text
name, command|argv, cwd, waitMs, maxBytes, backend,
persistent, alertOnExit, alertOnFailure, watches
```

## Commands

```text
/proc                         interactive task panel
/proc:list                    text task list
/proc:read <id|name>          buffered output
/proc:logs <id|name> [stream] searchable log overlay
/proc:kill <id|name|--all>    SIGTERM
/proc:kill-all                SIGTERM all running tasks
/proc:signal <id|name> <sig>  SIGINT/SIGTERM/SIGKILL
/proc:clear <id|name|--exited>
/proc:dock [show|hide|toggle] optional status widget
/proc:settings                settings overlay; persists changes
/proc:settings status         show project-persistent settings
/proc:settings reset          reset settings and persist defaults
/proc:settings set <key> <value>
```

`/proc` keys:

```text
up/down select   enter/r read   l logs   i INT   k TERM   x KILL
a kill all       c clear        q/esc close
```

`/proc:logs` keys:

```text
/ search   up/down scroll   PgUp/PgDn page   g/G top/bottom   q close
```

## Backends

- `pipe` — default; best for most commands.
- `pty` — use when the command needs a TTY; requires optional `node-pty`.
- `tmux` — use for terminal-style tasks or `persistent: true`.

Persistent tasks use tmux because pipe children cannot be reattached after extension reload.

## Watches and alerts

A watch matches output and sends a `background-tasks` message:

```json
{
  "pattern": "listening on .*:3000",
  "mode": "regex",
  "stream": "both",
  "repeat": false,
  "triggerTurn": true
}
```

Clean exits are visible but wake the agent only with `alertOnExit: true`. Failures wake by default. Watch wake-up is controlled by `triggerTurn`.

Subagent backing processes (`agent:` / `agent-group:`) are excluded from background-task notifications and footer counts; inspect them with `proc_list` when needed.

## Project settings

Process defaults persist to `.pi/processes.json` when changed through `/proc:settings`, `/proc:dock`, or the settings overlay. Runtime process state remains separate under Pi's agent directory.

Supported command keys:

```text
defaultBackend killOnReload killOnShutdown defaultAlertOnFailure
defaultAlertOnExit dockEnabled dockHeight blockBackgroundBash
```

## Logs and state

Default locations:

```text
~/.pi/agent/process-logs/<project-hash>/
~/.pi/agent/process-state/<project-hash>.json
```

## Limits

- settings are project-scoped in `.pi/processes.json`
- pipe tasks do not survive reload
- persistent tasks require tmux
- PTY support depends on optional `node-pty`
- running tasks must be stopped before they can be cleared
