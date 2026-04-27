# deevs-pi-kit

Perfect pi kit to be 10x Deevs' engineer.

This is Deevs' portable [Pi](https://pi.dev) package. It stays small and grows only with tools that earn their keep.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit
```

Pinned to a tag or commit:

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit@v0.1.0
```

Project-local install:

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l
```

Local development install:

```bash
pi install /Users/deevs/programming/agents/deevs-pi-kit
```

Reload after edits inside Pi:

```text
/reload
```

## Contents

```text
.
├── extensions/              # TypeScript Pi extensions
│   ├── processes/           # Managed background-task extension
│   └── subagents/           # Curated background staff agents
├── prompts/                 # Prompt templates
├── skills/                  # Agent behavior guidance
├── docs/                    # Design notes and implementation plans
└── package.json             # Pi package manifest
```

## Skills

### Background tasks

`skills/background-tasks/` teaches the agent when to use the managed process tools instead of shell backgrounding.

It should trigger for dev servers, test watchers, build/watch loops, workers, REPL-like tools, and any command that should continue running while the conversation proceeds.

The skill reinforces:

- use `proc_start` instead of `cmd &`, `nohup`, `disown`, or `setsid`
- use cursor reads with `proc_read`
- choose `pipe` by default, `pty` for TTY behavior, and tmux for persistence/terminal workflows
- use watches intentionally
- stop and clear tasks cleanly

### Subagents

`skills/subagents/` teaches the agent when to use curated background staff agents.

It reinforces:

- use `explorer` for non-trivial reconnaissance
- use `reviewer`, `tester`, and `anti-slop` for independent pre-merge checks
- use `agent_parallel_start` for independent perspectives
- keep subagents read-only unless writes were explicitly requested
- inspect background runs with `agent_status`, `agent_read`, and `agent_logs`

## Extensions

### Managed background processes

The first real extension is `extensions/processes/`: Codex-style managed background tasks for Pi.

It exists so agents can run long-lived commands safely without using detached shell hacks like `cmd &`, `nohup`, `disown`, or `setsid`.

Highlights:

- process IDs
- cursor/chunk reads
- stdin writes
- signal control
- bounded memory output
- bounded disk logs
- process watches and `background-tasks` alerts
- pipe backend by default
- PTY backend via `node-pty`
- tmux backend
- persistent tmux-backed tasks
- `/proc` interactive panel
- `/proc:logs` searchable log overlay
- `/proc:settings` session settings
- `/proc:dock` status widget
- reload/shutdown cleanup

Full extension docs: [`extensions/processes/README.md`](extensions/processes/README.md).

Roadmap and design notes: [`docs/processes-plugin-plan.md`](docs/processes-plugin-plan.md).

#### Tools

- `proc_start` — start a managed task
- `proc_read` — read buffered output by cursor
- `proc_list` — list tasks
- `proc_write` — write to stdin
- `proc_signal` — send `SIGINT`, `SIGTERM`, or `SIGKILL`
- `proc_logs` — inspect bounded log tails and paths; `/proc:logs` provides the UI overlay
- `proc_clear` — clear terminal records and optionally delete logs

#### Commands

- `/proc` — interactive overlay panel for navigating/managing tasks
- `/proc:list` — text process list
- `/proc:dock [show|hide|toggle]` — non-interactive status dock below the editor
- `/proc:read [id|name]` — show buffered output
- `/proc:logs [id|name] [combined|stdout|stderr]` — searchable log overlay, with text fallback outside UI
- `/proc:settings` — configure session defaults
- `/proc:kill [id|name|--all]` — gracefully stop one task or all tasks
- `/proc:kill-all` — gracefully stop all running managed tasks
- `/proc:signal [id|name] [SIGINT|SIGTERM|SIGKILL]` — send an explicit signal
- `/proc:clear [id|name|--exited]` — clear terminal records

#### Quick examples

Start a normal background command:

```json
{
  "name": "dev-server",
  "command": "npm run dev",
  "waitMs": 1000,
  "maxBytes": 4000
}
```

Read output by cursor:

```json
{
  "id": "p_abc_1",
  "afterSeq": 3,
  "waitMs": 1000
}
```

Start a persistent task:

```json
{
  "name": "worker",
  "persistent": true,
  "command": "node worker.js"
}
```

Start with a watch:

```json
{
  "name": "server",
  "command": "npm run dev",
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

### Curated subagents

`extensions/subagents/` provides Deevs-style staff agents as background jobs backed by the process manager.

Built-in staff:

- `explorer`
- `architect`
- `reviewer`
- `tester`
- `devops`
- `python-dev`
- `cpp-dev`
- `rust-dev`
- `anti-slop`

Tools:

- `agent_list`
- `agent_start`
- `agent_parallel_start`
- `agent_read`
- `agent_status`
- `agent_stop`
- `agent_logs`
- `agent_clear`

Commands:

- `/agents` — dashboard/status when runs exist, staff catalog otherwise
- `/agents:catalog` — staff catalog browser
- `/agents:browse` — alias for `/agents:catalog`
- `/agents:list`
- `/agents:run`
- `/agents:parallel`
- `/agents:status`
- `/agents:read`
- `/agents:stop`
- `/agents:logs`
- `/agents:clear`
- `/agents:dock`
- `/agents:settings`

Quick examples:

```json
{
  "agent": "explorer",
  "task": "Map how the processes extension starts and reads managed processes."
}
```

```text
/agents:parallel reviewer,tester,anti-slop -- Review current diff
```

Full extension docs: [`extensions/subagents/README.md`](extensions/subagents/README.md).

Implementation plan: [`docs/plans/subagents-extension-plan.md`](docs/plans/subagents-extension-plan.md).

## Development

Validate package contents:

```bash
npm pack --dry-run
```

Bundle-check the extensions during development:

```bash
bun build extensions/processes/index.ts \
  --outdir /tmp/deevs-proc-build \
  --external @mariozechner/pi-coding-agent \
  --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui \
  --external node-pty

bun build extensions/subagents/index.ts \
  --outdir /tmp/deevs-subagents-build \
  --external @mariozechner/pi-coding-agent \
  --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui \
  --external node-pty
```

Pi currently runs extensions on Node, so extension code must avoid Bun runtime APIs unless it explicitly spawns a Bun helper.
