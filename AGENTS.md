# deevs-pi-kit instructions

This repository is a portable pi package. Keep it minimal and intentional.

## Package contract

- Declare resources in `package.json` under the `pi` key.
- Persona prompts live under `extensions/subagents/agents/*.md`.
- Skills live under `skills/<name>/SKILL.md`.
- Extensions live in `extensions/<name>/index.ts`; the `pi.extensions` manifest globs `./extensions/*/index.ts` only.
- Pi is pinned exactly: `pi-ai`, `pi-coding-agent` and `pi-tui` at 1.0.4 in devDependencies, which is also the Pi release the polygon image runs, and `typebox` at 1.3.27, Pi 1.0.4's own pin. Bump them together, in one commit gated on the polygon.
- Host-provided packages, including `typebox`, are peers with `"*"` ranges, never production dependencies under their host names. The standalone Runtime daemon and `guard-hook.mjs` use the pinned `runtime-typebox` npm alias through their entrypoints' Node import hook; Pi extensions must never import that alias. The MCP server needs no TypeBox. The one other production dependency is `@earendil-works/pi-durable`, pinned exactly: you chose it so subagents survive Pi exits and reloads, and only `extensions/subagents/engine/` imports it. Its footprint is accepted for that and stated in the README: its own `pi-ai` with the provider SDKs and esbuild, about 90 packages and 125 MB. Everything else is peer or dev only; justify any addition.
- State that extensions share lives on `globalThis[Symbol.for("pi-kit.<name>")]`, as in `shared/tasks.ts`: Pi's loader gives each extension its own module graph, so a module-level singleton exists once per extension.
- Document user-facing resources in `README.md` when they are added.
- Never add AI attribution to commits or PRs: no `Co-Authored-By: Claude`, no session links, no "Generated with" footers. The author is the user alone.
- Settings live in one file, `pi-kit.json` (global `~/.pi/agent/`, project `.pi/`), read only through `extensions/shared/config.ts`. The kit registers exactly two commands, `/agents` and `/chains`; anything else is a tool the lead calls or a `pi-kit.json` key.
- Validate with `npm run check` (lint, typecheck, tests, the polygon scenarios, supply-chain audit, pack). The polygon runs every scenario in a rootless Podman container, so `check` needs Podman.
- Dev loop: `npm run polygon -- --only <names>` while you work. A feature is done when its polygon scenario is green; on red, read `polygon/results/latest/<name>/` before changing code.

## Control-plane invariant

Prose fields such as `reason`, `summary`, `explanation`, and human evidence are display-only and must never drive runtime conditionals. Behavioral decisions consume schema-validated enums, booleans, IDs, counters, exit codes, or trusted UI/command operations. Regex is for syntax—paths, IDs, markdown, cron, and protocol framing—never for intent, sentiment, authorization, blocker classification, or verdict inference.

## Process ownership

Kit tasks (agents, workflows, jobs, monitors and timers) are owner-bound: they live in the lead session's durable store, survive `/reload`, pause whenever that Pi exits, and resume when the session reopens, where an interrupted job is reported and a monitor catches up. Every process a task starts carries `PI_KIT_OWNER` and is reaped before a resume. Dev servers, REPLs, terminal panes and work that must run while Pi is closed belong to Herdr (`herdr`, https://herdr.dev), the detachable agent multiplexer whose socket API lets agents spawn panes, read output, and wait on each other. Never launch detached processes via `&`, `nohup`, `disown`, or `setsid`; the kit blocks them (`shared/guard.ts`).
