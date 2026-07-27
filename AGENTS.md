# deevs-pi-kit instructions

This repository is a portable pi package. Keep it minimal and intentional.

## Package contract

- Declare resources in `package.json` under the `pi` key.
- Persona prompts live under `extensions/subagents/agents/*.md`.
- Skills live under `skills/<name>/SKILL.md`.
- Extensions live in `extensions/<name>/index.ts`; the `pi.extensions` manifest globs `./extensions/*/index.ts` only.
- Document user-facing resources in `README.md` when they are added.

## Control-plane invariant

Prose fields such as `reason`, `summary`, `explanation`, and human evidence are display-only and must never drive runtime conditionals. Behavioral decisions consume schema-validated enums, booleans, IDs, counters, exit codes, or trusted UI/command operations. Regex is for syntax—paths, IDs, markdown, cron, and protocol framing—never for intent, sentiment, authorization, blocker classification, or verdict inference.
