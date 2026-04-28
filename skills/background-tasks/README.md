# Background Tasks Skill

Agent-facing workflow for long-running commands.

Main instruction file: [`SKILL.md`](SKILL.md).

## Naming

The skill is named **background-tasks** because that matches user intent:

- dev servers
- watch loops
- test watchers
- REPLs
- workers
- commands to inspect later

The implementation is the [`extensions/processes`](../../extensions/processes/README.md) extension because Pi manages OS processes underneath.

```text
background-tasks skill -> extensions/processes -> proc_* tools -> /proc commands
```

## Core rule

Do not use shell detachment patterns like:

```bash
cmd &
nohup cmd ...
disown
setsid cmd ...
```

Use `proc_start`, then supervise with `proc_read`, `proc_logs`, `proc_signal`, and `proc_clear`.
