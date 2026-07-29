---
name: agentic-tdd
description: Phase-based resumable agentic TDD loop (PLAN → LOOP → ASSESS → RELEASE) with protected test evidence, deterministic engine gates, fresh-context falsification, and optional external challenges. Use when the user asks for a TDD mission, tdd loop, agentic tdd, protected tests, or to plan/implement/assess/release a feature under the TDD workflow.
---

# Agentic TDD (Pi shim)

The runtime-agnostic workflow lives in `core/`. Read `core/ORCHESTRATOR.md` first and
follow it; this shim only binds it to the Pi runtime.

## Runtime bindings

- **Engine**: `node <this-skill-dir>/core/scripts/tdd-engine.mjs <cmd> <feature> --root <target repo>`
  via a bounded Job. Treat only its typed JSON output as authoritative.
- **Roles**: launch packets with `subagent` / `subagent_wait` (see the subagents skill).
  Fresh context (`context: "fresh"`) for critique, tester-qa acceptance authoring,
  assess, release-review, and challenge runs. Group independent perspectives in one
  `subagent` call; settle with one `subagent_wait`. Never run parallel writers in one
  worktree.
- **Missions**: the recurrence controller. Follow `core/references/mission-adapter.md`
  for creation, progress, blockers, takeover, and completion wiring. Do not build any
  other scheduler.
- **Chains**: at every phase checkpoint that ends a session naturally, save a chain link
  whose typed `nextStep` names the engine state and next command.

## Boundaries

- Never bypass the engine to edit `manifest.json` or protection state by hand.
- Protected files are locked with the kit's control-plane invariant in mind: verdicts,
  transitions, and blockers come from engine enums and schema-validated child reports,
  never from prose.
