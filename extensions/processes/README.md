# Background Tasks

Managed OS processes for Pi. Use this extension for dev servers, watchers, REPLs, workers, and other commands that should keep running while the conversation continues.

Do not use shell detaching hacks such as `&`, `nohup`, `disown`, or `setsid`; start managed tasks instead.

## Tools

```text
proc_start    start a managed process
proc_read     read buffered output by cursor
proc_list     list running, recent, and persistent processes
proc_write    write to stdin
proc_signal   send SIGINT, SIGTERM, or SIGKILL
proc_logs     inspect bounded log tails and log paths
proc_clear    clear terminal records
```

Useful `proc_start` options:

```text
name, command|argv, cwd, waitMs, maxBytes, backend,
persistent, alertOnExit, alertOnFailure, watches
```

Backends: `pipe` by default, `pty` for TTY-oriented commands, `tmux` for persistent terminal-style tasks.

## Commands

```text
/proc                         interactive process panel
/proc:list                    text process list
/proc:read <id|name>          buffered output
/proc:logs <id|name> [stream] log viewer
/proc:kill <id|name|--all>    SIGTERM
/proc:kill-all                SIGTERM all running processes
/proc:signal <id|name> <sig>  SIGINT/SIGTERM/SIGKILL
/proc:clear <id|name|--exited>
/proc:dock [show|hide|toggle]
/proc:settings [status|reset|set <key> <value>]
```

## Watches and alerts

A watch can match output and optionally wake the agent:

```json
{
  "pattern": "ready",
  "stream": "both",
  "mode": "substring",
  "triggerTurn": true
}
```

Failures wake by default. Clean exits wake only with `alertOnExit: true`. Subagent backing processes are hidden from background-task notifications to avoid duplicate alerts.

## Settings and state

Project settings persist to `.pi/processes.json` when changed through `/proc:settings`, `/proc:dock`, or the settings overlay.

Supported settings keys:

```text
defaultBackend killOnReload killOnShutdown defaultAlertOnFailure
defaultAlertOnExit dockEnabled dockHeight blockBackgroundBash
```

Runtime process state and logs are managed by Pi outside the project config file. Pipe processes do not survive reload; persistent processes require `tmux`.
