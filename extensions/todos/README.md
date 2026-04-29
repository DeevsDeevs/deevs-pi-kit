# Todos Extension

Minimal Pi-managed todo list for multi-step work.

This is intentionally smaller than a task manager. It gives the agent one session-scoped list for the current Pi session, with a small widget for visibility and a lightweight `/todos` overlay for humans.

## Tool

```text
todo_list
```

Operations:

```json
{ "operation": "read" }
{ "operation": "write", "todos": [{ "id": "1", "title": "Inspect current behavior", "status": "in_progress" }] }
{ "operation": "clear" }
```

Statuses:

```text
pending       not started yet
in_progress   actively being worked
blocked       blocked; include notes
done          complete
```

`write` is a complete replacement. Include every existing item, preserve stable ids, and update statuses deliberately.

## Command

```text
/todos          show current list in an overlay and refresh widget
/todos clear    clear current list
```

## Design choices

- session/branch scoped: follows the current Pi conversation branch rather than a project file or global database
- no project files or global database
- one compact widget plus a read-only overlay, no full TUI task manager
- model guidance discourages trivial one-step lists
- `blocked` status exists so uncertainty is visible
- multiple `in_progress` items are allowed for parallel subagents, but the default should be one active item

## Guardrails

- max 40 todos
- unique string ids
- short titles, optional notes
- no automatic conversion into chains or wiki pages

For durable handoff context, use chains. Todos are for current-session progress, not long-term memory.
