---
name: todos
description: Use Pi's `todo_list` tool to plan and track non-trivial current-session work. Use for multi-step implementation, debugging, validation, research, or coordinating subagents; avoid for one-shot answers.
---

# Managed Todos

`todo_list` is a lightweight progress tracker for the current session — not durable memory; use chains for handoffs.

## Tool contract

```text
todo_list({ operation: "read" | "write" | "clear", todos: [...] })
```

Item: `{ "id": "1", "title": "Implement parser guard", "status": "pending", "notes": "Acceptance: rejects invalid IDs" }`

Statuses: `pending` · `in_progress` · `done` (completed and verified enough) · `blocked` (explain why in `notes`).

`write` is a complete replacement: include all existing todos, preserve stable ids.

## When to use

Proactively for multi-step implementation/refactors, debugging with several hypotheses, validation passes with multiple checks, research that branches into decisions, multi-task requests, and subagent coordination needing visible progress.

Not for one-shot answers, tiny edits, pure conversation, durable memory (`chain_save`), or replacing an issue tracker.

## Workflow

1. Create a short list (3–8 items) before substantial work.
2. Mark every genuinely concurrent item `in_progress`; otherwise keep exactly one. If pending items have no dependency on the current item and are safe to run together, batch them instead of serializing by habit.
3. Mark `done` immediately after evidence exists; mark `blocked` instead of pretending progress.
4. Revise when the plan changes, preserving unchanged ids; clear when the task finishes or is abandoned.

## Relationship to other Pi systems

Chains hold durable milestones, not every todo update. The parent owns the list for subagent-backed work: mark all grouped parallel runs `in_progress`, then each `done`/`blocked` after reading the settled results. Track background process or group ids in `notes` only when useful. Todos can mirror a review matrix, but verdicts still need explicit evidence.

Human display: `/todos` (read-only overlay), `/todos clear`. Use `todo_list` for state changes.

## Anti-slop

No vague items ("fix stuff"), no `done` without evidence, no stale `in_progress` on task switches, no updates after every tiny tool call, no keeping finished smoke-test lists around. Beyond ~8 items, group or defer unless the user asked for a detailed checklist.
