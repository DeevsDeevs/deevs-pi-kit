# Reference

Everything the [README](../README.md) skips: what each tool does, the two commands, `pi-kit.json`, upgrade notes and the skills.

## Requirements

- Pi 1.1.0+ and Node 22.19+.
- Linux for cleanup: leftover processes are reaped through `/proc`, so on macOS a worker's commands can outlive a stop.
- Herdr for collaborators (the polygon tests 0.9.0); inside it Shift+Enter is a newline. Collaborators need Pi inside Herdr in a trusted project.
- Claude Code 2.1.292+ or Codex 0.160.1+, only for `claude:` / `codex:` models and collaborators.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit        # every project
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l     # this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit         # upgrade
```

Then `/reload`; `pi config` toggles single extensions and skills. The one real dependency, `@earendil-works/pi-durable`, keeps agents alive across restarts and brings its own `pi-ai`, provider SDKs and esbuild: about 90 packages, 125 MB.

### Upgrade notes

- An update that bumps pi-durable needs a full Pi restart; `/reload` keeps the old engine.
- `engine.sqlite` migrates forward only: after a pi-durable downgrade that session's agents don't resume. Either way, let running work end before such an update.
- Nothing reads `~/.pi/agent/subagents` any more; delete it.
- Coming from a kit before `service.exit`, collaborator starts fail with a conflict until you close the `pi-kit-services` Herdr workspace once.

### Chains plugin for Claude Code and Codex

Chains also ships as a Claude Code and Codex plugin over the same `.chains/`, with the same 80% reminder (needs Node 22.19+ on `PATH`):

```bash
claude plugin marketplace add DeevsDeevs/deevs-pi-kit && claude plugin install chains@deevs-pi-kit
codex plugin marketplace add DeevsDeevs/deevs-pi-kit && codex plugin add chains@deevs-pi-kit
```

Upgrade with `claude plugin marketplace update deevs-pi-kit && claude plugin update chains@deevs-pi-kit` plus a Claude Code restart, or `codex plugin marketplace upgrade deevs-pi-kit`. Coming from an older plugin: its tools merged into one `chain` tool with an `action`.

## Tools

### Agent

`Agent`, `SendMessage`, `TaskStop`, `ListAgents`: Claude Code's agent surface, with agent types (`Explore`, `Plan`, reviewer, tester, ...), worktree isolation and 16 at once. A `claude:` or `codex:` model runs the agent as a Claude Code or Codex worker. [More](../extensions/subagents/README.md).

### Workflow

`Workflow`: a JavaScript script of `agent()`, `parallel()` and `pipeline()`, inline or saved in `.pi/workflows/` or `~/.pi/agent/workflows/`. `resumeFromRunId` replays an edited script's unchanged prefix. [Authoring](../skills/workflow-authoring/SKILL.md).

### Jobs and monitors

- `job_start`: a bounded command in the background that reports its exit code.
- `Monitor`: reports output lines, folder or URL changes, or cron fires.

Servers and REPLs go in Herdr.

### Missions

`mission_start`, `mission_update`, `mission_get`: one long goal under `.missions/<slug>/`. The lead keeps going whenever it idles with no agent, workflow or job running, three continues without progress pause it, and `review: true` adds a closing review.

### Collaborators

`collaborator_start`, `collaborator_workspace`: persistent peers in Herdr tabs, writers in their own worktree, mail through `SendMessage`. Heads-up: a Claude Code collaborator edits your `~/.claude.json` (accepts bypass permissions, copies the repo's folder trust to its worktree). [Protocol](../extensions/runtime/PROTOCOL.md), [skill](../skills/collaborators/SKILL.md).

### Chains

`chain`: markdown handoffs under `.chains/`, with a save reminder at 80% context. [More](../extensions/chains/README.md).

### Extras

- `wiki`, `arxiv`: appear once their skill loads ([wiki](../extensions/wiki/README.md), [arxiv](../extensions/arxiv/README.md)).
- `todo_list`: a session todo widget. [More](../extensions/todos/README.md).
- `ask_user`: asks before irreversible choices.

### Reporting and restarts

Tasks report back on their own and collaborator mail starts a turn. Agents, workflows and monitors survive `/reload` and a Pi restart, a running job doesn't. [Details](../extensions/subagents/README.md).

### Print mode

`pi -p` has no `ask_user` or collaborator tools and, like `claude -p`, waits for running agents, workflows and timed jobs to report, then exits.

### Working rules

The lead gets ~310 tokens of working rules (finish and verify in the turn, smallest change, test in the project's own env); Pi agents get the smallest-change and test rules. Your instructions win.

### Guard

The guard, in every `bash`, `job_start` and `Monitor`, blocks detached processes, force pushes to `main`, `master`, `release/*` or an unnamed branch, recursive `rm` outside the project and temp dirs, your `guard.block` patterns, and a `bash` that starts with a `sleep` of 60 s or more. [`extensions/shared/guard-hook.mjs`](../extensions/shared/guard-hook.mjs) is the same guard as a hook; the kit wires it into the Claude Code and Codex workers and collaborators it starts.

## Commands

| Command | What it does |
|---|---|
| `/agents` | tasks, collaborators, the mission, agent types and what each model name resolves to |
| `/agents <id>` | tails a running Pi agent |
| `/agents stop <id>` | stops a task or pauses the mission |
| `/chains [query]` | browse and search handoffs |

## pi-kit.json

Global `~/.pi/agent/pi-kit.json`, per-project `.pi/pi-kit.json` (wins key by key), re-read on every use. An unparsable file is skipped, an off-schema value keeps its valid fields, and both warn once. Every key is optional:

```json
{
  "models": { "deep": "astra:max", "mine": "openai/gpt-*-sol|openai-codex/gpt-*-sol:xhigh" },
  "lead": "sol",
  "autonomy": true,
  "guard": { "rmRf": true, "block": ["terraform destroy", "npm publish"] },
  "codexFast": false,
  "notifier": { "bell": false, "command": ["notify-send", "{title}", "{body}"] }
}
```

- `models`: names for models. `*` is a version (newest wins), `:level` sets thinking, `a|b` takes the first that resolves. Built in: `default` (`inherit`: the lead's model and level, run by anything started without a model), `sol`, `astra`, `luna`, `terra` (newest GPT of that name, ChatGPT login before API key), `opus`, `sonnet`, `haiku`, `fable` (Claude Code workers). A trusted project's names add to the global ones.
- `lead`: what a new session switches to without `--model` or `--provider`; `null` keeps Pi's pick. Unset, it's `sol` on a ChatGPT login only. One you set warns once if it doesn't resolve.
- `autonomy` (default `true`): no dialogs, and the lead may start workflows unasked, though it still works directly by default. `false` brings back collaborator dialogs, stops mission continues, and runs workflows only on request.
- `guard`: the global file can turn off `detached`, `forcePush` or `rmRf`; both files can add `block` patterns.
- `codexFast`: `service_tier: "priority"` on the lead's own ChatGPT-login requests, not agents', never with an API key.
- `notifier`: ready-for-input alerts. `enabled`, `title`, `body`, `terminal`, `bell`, `terminalRequiresTty`, `minIntervalMs`, `command` (argv with `{title}`, `{body}`, `{cwd}`, `{project}`, killed after 10 s), `jsonl`. An untrusted project gets no `command` or `jsonl`, not even the global ones.

An untrusted project's `models`, `lead`, `autonomy` and `codexFast` are ignored. A trusted project's old `.pi/codex-fast.json`, `notifier.json`, `runtime.json` and `subagents.json` move into `.pi/pi-kit.json` once (`defaultModel` becomes `models.default`), and an old `"autonomy": "auto"` or `"ask"` becomes `true` or `false`.

## Skills

| Kind | Skills |
|---|---|
| Teach the model the tools | collaborators, background-tasks, workflow-authoring, chain-system, todos, wiki, arxiv, ask-user |
| Stand alone | codebase-orientation, concept-diagrams, diagnose, grill-me, validation-review, datadog-pup |

For Claude Code or Codex, symlink `skills/<name>` from the installed checkout into `~/.claude/skills` or `~/.agents/skills`.

## Development

```bash
npm install
npm run check                 # lint, typecheck, tests, polygon (needs Podman), audit, pack
npm run polygon -- --only modes
npm run bench:context         # tokens each surface costs
npm run sync:chains-plugin    # after editing the chain core
npm run smoke:native-release  # runtime bridge, participant and worktree tests
```

The polygon runs the real Pi, Claude Code, Codex and Herdr against a scripted model in rootless Podman. See [polygon/README.md](../polygon/README.md).
