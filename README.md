# deevs-pi-kit

A [Pi](https://github.com/earendil-works/pi) package for work you can walk away from: bounded background jobs, isolated subagents, autonomous missions, handoffs that survive a session, and persistent collaborators (Pi, Claude Code or Codex) that mail each other from their own [Herdr](https://herdr.dev) tabs. Pi does the thinking; Herdr owns every process that outlives a turn.

## Requirements

- Pi 0.82 or newer and Node 22.19 or newer.
- Herdr, for Runtime collaborators. Everything else works in plain Pi.
- The Claude Code or Codex CLI, only for collaborators on that driver.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit        # every project
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l     # this project only
pi update                                                # later upgrades
```

Run `/reload` in Pi after installing or updating. `pi config` toggles individual extensions and skills.

The six stand-alone skills listed below also work in Claude Code and Codex: symlink `skills/<name>` from the installed checkout into `~/.agents/skills` for Codex and `~/.claude/skills` for Claude Code.

## Quickstart: a collaborator

Open Pi inside Herdr in a trusted project and ask:

```text
> Start a read-only Codex collaborator called reviewer on gpt-5.6-terra and ask it to review HEAD.
```

Nothing to set up first. Pi starts the daemon in its own Herdr workspace on the first call, names this project's collaboration and itself, opens the tab with `collaborator_manage` and mails it with `collaborator_send`; the reply lands in your session on its own. Each start, stop and cleanup shows one confirmation dialog until you run `/runtime auto on`, which is remembered for the project in `.pi/runtime.json`. A `workspace-write` collaborator works in its own worktree on `runtime/collab/<protocol>/<name>`; review and merge that branch with Git, then `collaborator_workspace cleanup`. The daemon's guarantees and limits are in [PROTOCOL.md](extensions/runtime/PROTOCOL.md); what the model is told to do is in [skills/collaborators](skills/collaborators/SKILL.md).

## Extensions

- **runtime** owns collaborator identity, mail and Herdr tab lifecycle. `/runtime`, `collaborator_list`, `collaborator_manage`, `collaborator_workspace` and four MCP mail tools. [Protocol](extensions/runtime/PROTOCOL.md).
- **jobs** runs bounded commands with capped output, a hard timeout and process-tree cancellation. `/jobs`, `job_start`, `job_wait`, `job_read`, `job_stop`.
- **subagents** runs curated read-only personas in isolated Pi processes: explorer, architect, reviewer, tester, logic-hunter, devops, python-dev, cpp-dev, rust-dev, anti-slop. Writing needs `allowWrite` and your confirmation. `/agents`, `subagent`, `subagent_wait`. [More](extensions/subagents/README.md).
- **workflow** runs foreground JavaScript that fans work out to read-only child agents, in trusted projects only. `workflow`.
- **mission** drives a single-controller autonomous objective with limits, reviewed candidates and confirmed takeover, state under `.missions/`. `/mission`, `mission_*`. [More](extensions/mission/README.md).
- **cron** schedules prompts for this Pi session, fired while it is idle. `/cron`, `cron`. [More](extensions/cron/README.md).
- **chains** saves markdown handoffs under `.chains/` and forces a checkpoint at 80% context. `/chains`, `/chain-*`, `chain_*`. [More](extensions/chains/README.md).
- **wiki** lints, graphs, searches and packs a curated markdown knowledge base. `/wiki:*`, `wiki_*`. [More](extensions/wiki/README.md).
- **arxiv** searches arXiv and returns exact metadata and BibTeX. `/arxiv:*`, `arxiv_*`. [More](extensions/arxiv/README.md).
- **todos** keeps a session todo list. `/todos`, `todo_list`. [More](extensions/todos/README.md).
- **ask-user** asks a clarification through an overlay, after files and docs have been checked. `ask_user`.
- **codex-fast** turns on the OpenAI Codex Fast service tier for ChatGPT-auth requests. `/codex-fast`, `.pi/codex-fast.json`.
- **notifier** sends a ready-for-input terminal notification. `/notifier:test`, `/notifier:settings`, `.pi/notifier.json`.
- **herdr-compat** treats Shift+Enter as a newline inside Herdr. Experimental.

## Skills

Nine skills pair with the extensions above and tell the model when and how to use them: collaborators, background-tasks, subagents, missions, chain-system, todos, wiki, arxiv, ask-user. Six stand alone and also work in Claude Code and Codex: codebase-orientation, concept-diagrams, diagnose, grill-me, validation-review, datadog-pup.

## Development

```bash
npm install
npm run check                        # lint, typecheck, tests, mode smokes, audit, pack
npm run smoke:runtime-release        # daemon, participant, mail and MCP against real Herdr
npm run smoke:collaborator-release   # collaborator launch, mail, stop and worktree
npm run smoke:native-release         # interactive targets and Git worktrees, no Herdr
npm run bench:context                # tokens each surface costs, see bench/README.md
```

The release smokes start real Herdr and Pi processes, so `check` leaves them out.
