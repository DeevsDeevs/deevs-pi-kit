# Todos

A small session-scoped todo list for non-trivial multi-step work. It is not durable project memory; use chains for handoffs.

## Tool

```text
todo_list
```

Operations:

```json
{ "operation": "read" }
{ "operation": "write", "todos": [{ "id": "1", "title": "Inspect behavior", "status": "in_progress" }] }
{ "operation": "clear" }
```

Statuses: `pending`, `in_progress`, `blocked`, `done`.

`write` replaces the full list. Preserve stable ids and include all existing items when updating.

## Commands

```text
/todos          show the current list
/todos clear    clear the list
```

## Guardrails

- intended for current-session progress only
- max 40 items
- unique string ids
- short titles; optional notes
- normally one `in_progress` item unless work is genuinely parallel
- no automatic conversion to chains or wiki pages
