---
chain: "deevs-pi-kit"
branch: "main"
created: "2026-05-27T14:58:14.548Z"
---

# Mission auto-continue stale context fix

## Request
User reported the Mission skill seemed broken and no longer auto-continued; asked to check first, then debug.

## Symptom / repro
Recent process output showed an unhandled stale ExtensionContext error from `extensions/mission/index.ts`:
- `MissionState.loadFromSession` accessed `ctx.sessionManager` from a delayed `setTimeout` callback after session replacement/reload.
- Created `/tmp/mission-stale-repro.ts`, which reproduced `STALE_CTX_SESSION_MANAGER` by firing `session_start({reason:"reload"})`, marking ctx stale, then firing `session_shutdown` before the timer executed.

## Root cause
Mission scheduled auto-continuation with raw `setTimeout(() => maybeContinue(ctx), 0)` on `session_start` and `session_compact`. Those timers were not cancelled or guarded on `session_shutdown`, so old extension instances could later use stale Pi contexts.

## Fix
Changed `extensions/mission/index.ts`:
- Added `disposed` flag and `continuationTimers` set.
- Added `scheduleMaybeContinue(ctx)` to track timers.
- `maybeContinue(ctx)` now returns if disposed or ctx is not the current ctx.
- Continuation promise catch safely avoids using stale ctx.
- `session_shutdown` clears timers, clears status, sets `currentCtx = undefined`, and marks disposed.

## Validation
- `/tmp/mission-stale-repro.ts` now passes with `{"uncaught":""}`.
- `/tmp/mission-auto-continue-smoke.ts` confirms a live active mission still appends a continued event and sends a continuation message with `triggerTurn:true, deliverAs:"followUp"`.
- `bun build extensions/mission/index.ts ...` passes.
- `npm pack --dry-run` includes `extensions/mission/index.ts`.

## Other uncommitted context
Repo also has prior Codex Fast changes: `README.md` and `extensions/codex-fast/index.ts` uncommitted.
