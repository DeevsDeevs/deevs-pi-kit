# Reference

Everything the [README](../README.md) skips: what each tool does, the command, `pi-kit.json`, upgrade notes and the skills.

## Requirements

- Pi 1.4.0+ and Node 22.19+.
- Linux for cleanup: leftover processes of an agent's `bash` are reaped through `/proc`, so on macOS they can outlive a stop.

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
- Jobs, monitors, Claude Code and Codex workers, chains, missions, collaborators, the guard, `wiki`, `arxiv` and the notifier are gone. A session store that still holds a running job, monitor or CLI worker may not resume; let such work end first, or delete that session's store under `~/.pi/agent/pi-kit/agents/`.

## Tools

### Agent

`Agent`, `SendMessage`, `TaskStop`, `ListAgents`: Claude Code's agent surface, with agent types (`Explore`, `Plan`, reviewer, tester, ...), worktree isolation and 16 at once. Agents run Pi models and Pi's own tools. [More](../extensions/subagents/README.md).

### Workflow

`Workflow`: a JavaScript script of `agent()`, `parallel()` and `pipeline()`, inline or saved in `.pi/workflows/` or `~/.pi/agent/workflows/`. `resumeFromRunId` replays an edited script's unchanged prefix. [Authoring](../skills/workflow-authoring/SKILL.md).

### Extras

- `todo_list`: a session todo widget. [More](../extensions/todos/README.md).
- `ask_user`: asks before irreversible choices.
- `codex-fast`: `service_tier: "priority"` on the lead's ChatGPT-login requests when `codexFast` is on.
- `chains`: at session start, the chains skill's `list --max 5` (chains newest first, each latest link's title, age and next step) for the session's folder goes into the system prompt; nothing when the folder has no chains or the skill isn't installed. At the end of a run, if the skill's `remind` says the session is due (30 minutes with no link saved, once per session), it adds a visible `[chains reminder]` message and continues once. No tools.
- `hc`: inside an hc terminal (`HC_TERMINAL_ID` set), one line in the system prompt points the lead at the `hc` skill. No tools.

### Reporting and restarts

Tasks report back on their own. Agents and workflows survive `/reload` and a Pi restart. [Details](../extensions/subagents/README.md).

### Print mode

`pi -p` has no `ask_user` and, like `claude -p`, waits for running agents and workflows to report, then exits.

### Working rules

The lead gets ~310 tokens of working rules (finish and verify in the turn, smallest change, test in the project's own env); agents get the smallest-change and test rules. Your instructions win.

## Commands

| Command | What it does |
|---|---|
| `/agents` | tasks, agent types and what each model name resolves to |
| `/agents <id>` | tails a running agent |
| `/agents stop <id>` | stops a task |

## pi-kit.json

Global `~/.pi/agent/pi-kit.json`, per-project `.pi/pi-kit.json` (wins key by key), re-read on every use. An unparsable file is skipped, an off-schema value keeps its valid fields, and both warn once. Every key is optional:

```json
{
  "models": { "deep": "astra:max", "mine": "openai/gpt-*-sol|openai-codex/gpt-*-sol:xhigh" },
  "lead": "sol",
  "autonomy": true,
  "codexFast": false
}
```

- `models`: names for models. `*` is a version (newest wins), `:level` sets thinking, `a|b` takes the first that resolves. Built in: `default` (`inherit`: the lead's model and level, run by anything started without a model), `sol`, `astra`, `luna`, `terra` (newest GPT of that name, ChatGPT login before API key). A trusted project's names add to the global ones.
- `lead`: what a new session switches to without `--model` or `--provider`; `null` keeps Pi's pick. Unset, it's `sol` on a ChatGPT login only. One you set warns once if it doesn't resolve.
- `autonomy` (default `true`): the lead may start workflows unasked, though it still works directly by default. `false` runs workflows only on request.
- `codexFast`: `service_tier: "priority"` on the lead's own ChatGPT-login requests, not agents', never with an API key.

An untrusted project's `models`, `lead`, `autonomy` and `codexFast` are ignored. A trusted project's old `.pi/codex-fast.json`, `runtime.json` and `subagents.json` move into `.pi/pi-kit.json` once (`defaultModel` becomes `models.default`), and an old `"autonomy": "auto"` or `"ask"` becomes `true` or `false`.

## Skills

`workflow-authoring`, `todos` and `ask-user` teach the lead the kit's tools; agents don't get them.

## Development

```bash
npm install
npm run check    # typecheck, tests, audit, pack
```
