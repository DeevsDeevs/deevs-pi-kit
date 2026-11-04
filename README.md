# deevs-pi-kit

Claude Code's background agents and workflows in [Pi](https://github.com/earendil-works/pi), on any model Pi runs, surviving `/reload` and a restart. Plus a todo widget, `ask_user`, a ChatGPT fast-tier toggle and a one-line hint for Pi running inside an hc terminal.

Long-running processes, cross-model peers and other machines are hc's job; cross-agent skills live in [agent-system](https://github.com/DeevsDeevs/agent-system). This kit keeps only what belongs inside Pi.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit    # add -l for this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit     # upgrade
```

Then `/reload`. Needs Pi 1.4.0+ and Node 22.19+. The one real dependency, `@earendil-works/pi-durable` (about 90 packages, 125 MB), keeps agents alive across restarts.

## Tools

| Tool | What it does |
|---|---|
| [`Agent`](docs/reference.md#agent) | Claude Code's agent tool: agent types (`Explore`, `Plan`, reviewer, tester, ...), worktrees, 16 at once |
| [`Workflow`](docs/reference.md#workflow) | a JS script of `agent()`, `parallel()` and `pipeline()` you can edit and resume |
| `SendMessage`, `TaskStop`, `ListAgents` | steer or resume an agent, stop a task, list them |
| [`todo_list`](extensions/todos/README.md) | a session todo widget |
| `ask_user` | asks before irreversible choices |

`/agents` lists tasks, agent types and model names. Everything else is in [docs/reference.md](docs/reference.md).

## Development

```bash
npm install
npm run check    # typecheck, tests, audit, pack
```
