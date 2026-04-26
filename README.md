# deevs-pi-kit

Perfect pi kit to be 10x Deevs' engineer.

This is Deevs' portable [pi](https://pi.dev) package.

It starts minimal and grows only with tools that earn their keep.

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

## Structure

```text
.
├── extensions/   # TypeScript pi extensions
├── prompts/      # Markdown prompt templates
├── skills/       # Agent skills, each with SKILL.md
└── package.json  # pi package manifest
```

## Extensions

### Managed background processes

A first implementation lives in `extensions/processes/`.

Current support includes bounded memory output, disk log tails, process watches/alerts, and shutdown cleanup.

Current tools:

- `proc_start`
- `proc_read`
- `proc_list`
- `proc_write`
- `proc_signal`
- `proc_logs`
- `proc_clear`

Current commands:

- `/proc`
- `/proc:read [id|name]`
- `/proc:kill [id|name]`
- `/proc:logs [id|name]`
- `/proc:clear [id|name|--exited]`

Full roadmap: [`docs/processes-plugin-plan.md`](docs/processes-plugin-plan.md).

## Development

Try locally from another repo:

```bash
pi install /Users/deevs/programming/agents/deevs-pi-kit
```

Reload after edits inside pi:

```text
/reload
```
