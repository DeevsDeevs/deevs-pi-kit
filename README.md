# deevs-pi-kit

A [Pi](https://github.com/earendil-works/pi) package for work you can walk away from: bounded background jobs, isolated subagents, handoffs that survive a session, and persistent collaborators (Pi, Claude Code or Codex) that mail each other from their own [Herdr](https://herdr.dev) tabs. Pi does the thinking; Herdr owns every process that outlives a turn.

## Requirements

- Pi 1.0.4 or newer and Node 22.19 or newer.
- Herdr, for Runtime collaborators. Everything else works in plain Pi.
- The Claude Code or Codex CLI, only for collaborators on that driver.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit        # every project
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l     # this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit           # later upgrades
```

Run `/reload` in Pi after installing or updating. `pi config` toggles individual extensions and skills.

Extensions use Pi's host-provided packages as peers. The standalone Runtime daemon alone resolves TypeBox through the pinned `runtime-typebox` npm alias, so production-only installs work without shadowing Pi's TypeBox.

The six stand-alone skills listed below also work in Claude Code and Codex: symlink `skills/<name>` from the installed checkout into `~/.agents/skills` for Codex and `~/.claude/skills` for Claude Code.

Chains also ships as a plugin for Claude Code and Codex, reading and writing the same `.chains/` as Pi, with the same 80% checkpoint reminder and post-compaction resume delivered by hooks:

```bash
claude plugin marketplace add DeevsDeevs/deevs-pi-kit && claude plugin install chains@deevs-pi-kit
codex plugin marketplace add DeevsDeevs/deevs-pi-kit && codex plugin add chains@deevs-pi-kit
```

Upgrade with `claude plugin marketplace update deevs-pi-kit` or `codex plugin marketplace upgrade deevs-pi-kit`. The plugin needs Node 22.19 or newer on `PATH`.

## Quickstart: a collaborator

Open Pi inside Herdr in a trusted project and ask:

```text
> Start a read-only Codex collaborator called reviewer on gpt-5.6-terra and ask it to review HEAD.
```

Nothing to set up first. Pi starts the daemon in its own Herdr workspace on the first call, names this project's collaboration and itself, opens the tab with `collaborator_manage` and mails it with `collaborator_send`; the reply lands in your session on its own. Starts, stops and cleanups run without a dialog unless [autonomy](#settings) is `ask`. A `workspace-write` collaborator works in its own worktree on `runtime/collab/<protocol>/<name>`; review and merge that branch with Git, then `collaborator_workspace cleanup`. The daemon's guarantees and limits are in [PROTOCOL.md](extensions/runtime/PROTOCOL.md); what the model is told to do is in [skills/collaborators](skills/collaborators/SKILL.md).

## Extensions

You ask the lead for everything in chat; the kit registers two commands: `/agents` lists background tasks, agent types and models, and stops (`/agents stop <id>`) or opens (`/agents attach <id>`) a task, and `/chains` browses and searches handoffs.

- **runtime** owns collaborator identity, mail and Herdr tab lifecycle. `collaborator_list`, `collaborator_manage`, `collaborator_workspace` and four MCP mail tools. [Protocol](extensions/runtime/PROTOCOL.md).
- **jobs** runs bounded commands with capped output, a hard timeout and process-tree cancellation. `job_start`, `job_read`; `TaskStop` stops a job. A finished job arrives as a `<task-notification>` that starts a turn when Pi is idle. Its guard reads command syntax, including `$(...)` and heredocs, and refuses in `bash` and `job_start`: detached processes, force pushes to `main`, `master`, `release/*` or an unnamed branch and deletes of a protected one, recursive `rm` outside the project, `$TMPDIR` and `/tmp`, and the `guard.block` patterns (`"terraform destroy"` matches `terraform` with `destroy` among its arguments). `extensions/shared/guard-hook.mjs` is the same guard as a Claude Code or Codex PreToolUse hook.
- **subagents** delegates through `Agent`, `SendMessage`, `TaskStop` and `ListAgents`, Claude Code's surface: `general-purpose`, which can edit, and the read-only personas explorer (`Explore`), architect (`Plan`), reviewer, tester, logic-hunter, devops, python-dev, cpp-dev, rust-dev and anti-slop. Agents run in the background on the lead's model and report once as a `<task-notification>`; they run on pi-durable inside Pi, survive `/reload`, pause when Pi exits and continue when their session reopens. At most 16 run at once; the rest queue. `maxTurns`, `maxTokens` and `timeout` exist only when you ask for them. `SendMessage` steers a running agent or resumes a finished one with its context; `isolation: "worktree"` gives a writer its own branch `agent/<id>` outside the repo. `/agents` lists them. [More](extensions/subagents/README.md).
- **cron** schedules prompts for this Pi session, fired while it is idle. `cron`. [More](extensions/cron/README.md).
- **chains** saves markdown handoffs under `.chains/` and reminds once to save one at 80% context. `/chains`, `chain_*`. [More](extensions/chains/README.md).
- **wiki** lints, graphs, searches and packs a curated markdown knowledge base. `wiki_*`. [More](extensions/wiki/README.md).
- **arxiv** searches arXiv and returns exact metadata and BibTeX. `arxiv_*`. [More](extensions/arxiv/README.md).
- **todos** keeps a session todo list. `todo_list`. [More](extensions/todos/README.md).
- **ask-user** asks before an irreversible or destructive choice through an overlay; anything else goes ahead on a stated default. `ask_user`.
- **codex-fast** turns on the OpenAI Codex Fast service tier for ChatGPT-auth requests when `codexFast` is on.
- **notifier** sends a ready-for-input terminal notification, or runs your `notifier.command`, when a turn settles.
- **herdr-compat** treats Shift+Enter as a newline inside Herdr. Experimental.

## Settings

The kit's only settings file is `pi-kit.json`: `~/.pi/agent/pi-kit.json` for every project, and `.pi/pi-kit.json` for one project, which wins key by key. Both are re-read on every use, so an edit applies to the next call with no `/reload`. A file that does not parse, or a value off its schema, is warned about once and skipped; the valid rest still applies. Every key is optional:

```json
{
  "models": { "deep": "astra:max", "sol": "openai-codex/gpt-*-sol" },
  "lead": "sol",
  "autonomy": "auto",
  "guard": { "rmRf": true, "block": ["terraform destroy", "npm publish"] },
  "codexFast": false,
  "notifier": { "bell": false, "command": ["notify-send", "{title}", "{body}"] }
}
```

- `models` and `lead` name models by pattern (`openai-codex/gpt-*-sol` is the newest sol); a project's names add to the global ones. A new session started without `--model` or `--provider` switches to `lead` at your thinking level (`"sol:xhigh"` sets one); restored sessions keep their model, and `"lead": null` turns this off.
- `autonomy`: orchestration never waits on a dialog. `"ask"` brings one confirmation back for each collaborator change; a project's value counts once the project is trusted.
- `guard`: `"detached"`, `"forcePush"` or `"rmRf": false` in the global file turns one rule off; a project file can only add `block` patterns, and both lists add up.
- `codexFast`: `true` sends `service_tier: "priority"` on ChatGPT-auth `openai-codex` requests.
- `notifier`: `enabled`, `title`, `body`, `terminal`, `bell`, `terminalRequiresTty`, `minIntervalMs`, `command` (an argv with `{title}`, `{body}`, `{cwd}`, `{project}`) and `jsonl`; an untrusted project's `command` and `jsonl` are ignored.

A trusted project's old `.pi/codex-fast.json`, `.pi/notifier.json`, `.pi/runtime.json` and `.pi/subagents.json` move into `.pi/pi-kit.json` once, by themselves (`subagents.json` keeps only its `defaultModel`, as `models.default`).

## Skills

Eight skills pair with the extensions above and tell the model when and how to use them: collaborators, background-tasks, subagents, chain-system, todos, wiki, arxiv, ask-user. Six stand alone and also work in Claude Code and Codex: codebase-orientation, concept-diagrams, diagnose, grill-me, validation-review, datadog-pup.

## Development

```bash
npm install
npm run check                        # lint, typecheck, tests, polygon (needs Podman), audit, pack
node extensions/runtime/service/main.ts --help  # verify standalone imports without starting a daemon
npm run smoke:native-release         # interactive targets and Git worktrees, no Herdr
npm run bench:context                # tokens each surface costs, see bench/README.md
npm run sync:chains-plugin           # copy the chain core into plugins/chains after editing it
npm run polygon                      # end-to-end scenarios in a Podman sandbox, see polygon/README.md
```
