# Session Cron

Cron schedules prompts inside one exact Pi session. It is deliberately not a daemon or OS scheduler.

## Use

```text
cron { action: "create", cron: "0 9 * * 1-5", prompt: "Review today's queue", recurring: true }
cron { action: "list" }
cron { action: "delete", id: "deadbeef" }
```

`cron` has five local-time fields: minute, hour, day of month, month, and day of week. Ranges, lists, and steps are supported. `recurring` defaults to `true`; set it to `false` for a one-shot.

Use `/cron` to browse tasks and `/cron delete <id>` to remove one.

## Semantics

- State is stored atomically under `~/.pi/agent/cron/<session-id>.json` (or `PI_CODING_AGENT_DIR`) and is never adopted by another session or fork.
- A next-deadline timer exists only in the current Pi process. Closing Pi stops timers; reopening the same session coalesces up to 10,000 missed recurring occurrences into each fire.
- User messages and active turns have priority. Only one due task is delivered at a time while Pi is idle.
- Pi receives a custom message that becomes a user-context `<cron-fire>` envelope. The cursor advances, or a one-shot is deleted, only after `message_start` confirms admission.
- Deterministic jitter spreads recurring work forward by at most 10% of its period (capped at 15 minutes). Round-hour/half-hour one-shots may fire up to 90 seconds early; other one-shots remain exact. Recurring tasks older than seven days receive one final stale fire and are removed.
- Limits: 50 tasks per session, 8 KiB per prompt, and one-shots within 350 days.

Use Herdr or an OS scheduler when a closed Pi process or machine must be woken reliably.

For deterministic development checks only: `DEEVS_PI_CRON_NO_JITTER=1`, `DEEVS_PI_CRON_NO_STALE=1`, and `DEEVS_PI_DISABLE_CRON=1`.
