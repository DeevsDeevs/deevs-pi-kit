# Managed Background Tasks for Pi

A Codex-style process manager for [Pi](https://pi.dev). It lets agents and humans run long-lived commands safely without detached shell hacks such as `cmd &`, `nohup`, `disown`, or `setsid`.

## Why this exists

LLM coding agents often need to start development servers, test watchers, build daemons, REPL-like tools, and other long-running commands. A normal shell tool call is a poor fit: it blocks the turn, loses context, or encourages unmanaged backgrounding.

This extension gives those tasks a managed lifecycle:

- start a process and get a process ID
- read output incrementally by cursor
- write to stdin
- send signals
- inspect bounded logs
- receive alerts when watches match or processes finish
- clean up safely on reload/shutdown

## Features

- **Managed IDs**: every task gets a stable ID like `p_abc_1`.
- **Cursor reads**: `proc_read` supports `afterSeq` to avoid rereading old output.
- **Bounded memory**: output buffers are capped per process.
- **Bounded logs**: combined/stdout/stderr logs are capped on disk.
- **Stdin support**: write input and optionally close stdin.
- **Signal control**: send `SIGINT`, `SIGTERM`, or `SIGKILL`.
- **Watches**: substring or regex matches on stdout/stderr/both.
- **Alerts**: Pi chat messages with custom type `background-tasks`.
- **Backends**: pipe by default, PTY via `node-pty`, tmux for terminal/persistent tasks.
- **Persistence**: tmux-backed tasks can survive Pi reloads.
- **UI**: `/proc` opens an interactive panel; `/proc:dock` shows compact status.
- **Log viewer**: `/proc:logs` opens a searchable log overlay when UI is available.
- **Settings UI**: `/proc:settings` configures session defaults.

## Quick start

Ask the agent to start a managed task, or call the tool directly:

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

Then inspect it from Pi:

```text
/proc
/proc:dock show
/proc:read dev-server
/proc:logs dev-server
/proc:kill dev-server
```

## Tools

### `proc_start`

Start a managed task.

```json
{
  "name": "api",
  "command": "npm run dev",
  "waitMs": 1000,
  "maxBytes": 4000
}
```

Use direct argv when you do not need a shell:

```json
{
  "name": "worker",
  "argv": ["node", "worker.js"]
}
```

Common options:

| Option | Description |
| --- | --- |
| `name` | Human-readable task name. |
| `command` | Shell command string. Mutually exclusive with `argv`. |
| `argv` | Executable plus arguments. Mutually exclusive with `command`. |
| `cwd` | Working directory. Project-constrained by default. |
| `waitMs` | Initial wait before returning output. |
| `maxBytes` | Maximum output bytes returned by the tool call. |
| `backend` | `pipe`, `pty`, or `tmux`. Defaults to `pipe`. |
| `env` | Environment overlay. |
| `persistent` | Keep task alive across Pi reloads using tmux. |
| `alertOnExit` | Wake agent on clean exit. Defaults to false. |
| `alertOnFailure` | Wake agent on failure. Defaults to true. |
| `watches` | Output watch rules. |

### `proc_read`

Read buffered output.

```json
{
  "id": "p_abc_1",
  "afterSeq": 3,
  "waitMs": 1000,
  "maxBytes": 8000,
  "stream": "combined"
}
```

Streams:

- `combined`
- `stdout`
- `stderr`

The result includes sequence metadata such as `nextSeq` and `earliestSeq`, so callers can continue reading from the right cursor.

### `proc_list`

List managed tasks.

```json
{
  "includeExited": true,
  "includePersistent": true
}
```

### `proc_write`

Write to stdin.

```json
{
  "id": "p_abc_1",
  "input": "yes\n"
}
```

Close stdin after writing:

```json
{
  "id": "p_abc_1",
  "input": "done\n",
  "end": true
}
```

### `proc_signal`

Signal a task.

```json
{
  "id": "p_abc_1",
  "signal": "SIGTERM",
  "tree": true,
  "timeoutMs": 5000
}
```

Supported signals:

- `SIGINT`
- `SIGTERM`
- `SIGKILL`

### `proc_logs`

Read log tails and paths. This is the model/tool API; the human UI for the same logs is `/proc:logs`.

```json
{
  "id": "p_abc_1",
  "stream": "combined",
  "maxBytes": 16000
}
```

Each task can have:

- combined log
- stdout log
- stderr log

### `proc_clear`

Clear terminal task records.

```json
{
  "id": "p_abc_1",
  "deleteLogs": true
}
```

Clear all exited records:

```json
{
  "allExited": true,
  "deleteLogs": true
}
```

Running tasks cannot be cleared. Stop them first.

## Commands

| Command | Description |
| --- | --- |
| `/proc` | Open the interactive task panel. |
| `/proc:list` | Show a text task list. |
| `/proc:dock [show\|hide\|toggle]` | Show/hide compact status below the editor. |
| `/proc:read [id\|name]` | Show buffered output. |
| `/proc:logs [id\|name] [combined\|stdout\|stderr]` | Open searchable log overlay, with text fallback outside UI. |
| `/proc:settings` | Configure session defaults. |
| `/proc:kill [id\|name\|--all]` | Send `SIGTERM` to one task or all tasks. |
| `/proc:kill-all` | Send `SIGTERM` to all running tasks. |
| `/proc:signal [id\|name] [SIGINT\|SIGTERM\|SIGKILL]` | Send an explicit signal. |
| `/proc:clear [id\|name\|--exited]` | Clear terminal records. |

### `/proc` keys

```text
up/down  select task
enter/r  read buffered output
l        show logs
k        SIGTERM selected task
i        SIGINT selected task
x        SIGKILL selected task
a        SIGTERM all running tasks
c        clear selected terminal record
q/esc    close
```

`/proc:dock` is intentionally non-interactive. Pi widgets are good status surfaces; `/proc` is the focused keyboard UI.

### `/proc:logs` keys

```text
/ or f   search/filter
up/down  scroll
PgUp/PgDn page
g/G      top/bottom
c        clear search
q/esc    close
```

### `/proc:settings`

`/proc:settings` opens a session-scoped settings panel.

Available settings:

- default backend: `pipe`, `pty`, `tmux`
- kill non-persistent tasks on reload
- kill non-persistent tasks on shutdown
- wake on failure by default
- wake on clean exit by default
- dock enabled
- dock height

## Backends

### Pipe backend

Default backend. Use it for most background scripts and dev commands.

```json
{
  "name": "tests",
  "command": "npm test -- --watch"
}
```

Pros:

- direct child process lifecycle
- stdout/stderr separation
- process-group signaling
- no external terminal dependency

### PTY backend

Use when the command needs a TTY.

```json
{
  "name": "interactive",
  "backend": "pty",
  "argv": ["/bin/bash", "-lc", "test -t 1 && echo TTY"]
}
```

The package declares `node-pty` as an optional dependency. If it is unavailable, PTY starts fail with a clear error.

### Tmux backend

Use for terminal-style tasks or persistence.

```json
{
  "name": "terminal-server",
  "backend": "tmux",
  "command": "npm run dev"
}
```

Persistent tasks use tmux by default:

```json
{
  "name": "worker",
  "persistent": true,
  "command": "node worker.js"
}
```

Pipe tasks are not persisted because their stdio cannot be reattached after Pi reloads.

## Watches and alerts

Watches match output and send `background-tasks` chat messages.

```json
{
  "name": "server",
  "command": "npm run dev",
  "watches": [
    {
      "pattern": "listening",
      "mode": "substring",
      "stream": "stdout",
      "triggerTurn": false
    }
  ]
}
```

Regex watch:

```json
{
  "pattern": "listening on .*:3000",
  "mode": "regex",
  "stream": "both"
}
```

Watch options:

| Option | Description |
| --- | --- |
| `pattern` | String or regex pattern. |
| `mode` | `substring` or `regex`. Defaults to `substring`. |
| `stream` | `stdout`, `stderr`, or `both`. Defaults to `both`. |
| `repeat` | Allow repeated matches with cooldown. Defaults to false. |
| `triggerTurn` | Wake the agent when matched. Defaults to true. |

One-shot watch state is persisted for persistent tasks, so a watch does not replay on each reload.

## Alert policy

Process completion always produces a visible `background-tasks` message.

Agent wake-up is controlled separately:

| Event | Visible message | Agent wake-up |
| --- | --- | --- |
| Clean exit | Yes | Only with `alertOnExit: true` |
| Failure | Yes | Yes by default via `alertOnFailure: true` |
| Intentional signal | Yes | No by default |
| Reload/shutdown cleanup | One grouped message | No |
| Watch match | Yes | Controlled by `triggerTurn` |

## Safety model

The extension is designed to keep background work visible and bounded.

- Blocks common detached-shell patterns in bash guidance paths:
  - `cmd &`
  - `nohup`
  - `disown`
  - `setsid`
- Caps live process count.
- Caps memory buffers.
- Caps disk logs.
- Caps read wait time.
- Caps watch count and pattern size.
- Constrains `cwd` to the project by default.
- Stops non-persistent tasks on reload/shutdown.

## Logs and state

Default locations:

```text
~/.pi/agent/process-logs/<project-hash>/
~/.pi/agent/process-state/<project-hash>.json
```

The actual root can vary with Pi runtime environment settings.

## FAQ

### Should agents use `cmd &` anymore?

No. Use `proc_start`. Managed tasks are visible, bounded, readable, and killable.

### Which backend should I use?

Use `pipe` by default. Use `pty` if the command needs a TTY. Use `tmux` if you want terminal-style behavior or persistence.

### Why does `persistent: true` use tmux?

A pipe child cannot be reattached after the Pi extension runtime reloads. Tmux provides an external session that can survive reloads and be rediscovered.

### Can I attach to persistent tasks manually?

Yes, persistent tasks are tmux-backed. The tmux session name is derived from the process ID, for example `pi_p_abc_1`.

### Why does `/proc:dock` not accept keyboard navigation?

Pi widgets are status surfaces. The interactive UI is `/proc`, which opens a custom overlay with focus and key handling.

### Are `/proc:settings` changes persistent?

Not yet. They apply to the current extension instance/session. Use them for quick runtime tuning; package-level config persistence can be added later.

### What happens on `/reload`?

Non-persistent tasks are stopped and reported in one grouped cleanup message. Persistent tmux tasks keep running, old pollers/log writers are closed, and the new extension instance restores metadata.

### Why do I get a process-finished message even for clean exits?

Completion messages are lifecycle visibility. Agent wake-up is separate: clean exits only wake the agent if `alertOnExit: true`.

### How do I remove old records and logs?

Use:

```text
/proc:clear --exited
```

or the tool:

```json
{
  "allExited": true,
  "deleteLogs": true
}
```

### Is this tied to Bun?

No. Pi extensions currently run on Node. Bun is only used for development validation in this repo.

## Limitations

- `/proc:settings` changes are session-scoped and not persisted yet.
- Pipe tasks cannot survive Pi reloads.
- Persistent tasks require tmux.
- PTY support depends on optional `node-pty` installation.
