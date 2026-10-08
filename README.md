# deevs-pi-kit

I wanted Claude Code's background agents and workflows in [Pi](https://github.com/earendil-works/pi), on any model Pi runs, surviving a Pi restart. I also wanted real Claude Code and Codex sessions as peers, each in its own [Herdr](https://herdr.dev) tab, mailing my Pi back. This package does that, plus background jobs, monitors, missions and markdown handoffs. I drive it with gpt-6.1-sol daily and bench it on Opus too, so it's tuned for both.

![Benchmark scoreboard: Pi + kit vs plain Pi, Claude Code and Codex](bench/scoreboard.svg)

On Opus the kit solves 7 more than Claude Code (5 before the audit voided 2 of CC's web-lookup passes; p=0.14 at k=1) for 28% less money. Vs plain Pi it's +3, which is noise.

On Sol the kit I benched lost by 2 and spent 2.8x what plain Pi did; it kept starting workflows and background jobs. I stopped that, and on a 40-task A/B Sol spend dropped 36%. No full Sol re-run yet, so no Sol win claimed. Setup: [bench/README.md](bench/README.md); the plain-Pi agent and DeepSWE runner aren't in this repo yet.

## What you get

| Tool | What it does |
|---|---|
| `Agent` | Claude Code's agent tool: types (`Explore`, `Plan`, reviewer, tester, ...), worktrees, 16 at once |
| `Workflow` | a JS script of `agent()`, `parallel()` and `pipeline()`; edit it and resume the run |
| `job_start` | a bounded background command that reports its exit code |
| `Monitor` | reports output lines, folder or URL changes, cron fires |
| `mission_start` | one long goal the lead keeps at whenever it goes idle |
| `collaborator_start` | Pi, Claude Code or Codex peers in Herdr tabs, writers in their own worktree |
| `chain` | markdown handoffs in `.chains/`, with a save reminder at 80% context |

Tasks report back on their own and collaborator mail starts a turn. Agents, workflows and monitors survive `/reload` and a Pi restart; a running job doesn't. `claude:` and `codex:` models run agents as real Claude Code or Codex workers. Heads-up: a Claude Code collaborator edits your `~/.claude.json`.

A guard on every `bash`, job and monitor blocks detached processes, force pushes to `main` and recursive `rm` outside the project.

Also: `wiki`, `arxiv`, `todo_list`, `ask_user`, fourteen skills, `/agents` and `/chains`, and one optional settings file, `pi-kit.json`. Outside Pi, chains ships as a Claude Code and Codex plugin and the guard as a hook for both.

Each tool in detail, `pi-kit.json`, upgrade notes and plugin installs: [docs/reference.md](docs/reference.md).

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit    # add -l for this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit     # upgrade; read the upgrade notes first
```

Then `/reload`. Needs Pi 1.0.4+, Node 22.19+ and Linux for full cleanup; Herdr only for collaborators; Claude Code 2.1.292+ or Codex 0.160.1+ only for `claude:` / `codex:` models. The one real dependency, `@earendil-works/pi-durable` (about 90 packages, 125 MB), keeps agents alive across restarts.

## Quickstart

```text
> Have a reviewer agent check HEAD while you fix the failing test.
> Run a workflow: audit every route in src/api, then try to disprove each finding.
> Run the full test suite in the background and tell me when it finishes.
> Watch ./out and tell me when report.json appears.
> Start a Claude Code collaborator called reviewer on opus and ask it to review HEAD.
> Start a mission: move the CLI to the new config format; done when npm test passes.
```

Just ask in chat. Collaborators need Pi inside Herdr in a trusted project.

## Development

```bash
npm install
npm run check    # lint, typecheck, tests, polygon (needs Podman), audit, pack
```

The [polygon](polygon/README.md) runs the real Pi, Claude Code, Codex and Herdr against a scripted model.
