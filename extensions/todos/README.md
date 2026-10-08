# Todos

One `todo_list` tool: a session todo list shown as a widget. How the model should use it is in [skills/todos](../../skills/todos/SKILL.md).

```json
{ "operation": "read" }
{ "operation": "write", "todos": [{ "id": "1", "title": "Inspect behavior", "status": "in_progress", "notes": "optional" }] }
{ "operation": "clear" }
```

- Statuses: `pending`, `in_progress`, `blocked`, `done`.
- `write` replaces the whole list: at most 40 items, unique string ids, titles up to 120 characters, notes up to 1,000.
- The list lives in the session file (each `todo_list` result), so it follows `/resume` and tree navigation. It is not project memory; use chains for handoffs.
