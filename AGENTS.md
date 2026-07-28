# deevs-pi-kit instructions

This repository is a portable pi package. Keep it minimal and intentional.

## Package contract

- Declare resources in `package.json` under the `pi` key.
- Persona prompts live under `extensions/subagents/agents/*.md`.
- Skills live under `skills/<name>/SKILL.md`.
- Extensions live in `extensions/<name>/index.ts`; the `pi.extensions` manifest globs `./extensions/*/index.ts` only.
- Zero production dependencies; peer and dev dependencies only. Justify any addition.
- Document user-facing resources in `README.md` when they are added.
- Validate with `npm run check` (typecheck, tests, RPC/print/JSONL mode smoke, supply-chain audit, pack).

## Control-plane invariant

Prose fields such as `reason`, `summary`, `explanation`, and human evidence are display-only and must never drive runtime conditionals. Behavioral decisions consume schema-validated enums, booleans, IDs, counters, exit codes, or trusted UI/command operations. Regex is for syntax—paths, IDs, markdown, cron, and protocol framing—never for intent, sentiment, authorization, blocker classification, or verdict inference.

## Process ownership

Pi Kit deliberately owns only bounded execution: Jobs run bounded non-interactive commands with capped output and hard timeouts; session Cron fires only inside the open Pi session. Everything persistent or interactive — dev servers, watchers, REPLs, terminal panes, unattended schedules, work that must survive Pi reloads — belongs to Herdr (`herdr`, https://herdr.dev), the detachable agent multiplexer whose socket API lets agents spawn panes, read output, and wait on each other. Never launch detached processes via `&`, `nohup`, `disown`, or `setsid`; the kit blocks them (`shared/process-safety.ts`).
