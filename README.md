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
│   └── processes/           # Managed background-task extension
├── prompts/                 # Prompt templates; intentionally empty for now
├── skills/                  # Skills; intentionally empty for now
├── docs/                    # Design notes and implementation plans
└── package.json             # Pi package manifest
```

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

## Development

Validate package contents:

```bash
npm pack --dry-run
```

Bundle-check the process extension during development:

```bash
bun build extensions/processes/index.ts \
  --outdir /tmp/deevs-proc-build \
  --external @mariozechner/pi-coding-agent \
  --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui \
  --external node-pty
```

Pi currently runs extensions on Node, so extension code must avoid Bun runtime APIs unless it explicitly spawns a Bun helper.
