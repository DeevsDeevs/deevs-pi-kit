---
name: todos
description: Use Pi's `todo_list` tool to plan and track non-trivial current-session work. Use for multi-step implementation, debugging, validation, research, or coordinating subagents; avoid for one-shot answers.
---

# Managed Todos

Use `todo_list` as a lightweight progress tracker for the current Pi session. It is not durable memory; use chains for handoffs and long-term context.

## Tool contract

```text
todo_list({ operation: "read" })
todo_list({ operation: "write", todos: [...] })
todo_list({ operation: "clear" })
```

Todo item:

```json
{
  "id": "1",
  "title": "Implement parser guard",
  "status": "pending",
  "notes": "Acceptance: rejects invalid IDs"
}
```

Statuses:

- `pending` — not started yet
- `in_progress` — actively being worked
- `done` — completed and verified enough for this task
- `blocked` — cannot proceed; explain why in `notes`

`write` is complete replacement. Always include all existing todos, not just the changed item. Preserve stable ids.

## When to use

Use todos proactively for:

- multi-step implementation or refactor work
- debugging/diagnosis with several hypotheses or probes
- validation/review passes with multiple checks
- research or reconnaissance that will branch into decisions
- user provides multiple tasks or asks for a plan
- subagent coordination where parent needs visible progress

Do not use todos for:

- one-shot answers
- tiny edits with one obvious step
- pure explanation/conversation
- durable project memory; use `chain_save` instead
- replacing an issue tracker or project plan

## Good workflow

1. Create a short list before starting substantial work.
2. Normally mark exactly one current item `in_progress`; use multiple only for real parallel subagent/background work.
3. Keep the list compact: usually 3-8 items.
4. Mark items `done` immediately after evidence exists.
5. Mark items `blocked` instead of pretending progress is complete.
6. Revise the list when the plan changes, preserving ids for unchanged items.
7. Clear the list when the scoped task is finished or abandoned.

Example:

```json
{
  "operation": "write",
  "todos": [
    { "id": "1", "title": "Inspect failing test", "status": "in_progress" },
    { "id": "2", "title": "Patch root cause", "status": "pending" },
    { "id": "3", "title": "Run focused validation", "status": "pending" }
  ]
}
```

After step 1 completes:

```json
{
  "operation": "write",
  "todos": [
    { "id": "1", "title": "Inspect failing test", "status": "done", "notes": "Found parser rejecting v2 IDs" },
    { "id": "2", "title": "Patch root cause", "status": "in_progress" },
    { "id": "3", "title": "Run focused validation", "status": "pending" }
  ]
}
```

## Relationship to other Pi systems

- **Chains**: todos are ephemeral progress; chains are durable handoff memory. Save a chain link for meaningful milestones, not every todo update.
- **Subagents**: parent owns the todo list. Mark subagent-backed work `in_progress`, then `done`/`blocked` after reading results.
- **Background tasks**: if a todo starts a long-running server/watch, track the process id in `notes` only when useful.
- **Validation review**: todos can mirror the review matrix/checks, but the final verdict still needs explicit evidence.

## Human commands

```text
/todos        show current todos in a read-only overlay
/todos clear  clear the current list and widget
```

Use `/todos` only for human display. Use `todo_list` to update state.

## Anti-slop rules

- Do not create lists with vague items like “do task” or “fix stuff”.
- Do not mark `done` without evidence or a clear outcome.
- Do not leave stale `in_progress` todos when switching tasks.
- Do not spam todo updates after every tiny tool call.
- Do not keep completed smoke-test todos around; clear them.
- If the list exceeds ~8 items, group or defer items unless the user asked for a detailed checklist.
