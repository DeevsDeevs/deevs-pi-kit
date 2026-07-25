# deevs-pi-kit instructions

This repository is a portable pi package. Keep it minimal and intentional.

## Package contract

- Declare resources in `package.json` under the `pi` key.
- Persona prompts live under `extensions/subagents/agents/*.md`.
- Skills live under `skills/<name>/SKILL.md`.
- Extensions live in `extensions/<name>/index.ts`; the `pi.extensions` manifest globs `./extensions/*/index.ts` only.
- Document user-facing resources in `README.md` when they are added.
