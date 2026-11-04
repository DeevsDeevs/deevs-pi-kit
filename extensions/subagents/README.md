# Subagents

`Agent`, `Workflow`, `SendMessage`, `TaskStop` and `ListAgents`, with Claude Code's names and result labels, on a durable engine inside the lead's Pi. Agents and workflows run Pi models only.

## Agent types

```text
general-purpose  research, search and multi-step work, edits included
explorer         targeted code/context reconnaissance
architect        design and migration planning
reviewer         correctness, security, and regression review
tester           validation strategy and coverage gaps
logic-hunter     spec-vs-implementation logic bug hunting
devops           runtime, config, and deployment investigation
python-dev       Python-specific review
cpp-dev          C++ correctness and performance review
rust-dev         Rust correctness and idioms
anti-slop        simplify overbuilt or noisy changes
```

Personas are `agents/*.md` with Claude Code's frontmatter (`name`, `description`, `tools`, `model`, `effort`, `isolation`). Without `tools` a persona gets `read`, `grep`, `find`, `ls` and `bash`: no `edit` or `write`. Type names match ignoring case, `-`, `_` and spaces; `Explore` is `explorer` and `Plan` is `architect`.

## Behaviour

- `Agent` runs in the background by default and reports once as a `<task-notification>`; `run_in_background: false` waits up to two minutes, then the agent continues in the background.
- With no `model`, here or in its persona, an agent runs `models.default`, which is `inherit` (the lead's model and thinking level) unless you set it. Names come from `pi-kit.json` (`extensions/shared/models.ts`).
- At most 16 agents run at once across the process; later ones queue and say so in their launch result. After a restart, runs that were mid-way keep their slots ahead of the queue.
- `maxTurns`, `maxTokens` and `timeout` exist only when the user asks for them, and show in the launch result and the report.
- `SendMessage` to a running agent arrives at its next tool round, to one still waiting for a slot right after its prompt (kept in its record across a restart); to one that finished, failed or was stopped by `TaskStop`, it resumes the agent under the same `agentId`, with its context, and the agent notifies again. An agent stopped with `/agents stop` is not resumed. A name addresses its latest agent.
- `isolation: "worktree"` runs the agent in a worktree under `<agent dir>/pi-kit/worktrees/` on branch `agent/<agentId>`. A worktree with changes is kept and its path and branch reach the report; an unchanged one is removed with its branch.
- In print mode (`pi -p`, `--mode json`) Pi waits, as `claude -p` does, until the running agents and workflows have reported and the lead has answered them, then exits at once. Quitting also closes the agents' provider connections, such as a cached openai-codex WebSocket.
- `TaskStop` stops an agent (by id or name), a workflow (by `w…` task id or `wf_…` run id; no notification follows); the agent's report says it was stopped. `ListAgents` and `/agents` list the session's running tasks plus the 20 finished ones that started last, by kind; an older agent is still reachable by id or name through `SendMessage`. `/agents` adds the agent types and what each model name resolves to now.

## Workflow

`Workflow({script | scriptPath | name, args?, resumeFromRunId?})` runs a plain JavaScript script in a `node:vm` sandbox inside a durable task and returns at once; the run reports once as a `<task-notification>` with the result (cut at 8,000 chars), the failed agents and usage counters. `name` looks in `.pi/workflows/<name>.js` when the project is trusted, then `~/.pi/agent/workflows/<name>.js`.

- `agent(prompt, opts)` starts an agent behind the same throttle of 16 as `Agent`; a failed one returns `null`. There is no cap on calls or items.
- Each agent gets the user's request as it was when the run launched, framed apart from the script's task, so a question asked mid-run never becomes its task. A request over 4,000 characters is not relayed at all.
- Files live under `<agent dir>/pi-kit/workflows/<project hash>/`: `scripts/<name>-<runId>.js`, and per run `journal.jsonl`, `progress.jsonl`, `<runId>.json` and `agent-<agentId>.md`.
- A run interrupted by a Pi exit re-runs its script when the session reopens; every agent that already finished answers from the run's record, so none asks the model twice.
- `resumeFromRunId` with an edited `scriptPath` replays the longest unchanged prefix of `agent()` calls from `journal.jsonl` and runs the rest.
- A widget shows each running workflow; `/agents` lists every agent of a run with its phase, state, tokens and age. `/agents <id>` toggles a widget with a running agent's last 8 transcript lines, refreshed every second from its newest 20 entries and cleared when it ends.
- `budget` has Claude Code's shape with no token target: `total` is `null` and `remaining()` is `Infinity`.

## Engine

`engine/` is the only code that imports pi-durable: `index.ts` opens the stores and runs agents, `workflow.ts` runs workflows and StructuredOutput, `host.ts` holds what they share (the throttle, agent placement, the outbox). Each lead session has a store under `<agent dir>/pi-kit/agents/<project hash>/<session id>/` (`engine.sqlite`, `engine.lock`, `out/<agentId>.md`). When an engine opens it removes a store that closed settled (nothing running or paused, every report in the session file), is held by no Pi and is untouched for 14 days, workflow runs as old that ended (`<runId>.json` exists), and saved scripts as old. A store left by a crash or `kill -9` stays until its session reopens and closes settled; to drop one by hand, delete it while no Pi of that project is open, and its agents won't resume. Agents run Pi's own `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write`. The engine survives `/reload`; when Pi exits, agents pause, and the next start of their session reaps orphaned tool processes (`PI_KIT_OWNER`), resumes them, and delivers each report once: the session file is the acknowledgement.

A trusted project's old `.pi/subagents.json` moves into `.pi/pi-kit.json` once, keeping only `defaultModel` as `models.default`.
