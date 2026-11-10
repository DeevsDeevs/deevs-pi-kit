# deevs-pi-kit

Small additions to [Pi](https://github.com/earendil-works/pi): a todo widget, `ask_user`, a ChatGPT fast-tier toggle, the chains digest and save reminder, and a one-line hint for Pi running inside an hc terminal.

Other agents, long-running processes, cross-model peers and other machines are hc's job: multi-agent work goes through the `hc-flow` skill, and cross-agent skills live in [agent-system](https://github.com/DeevsDeevs/agent-system). This kit keeps only what belongs inside Pi.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit    # add -l for this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit     # upgrade
```

Then `/reload`. Needs Pi 1.4.0+ and Node 22.19+. No production dependencies.

## Tools

| Tool | What it does |
|---|---|
| [`todo_list`](extensions/todos/README.md) | a session todo widget |
| `ask_user` | asks before irreversible choices |

Everything else is in [docs/reference.md](docs/reference.md).

## Development

```bash
npm install
npm run check    # typecheck, tests, audit, pack
```
