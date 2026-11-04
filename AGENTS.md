# deevs-pi-kit instructions

A portable Pi package. Keep it minimal and intentional: it holds only Pi-runtime things, on a par with Claude Code's built-ins. Long-running processes, cross-model peers and other machines belong to hc; cross-agent skills belong to agent-system.

## Package contract

- Resources are declared in `package.json` under `pi`. Extensions are `extensions/<name>/index.ts` (the `pi.extensions` manifest globs `./extensions/*/index.ts` only), skills `skills/<name>/SKILL.md`, persona prompts `extensions/subagents/agents/*.md`.
- Pi is pinned exactly: `pi-ai`, `pi-coding-agent` and `pi-tui` at 1.4.0 in devDependencies, and `typebox` at 1.3.27, Pi 1.4.0's own pin. Bump them together with `pi-durable` and `chord`, in one commit.
- Host-provided packages, `typebox` included, are peers with `"*"` ranges, never production dependencies.
- The production dependencies are `@earendil-works/pi-durable` and its `@earendil-works/chord` (for `BACKGROUND_CONTEXT`), pinned exactly to the same release and imported only under `extensions/subagents/engine/`. The user chose pi-durable so subagents survive Pi exits and reloads, and accepted its footprint for that: its own `pi-ai` with the provider SDKs and esbuild, about 90 packages and 125 MB, stated in the README and `docs/reference.md`. Everything else is peer or dev only; justify any addition.
- Agents and workflows run Pi models only, with Pi's own tools.
- State that extensions share lives on `globalThis[Symbol.for("pi-kit.<name>")]`, as in `shared/tasks.ts`: Pi's loader gives each extension its own module graph, so a module-level singleton exists once per extension.
- Settings live in one file, `pi-kit.json` (global `~/.pi/agent/`, project `.pi/`), read only through `extensions/shared/config.ts`. The kit registers exactly one command, `/agents`; anything else is a tool the lead calls or a `pi-kit.json` key.
- Every user-facing resource (each tool, the command, every `pi-kit.json` key, every skill) is documented in `docs/reference.md`, added in the same change that adds it. `README.md` stays a short pitch that links there.
- Never add AI attribution to commits or PRs: no `Co-Authored-By: Claude`, no session links, no "Generated with" footers. The author is the user alone.

## Checks

- `npm run check` runs typecheck, tests, the supply-chain audit and pack.

## Control-plane invariant

Prose fields such as `reason`, `summary`, `explanation` and human evidence are display-only and must never drive runtime conditionals. Behavioral decisions consume schema-validated enums, booleans, IDs, counters, exit codes, or trusted UI/command operations. Regex is for syntax (paths, IDs, markdown, protocol framing), never for intent, sentiment, authorization, blocker classification or verdict inference.

## Process ownership

Kit tasks (agents and workflows) are owner-bound: they live in the lead session's durable store and survive `/reload`. When that Pi exits they pause, and when the session reopens they resume. Every process an agent's `bash` starts carries `PI_KIT_OWNER` and is reaped before a resume.
