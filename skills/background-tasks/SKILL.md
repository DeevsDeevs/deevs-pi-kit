---
name: background-tasks
description: "Pick between Pi Kit Jobs, session Cron and Herdr-owned persistent processes for background work; never detach shells."
---

# Background Tasks

Never launch background work through `cmd &`, `nohup`, `disown`, or `setsid`.

## Use a Job when

The command is bounded, non-interactive, and should finish within 15 minutes: a build, test run, migration check, benchmark or bounded script, especially one with a readiness marker or output worth reading by cursor.

1. `job_start`, with `argv` when shell syntax is unnecessary and `readyPattern` only when readiness matters.
2. Keep working; a finished Job reports by itself as a `<task-notification>`. Do not poll it.
3. `job_read` with `afterSeq` when its output becomes relevant; `TaskStop` stops it.

## Use Cron when

Timing itself is the dependency in this Pi session: a user-requested reminder, a recurring timed check, or a short one-shot return after an external delay with no completion event. Cron fires only while the session is open; it cannot wake Pi or the machine.

## Use Herdr when

The process is persistent or terminal-oriented: dev servers, watchers, workers, queues, local services, REPLs, anything needing ongoing stdin or a PTY, work that must survive Pi exits, and unattended schedules. Pi Kit does not own panes, persistent shells or daemon scheduling.

## Use plain shell when

The command is short and its result is needed now. Do not create a Job for `git status` or one focused test.
