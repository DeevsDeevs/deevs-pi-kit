---
name: missions
description: "Read to load mission_start, mission_update and mission_get. A long goal the lead pursues unattended across turns and sessions."
---

# Missions

A Mission is one long goal per project, kept under `.missions/<slug>/`, that you pursue until its done criteria hold. While it is active, each time you finish with nothing of yours running you are prompted to continue; monitors and collaborators wake you themselves.

## Start one

Only when the user asks for a mission, or for long work to carry on without them. `mission_start` takes a short `title`, the `goal` with its constraints, and `done` criteria concrete enough to check yourself (a command that passes, a file that exists). `review: true` runs a read-only closing-review Workflow before it closes.

## Run it

- After each meaningful step, `mission_update` with `log` (what happened, with evidence) and `next` (the next concrete step).
- `status`: `waiting_user` when only the user can unblock you, `done` when the done criteria hold, `paused` or `abandoned` only when the user asks, `active` to resume.
- With `review: true`, `done` first starts the closing review: run the Workflow it names, then `mission_update` with its `verdict` and its findings as `log`.
- `mission_get` shows the status, goal, done criteria, recent log and next step.

Three continues with no `mission_update` and no new commit pause it. One mission at a time: close or pause the open one before starting another.
