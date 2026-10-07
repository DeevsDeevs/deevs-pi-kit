# deevs-pi-kit

A [Pi](https://github.com/earendil-works/pi) package: background agents, workflows, jobs and monitors that survive `/reload` and continue after a Pi restart, long-running Missions, markdown handoffs, and Pi, Claude Code or Codex collaborators in their own [Herdr](https://herdr.dev) tabs.

## Requirements

- Pi 1.0.4 or newer and Node 22.19 or newer.
- Herdr, for collaborators only.
- The Claude Code or Codex CLI, only for `claude:` or `codex:` models.

## Install

```bash
pi install git:github.com/DeevsDeevs/deevs-pi-kit        # every project
pi install git:github.com/DeevsDeevs/deevs-pi-kit -l     # this project only
pi update git:github.com/DeevsDeevs/deevs-pi-kit         # later upgrades
```

Run `/reload` after installing or updating. `pi config` toggles single extensions and skills.

Chains also ships as a Claude Code and Codex plugin over the same `.chains/`, with the same 80% checkpoint reminder (needs Node 22.19+ on `PATH`):

```bash
claude plugin marketplace add DeevsDeevs/deevs-pi-kit && claude plugin install chains@deevs-pi-kit
codex plugin marketplace add DeevsDeevs/deevs-pi-kit && codex plugin add chains@deevs-pi-kit
```

Upgrade with `claude plugin marketplace update deevs-pi-kit` or `codex plugin marketplace upgrade deevs-pi-kit`; the plugin's tool is now one `chain` with an `action`.

## Quickstart

```text
> Have a reviewer agent check HEAD while you fix the failing test.
> Run a workflow: audit every route in src/api, then try to disprove each finding.
> Run the full test suite in the background and tell me when it finishes.
> Watch ./out and tell me when report.json appears.
> Start a Claude Code collaborator called reviewer on opus and ask it to review HEAD.
> Start a mission: move the CLI to the new config format; done when npm test passes.
```

Ask in chat. Collaborators need Pi running inside Herdr in a trusted project; nothing else needs setting up. Agents, workflows and jobs report once as a `<task-notification>`, a monitor once per event; a collaborator's reply arrives as a message that starts a turn. No start, stop or cleanup opens a dialog unless `autonomy` is `false`.

## What each piece does

- **Agents** (`Agent`, `SendMessage`, `TaskStop`, `ListAgents`): Claude Code's surface. An agent runs in the background on the lead's model as one of the agent types (`general-purpose`, `Explore`, `Plan`, reviewer, tester, …) and reports once. `SendMessage` steers a running agent or resumes a finished one; `isolation: "worktree"` gives a writer its own branch. At most 16 run at once; the rest queue. A `claude:` or `codex:` model (`opus`, `sonnet`, `haiku` and `fable` are `claude:`) runs the agent as a Claude Code or Codex worker; a Claude writer in a repository always gets a worktree. [More](extensions/subagents/README.md).
- **Workflow**: a JavaScript script that orchestrates agents with `agent()`, `parallel()` and `pipeline()` on the same throttle, `claude:` and `codex:` models included; `resumeFromRunId` replays the unchanged agents of an edited script. [skills/workflow-authoring](skills/workflow-authoring/SKILL.md).
- **Jobs and monitors** (`job_start`, `Monitor`): `job_start` runs a bounded command and reports its exit code; `Monitor` reports each new line of a command (rate limited), change in a folder or at a URL, or cron fire. Servers, REPLs and anything that must run while Pi is closed belong in Herdr.
- **Durability**: agents, workflows and monitors survive `/reload`, `/new` and `/resume`, pause when Pi exits and continue when their session reopens; a monitor reports what changed meanwhile. A job that was running is killed with Pi and reported once as interrupted.
- **Mission** (`mission_start`, `mission_update`, `mission_get`): one long goal under `.missions/<slug>/`. While it is active the lead's prompt carries the goal and next step, and the lead is told to continue whenever it settles with nothing of its session running (monitors and collaborators wake it themselves); three continues without progress pause it. With `review: true`, done first runs a read-only closing-review Workflow, at most two rounds. Ask the lead to pause, resume or end it.
- **Collaborators** (`collaborator_start`, `collaborator_workspace`, `SendMessage`, `ListAgents`, `TaskStop`): persistent Pi, Claude Code or Codex peers, each in its own Herdr tab and, for writers, its own worktree on `runtime/collab/<protocol>/<name>`. `TaskStop` stands one down and its next message resumes it; their mail waits while the lead is closed. [Protocol](extensions/runtime/PROTOCOL.md), [skill](skills/collaborators/SKILL.md).
- **Guard**: in the lead's and every agent's `bash`, `job_start` and `Monitor`, refuses detached processes, force pushes to `main`, `master`, `release/*` or an unnamed branch, recursive `rm` outside the project and temp dirs, and your `guard.block` patterns. `extensions/shared/guard-hook.mjs` is the same guard as a Claude Code or Codex PreToolUse hook.
- **Chains** (`chain`, `/chains`): markdown handoffs under `.chains/`, with one save reminder at 80% context. [More](extensions/chains/README.md).
- **Smaller tools**: `wiki` for curated markdown wikis ([more](extensions/wiki/README.md)) and `arxiv` for arXiv search and BibTeX ([more](extensions/arxiv/README.md)), each offered once its skill loads; `todo_list` ([more](extensions/todos/README.md)), `ask_user` before irreversible choices, a ready-for-input notifier, the Codex Fast tier (`codexFast`), and Shift+Enter as a newline inside Herdr.

Two commands: `/agents` shows tasks, collaborators, the Mission, agent types and models (`/agents stop <id>` stops a task or pauses the Mission); `/chains [query]` browses and searches handoffs.

## pi-kit.json

The only settings file: `~/.pi/agent/pi-kit.json` for every project, `.pi/pi-kit.json` for one project, which wins key by key. Both are re-read on every use, so an edit applies without `/reload`. An unparsable file or an off-schema value is warned about once and skipped. Every key is optional:

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

- `models`: names for models or patterns (`*` stands for a version, the newest wins), each with an optional `:level`; `a|b` takes the first that resolves, and a trailing `:level` applies to every alternative. Built in: `sol`, `astra`, `luna` and `terra` (the newest OpenAI GPT of that name, on your ChatGPT login under `openai`, else the legacy `openai-codex`) and `opus`, `sonnet`, `haiku` and `fable` (Claude Code workers). An `openai` login through `OPENAI_API_KEY` also matches, and bills the API. A trusted project's names add to the global ones.
- `lead`: the model a new session switches to when started without `--model` or `--provider` (`"sol:xhigh"` sets the level too); `null` turns this off. Restored sessions keep their model. An untrusted project's `models` and `lead` are ignored.
- `autonomy` (default `true`): orchestration never waits on a dialog, and the lead takes it as standing permission to run workflows. `false` asks before each collaborator change and stops Mission continues. A project's value counts only once the project is trusted.
- `guard`: in the global file, `"detached"`, `"forcePush"` or `"rmRf": false` turns a rule off; a project file can only add `block` patterns, and the patterns from both files add up (`"terraform destroy"` matches `terraform` with `destroy` among its arguments).
- `codexFast`: sends `service_tier: "priority"` on requests made with your ChatGPT login, under `openai` or the legacy `openai-codex`; never with an API key. A project's value counts only once the project is trusted.
- `notifier`: `enabled`, `title`, `body`, `terminal`, `bell`, `terminalRequiresTty`, `minIntervalMs`, `command` (an argv with `{title}`, `{body}`, `{cwd}`, `{project}`, killed if it runs past 10 s) and `jsonl`; an untrusted project's `command` and `jsonl` are ignored.

A trusted project's old `.pi/codex-fast.json`, `.pi/notifier.json`, `.pi/runtime.json` and `.pi/subagents.json` move into `.pi/pi-kit.json` once at session start, and an old `"autonomy": "auto"` or `"ask"` becomes `true` or `false`.

## Skills

Eight skills tell the model when and how to use the tools above: collaborators, background-tasks, workflow-authoring, chain-system, todos, wiki, arxiv, ask-user. Six stand alone: codebase-orientation, concept-diagrams, diagnose, grill-me, validation-review, datadog-pup; symlink `skills/<name>` from the installed checkout into `~/.claude/skills` for Claude Code or `~/.agents/skills` for Codex.

## Polygon

`npm run check` runs the polygon: end-to-end scenarios with the real Pi, Claude Code, Codex and Herdr binaries in a rootless Podman container, driven by a scripted model and asserting on events, tool calls, files and processes. See [polygon/README.md](polygon/README.md).

## Development

```bash
npm install
npm run check                 # lint, typecheck, tests, polygon (needs Podman), audit, pack
npm run polygon -- --only modes
npm run bench:context         # tokens each surface costs, see bench/README.md
npm run sync:chains-plugin    # copy the chain core into plugins/chains after editing it
npm run smoke:native-release  # the runtime bridge, participant and worktree tests
```
