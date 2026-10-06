---
name: background-tasks
description: "Pick between Pi Kit Jobs, Monitors and Herdr-owned persistent processes for background work; never detach shells."
---

# Background Tasks

Never launch background work through `cmd &`, `nohup`, `disown`, or `setsid`.

## Use a Job when

The command ends by itself and you need its result later: a build, test run, migration check, benchmark or bounded script.

1. `job_start` with the command and a short description.
2. Keep working; the finished Job reports by itself as a `<task-notification>` with its exit code. Do not poll it.
3. `read` its output file when the output matters; `TaskStop` stops it.

## Use a Monitor when

You want to hear about each change while you work: new lines from a script (`command`), files appearing in a folder (`path`), a page or endpoint changing (`url`), or a timed return (`cron` with `prompt`, `once: true` for one fire). For "tell me when X", give a command that exits once X holds. Monitors survive `/reload` and catch up after Pi was closed; `TaskStop` stops one.

## Use Herdr when

The process must keep running while Pi is closed or needs a terminal: dev servers, workers, queues, local services, REPLs, anything needing ongoing stdin or a PTY, and unattended schedules. Pi Kit does not own panes, persistent shells or daemon scheduling.

## Use plain shell when

The command is short and its result is needed now. Do not create a Job for `git status` or one focused test.
