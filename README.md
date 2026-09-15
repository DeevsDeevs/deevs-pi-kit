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

The driver-agnostic skills (`grill-me`, `diagnose`, `codebase-orientation`, `validation-review`, `concept-diagrams`, `datadog-pup`) also work in Claude Code and Codex: symlink `skills/<name>` from the installed checkout into `~/.agents/skills` for Codex and `~/.claude/skills` for Claude Code.

## Quickstart: a collaborator

```text
/runtime start                     # the daemon, in its own Herdr workspace
/runtime collaborate demo lead     # your name in this project's collaboration
/runtime auto on                   # optional: no confirmation dialogs
> Start a read-only Codex collaborator called reviewer on gpt-5.6-terra and ask it to review HEAD.
```

Pi opens the tab with `collaborator_manage`, mails it with `collaborator_send`, and the reply lands in your session on its own. A `workspace-write` collaborator works in its own worktree on `runtime/collab/demo/<name>`; review and merge that branch with Git, then `collaborator_workspace cleanup`. The daemon's guarantees and limits are in [PROTOCOL.md](extensions/runtime/PROTOCOL.md); what the model is told to do is in [skills/collaborators](skills/collaborators/SKILL.md).

## Extensions

| Extension | Does | Tools and commands | More |
|---|---|---|---|
| runtime | Daemon owning collaborator identity, mail and Herdr tab lifecycle | `collaborator_list`, `collaborator_manage`, `collaborator_workspace`, four MCP mail tools; `/runtime status\|start\|register\|collaborate\|participants\|stand-down\|leave\|takeover\|auto` | [PROTOCOL](extensions/runtime/PROTOCOL.md) |
| jobs | Bounded non-interactive commands: capped output, hard timeout, process-tree cancellation | `job_start`, `job_wait`, `job_read`, `job_stop`; `/jobs` | |
| subagents | Curated read-only personas (explorer, architect, reviewer, tester, logic-hunter, devops, python-dev, cpp-dev, rust-dev, anti-slop) in isolated Pi processes; writing needs `allowWrite` and your confirmation | `subagent`, `subagent_wait`; `/agents` | [README](extensions/subagents/README.md) |
| workflow | Foreground JavaScript that fans work out to read-only child agents, trusted projects only | `workflow` | |
| mission | Single-controller autonomous objectives with limits, reviewed candidates and confirmed takeover; state under `.missions/` | `mission_*`; `/mission` | [README](extensions/mission/README.md) |
| cron | Five-field schedules for this Pi session, fired while it is idle | `cron`; `/cron` | [README](extensions/cron/README.md) |
| chains | Markdown handoffs under `.chains/`; a checkpoint is forced at 80% context | `chain_*`; `/chains`, `/chain-link`, `/chain-load`, `/chain-fork`, `/chain-list`, `/chain-search`, `/chain-waive` | [README](extensions/chains/README.md) |
| wiki | Curated markdown knowledge base: lint, graph, search, context packing | `wiki_*`; `/wiki:*` | [README](extensions/wiki/README.md) |
| arxiv | arXiv search, exact metadata, BibTeX | `arxiv_*`; `/arxiv:*` | [README](extensions/arxiv/README.md) |
| todos | Session todo list | `todo_list`; `/todos` | [README](extensions/todos/README.md) |
| ask-user | Clarification overlay, used after files and docs have been checked | `ask_user` | |
| codex-fast | OpenAI Codex Fast service tier on ChatGPT-auth requests | `/codex-fast`; `.pi/codex-fast.json` | |
| notifier | Ready-for-input terminal notification | `/notifier:test`, `/notifier:settings`; `.pi/notifier.json` | |
| herdr-compat | Shift+Enter as newline inside Herdr (experimental) | | |

## Skills

| Skill | Fires when |
|---|---|
| collaborators | Starting, mailing, inspecting or stopping collaborators |
| background-tasks | Choosing between a Job, session Cron and a Herdr-owned process |
| subagents | Delegating exploration, review, testing or a language-specific pass |
| missions | Creating, continuing or taking over an autonomous objective |
| chain-system | Saving, loading or searching handoffs across sessions |
| todos | Tracking multi-step work in the current session |
| wiki | Building or querying a curated markdown wiki |
| arxiv | Finding, triaging or citing papers |
| ask-user | A clarification would change scope, safety or acceptance |
| codebase-orientation | Mapping an unfamiliar area before editing |
| concept-diagrams | A source-grounded diagram would explain more than prose |
| diagnose | Debugging a failure, flake, hang or regression to its root cause |
| grill-me | Pressure-testing a plan, design or scope one question at a time |
| validation-review | Verifying or reviewing a change before merge |
| datadog-pup | Operating Datadog through the pup CLI |

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
