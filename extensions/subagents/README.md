# Subagents

`Agent`, `SendMessage`, `TaskStop`, `ListAgents` and `job_start`, with Claude Code's names and result labels, on a durable engine inside the lead's Pi.

## Agent types

```text
general-purpose  research, search and multi-step work, edits included
explorer         targeted code/context reconnaissance (Explore)
architect        design and migration planning (Plan)
reviewer         correctness, security, and regression review
tester           validation strategy and coverage gaps
logic-hunter     spec-vs-implementation logic bug hunting
devops           runtime, config, and deployment investigation
python-dev       Python-specific review
cpp-dev          C++ correctness and performance review
rust-dev         Rust correctness and idioms
anti-slop        simplify overbuilt or noisy changes
```

Personas are `agents/*.md` with Claude Code's frontmatter (`name, description, tools, model, effort, isolation`). They are read-only: every Pi tool but `edit` and `write`. Type names match ignoring case, `-`, `_` and spaces.

## Behaviour

- `Agent` runs in the background by default and reports once as a `<task-notification>`; `run_in_background: false` waits up to two minutes, then the agent continues in the background.
- With no `model`, an agent runs the lead's model and thinking level; names come from `pi-kit.json` (`extensions/shared/models.ts`).
- At most 16 agents run at once across the process; later ones queue and say so in their launch result.
- `maxTurns`, `maxTokens` and `timeout` exist only when the user asks for them, and show in the launch result and the report.
- `SendMessage` to a running agent arrives at its next tool round; to one that finished, failed or was stopped by `TaskStop`, it resumes the agent under the same `agentId`, with its context, and the agent notifies again. An agent stopped with `/agents stop` is not resumed. A name addresses its latest agent.
- `isolation: "worktree"` runs the agent in a worktree under `<agent dir>/pi-kit/worktrees/` on branch `agent/<agentId>`. A worktree with changes is kept and its path and branch reach the report; an unchanged one is removed with its branch.
- `TaskStop` stops an agent (by id or name) or a job; the report says it was stopped. `ListAgents` and `/agents` list every task of the session by kind; `/agents` adds the agent types and what each model name resolves to now.

## Engine

`engine/` is the only code that imports pi-durable. Each lead session has a store under `<agent dir>/pi-kit/agents/<project hash>/<session id>/` (`engine.sqlite`, `engine.lock`, `out/<agentId>.md`). Agents run Pi's own `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write` with the kit guard on every `bash`. The engine survives `/reload`; when Pi exits, agents pause, and the next start of their session reaps orphaned tool processes (`PI_KIT_OWNER`), resumes them, and delivers each report once: the session file is the acknowledgement.

## Jobs

Jobs are tasks in the same store (`engine/background.ts`), with ids `b` plus 8 characters and their output in `out/<id>.log`.

- `job_start` runs `bash -c <command>` in its own process group tagged `PI_KIT_OWNER`; stdout and stderr go to the log (the first 10 MB). The exit code and the report are committed together. `/reload` keeps the process. When Pi exits, the reaper kills the group, and the next start reports the job once as `failed`, "interrupted when Pi closed", with the log so far; nothing re-runs.

A trusted project's old `.pi/subagents.json` moves into `.pi/pi-kit.json` once, keeping only `defaultModel` as `models.default`.
