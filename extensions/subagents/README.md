# Subagents

`Agent` and `TaskStop`, with Claude Code's names and result labels, on a durable engine inside the lead's Pi.

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
- `TaskStop` stops an agent (by id or name) or a job; the report says the agent was stopped.

## Engine

`engine/` is the only code that imports pi-durable. Each lead session has a store under `<agent dir>/pi-kit/agents/<project hash>/<session id>/` (`engine.sqlite`, `engine.lock`, `out/<agentId>.md`). Agents run Pi's own `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write` with the kit guard on every `bash`. The engine survives `/reload`; when Pi exits, agents pause, and the next start of their session reaps orphaned tool processes (`PI_KIT_OWNER`), resumes them, and delivers each report once: the session file is the acknowledgement.

A trusted project's old `.pi/subagents.json` moves into `.pi/pi-kit.json` once, keeping only `defaultModel` as `models.default`.
