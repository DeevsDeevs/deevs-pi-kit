---
name: background-tasks
description: Choose between bounded Pi Kit Jobs and Herdr-owned persistent or interactive processes. Never use shell detachment hacks.
---

# Background Tasks

Never launch background work through `cmd &`, `nohup`, `disown`, or `setsid`.

## Use a Job when

The command is bounded, non-interactive, and should finish within 15 minutes:

- a build, test, migration check, benchmark, or bounded script;
- a command with a useful readiness marker;
- output that should be cursor-readable and capped;
- work that needs hard timeout and process-tree cancellation.

Workflow:

1. `job_start` with `argv` when shell syntax is unnecessary.
2. Add `readyPattern` only when readiness matters.
3. Use `job_read` with `afterSeq` for bounded output.
4. Use one `job_wait` rather than polling.
5. Stop with `job_stop`.

Jobs use pipe stdio, close stdin after optional initial input, cap memory/log output, emit durable terminal events, and are killed or reconciled as lost when Pi ownership ends.

## Use Herdr when

The process is persistent or terminal-oriented:

- dev servers, watchers, workers, queues, and local services;
- REPLs or commands needing ongoing stdin/PTY interaction;
- work that must survive Pi reloads or machine/session changes;
- unattended scheduling or reliable future wakeups;
- anything requiring a pane or worktree lifecycle.

Pi Kit intentionally does not own tmux, PTYs, persistent shells, panes, or daemon scheduling.

## Use normal shell execution when

The command is a short foreground operation whose result is needed immediately. Do not create a Job for every `git status` or focused test command.
