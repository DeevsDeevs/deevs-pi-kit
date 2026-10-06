# Subagents

`Agent`, `Workflow`, `SendMessage`, `TaskStop` and `ListAgents`, with Claude Code's names and result labels, on a durable engine inside the lead's Pi.

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
- `TaskStop` stops an agent (by id or name), a workflow (by `w…` task id or `wf_…` run id; no notification follows) or a job; the report says the agent was stopped. `ListAgents` and `/agents` list every task of the session by kind; `/agents` adds the agent types and what each model name resolves to now.

## Workflow

`Workflow({script | scriptPath | name, args?, resumeFromRunId?})` runs a plain JavaScript script in a `node:vm` sandbox inside a durable task and returns at once; the run reports once as a `<task-notification>` with the result (cut at 8,000 chars), the failed agents and usage counters. `name` looks in `.pi/workflows/<name>.js`, then `~/.pi/agent/workflows/<name>.js`.

- `agent(prompt, opts)` starts a Pi agent behind the same throttle of 16 as `Agent`; a failed one returns `null`. There is no cap on calls or items.
- Each agent gets the user's request as it was when the run launched, framed apart from the script's task, so a question asked mid-run never becomes its task.
- Files live under `<agent dir>/pi-kit/workflows/<project hash>/`: `scripts/<name>-<runId>.js`, and per run `journal.jsonl`, `progress.jsonl`, `<runId>.json` and `agent-<agentId>.md`.
- A run interrupted by a Pi exit re-runs its script when the session reopens; every agent that already finished answers from the run's record, so none asks the model twice.
- `resumeFromRunId` with an edited `scriptPath` replays the longest unchanged prefix of `agent()` calls from `journal.jsonl` and runs the rest.
- A widget shows each running workflow; `/agents` lists every agent of a run with its phase, state, tokens and age.

## Engine

`engine/` is the only code that imports pi-durable. Each lead session has a store under `<agent dir>/pi-kit/agents/<project hash>/<session id>/` (`engine.sqlite`, `engine.lock`, `out/<agentId>.md`). Agents run Pi's own `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write` with the kit guard on every `bash`. The engine survives `/reload`; when Pi exits, agents pause, and the next start of their session reaps orphaned tool processes (`PI_KIT_OWNER`), resumes them, and delivers each report once: the session file is the acknowledgement.

## Claude Code and Codex workers

A `claude:` or `codex:` model (`opus`, `sonnet`, `haiku` and `fable` are `claude:` names) runs the agent as `claude -p` or `codex exec` in its own process group, tagged with `PI_KIT_OWNER`, from `engine/cli.ts`. The lead gets the same launch result and notification as for a Pi agent, and `SendMessage` and `TaskStop` work alike.

- Claude: `--permission-mode bypassPermissions --permission-prompts none`, the type's denied tools plus `Agent`, `Workflow`, `AskUserQuestion`, `ScheduleWakeup`, `CronCreate` and `SendUserMessage` in `--disallowedTools`, and the kit guard as a PreToolUse hook through `--settings`. A writer in a Git repository always gets a worktree.
- Codex: `approval_policy=never` and `sandbox_mode=workspace-write` for writers, `read-only` otherwise, passed with `-c` on `exec` and `exec resume` alike. The guard is a PreToolUse hook passed with `-c`; `--dangerously-bypass-hook-trust` lets it run without a stored trust entry.
- The CLI's session id is memoed at its first event. After Pi closed, the next start reaps the old process group and the worker resumes its session (`claude --resume`, `codex exec resume`); a worker that had not started yet starts again.
- `SendMessage` to a running worker waits for its run to end, then resumes it with the message; it notifies once per run.
- `maxTurns`, `maxTokens` and `timeout` apply to Pi models only.
- `test/fixtures/cli/` holds event streams and `--help` texts recorded by the polygon's `claude-worker` and `codex-worker`; a unit test fails when the argv uses a flag the recorded release does not document. Re-record after a CLI update by copying them from `polygon/results/latest/`.

A trusted project's old `.pi/subagents.json` moves into `.pi/pi-kit.json` once, keeping only `defaultModel` as `models.default`.
