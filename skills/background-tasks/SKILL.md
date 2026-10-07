---
name: background-tasks
description: "Pick between Pi Kit Jobs, Monitors and Herdr-owned persistent processes for background work; never detach shells."
---

# Background Tasks

Never launch background work through `cmd &`, `nohup`, `disown`, or `setsid`.

## Use a Job when

The command ends by itself and must keep running while you do something else: a long benchmark, migration check or bounded script whose result you need later. Builds and tests you are waiting on run in the foreground with `bash` and a timeout.

1. `job_start` with the command and a short description.
2. Keep working; the finished Job reports by itself as a `<task-notification>` with its exit code. Do not poll it.
3. `read` its output file when the output matters; `TaskStop` stops it.

## Use a Monitor when

You want to hear about each change while you work: new lines from a script (`command`), files appearing in a folder (`path`), a page or endpoint changing (`url`), or a timed return (`cron` with `prompt`, `once: true` for one fire). For "tell me when X", give a command that exits once X holds. Monitors survive `/reload` and catch up after Pi was closed; `TaskStop` stops one.

## Use Herdr when

The process must keep running while Pi is closed or needs a terminal: dev servers, workers, queues, local services, REPLs, anything needing ongoing stdin or a PTY, and unattended schedules. Pi Kit does not own panes, persistent shells or daemon scheduling.

## Use plain shell when

You need the result before your next step: builds, test runs, `git status`. Give long ones a timeout.
