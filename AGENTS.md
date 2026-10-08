# deevs-pi-kit instructions

A portable Pi package. Keep it minimal and intentional.

## Package contract

- Resources are declared in `package.json` under `pi`. Extensions are `extensions/<name>/index.ts` (the `pi.extensions` manifest globs `./extensions/*/index.ts` only), skills `skills/<name>/SKILL.md`, persona prompts `extensions/subagents/agents/*.md`.
- Pi is pinned exactly: `pi-ai`, `pi-coding-agent` and `pi-tui` at 1.0.4 in devDependencies, the release the polygon image runs, and `typebox` at 1.3.27, Pi 1.0.4's own pin. Bump them together, in one commit gated on the polygon.
- Host-provided packages, `typebox` included, are peers with `"*"` ranges, never production dependencies under their host names. The standalone Runtime daemon and `guard-hook.mjs` load the pinned `runtime-typebox` npm alias through their entrypoints' Node import hook; Pi extensions must never import that alias. Neither MCP server (`extensions/runtime/mcp/`, `plugins/chains/server/`) needs TypeBox at runtime.
- The one other production dependency is `@earendil-works/pi-durable`, pinned exactly and imported only under `extensions/subagents/engine/`. The user chose it so subagents survive Pi exits and reloads, and accepted its footprint for that: its own `pi-ai` with the provider SDKs and esbuild, about 90 packages and 125 MB, stated in the README and `docs/reference.md`. Everything else is peer or dev only; justify any addition.
- State that extensions share lives on `globalThis[Symbol.for("pi-kit.<name>")]`, as in `shared/tasks.ts`: Pi's loader gives each extension its own module graph, so a module-level singleton exists once per extension.
- Settings live in one file, `pi-kit.json` (global `~/.pi/agent/`, project `.pi/`), read only through `extensions/shared/config.ts`. The kit registers exactly two commands, `/agents` and `/chains`; anything else is a tool the lead calls or a `pi-kit.json` key.
- Every user-facing resource (each tool, both commands, every `pi-kit.json` key, every skill, the chains plugin) is documented in `docs/reference.md`, added in the same change that adds it. `README.md` stays a short pitch that links there.
- `plugins/chains/`, listed by `.claude-plugin/marketplace.json`, ships the chain core to Claude Code and Codex. After editing `extensions/chains/{service,parser,types,format,tool}.ts` or `extensions/shared/{terms,bytes}.ts`, run `npm run sync:chains-plugin`; a test fails while the copies differ.
- Never add AI attribution to commits or PRs: no `Co-Authored-By: Claude`, no session links, no "Generated with" footers. The author is the user alone.

## Checks

- `npm run check` runs lint, typecheck, tests, the polygon scenarios, the supply-chain audit and pack. The polygon runs every scenario in a rootless Podman container, so `check` needs Podman.
- Dev loop: `npm run polygon -- --only <names>` while you work. A feature is done when its polygon scenario is green; on red, read `polygon/results/latest/<name>/` before changing code.
- `polygon/ceilings.json` caps production lines per area (`size-ceilings`). A change that adds code raises its area in the same commit, one that deletes code lowers it.
- `test/runtime-docs.test.ts` holds the docs to shape: README's `## Quickstart` section is at most 12 lines, `extensions/runtime/PROTOCOL.md` at most 120 with a `## Methods` table listing exactly the dispatchable methods, `skills/collaborators/SKILL.md` under 40, and every relative link in those three and `docs/reference.md` resolves.

## Control-plane invariant

Prose fields such as `reason`, `summary`, `explanation` and human evidence are display-only and must never drive runtime conditionals. Behavioral decisions consume schema-validated enums, booleans, IDs, counters, exit codes, or trusted UI/command operations. Regex is for syntax (paths, IDs, markdown, cron, protocol framing), never for intent, sentiment, authorization, blocker classification or verdict inference.

## Process ownership

Kit tasks (agents, workflows, jobs, monitors and timers) are owner-bound: they live in the lead session's durable store and survive `/reload`. When that Pi exits they pause, and when the session reopens they resume: a monitor catches up, and a job that was running is reported as interrupted instead. Every process a task starts carries `PI_KIT_OWNER` and is reaped before a resume.

Dev servers, REPLs, terminal panes and work that must run while Pi is closed belong to Herdr (`herdr`, https://herdr.dev), the detachable agent multiplexer whose socket API lets agents spawn panes, read output and wait on each other. Never launch detached processes via `&`, `nohup`, `disown`, `setsid`, `tmux new -d` or `screen -dm`; the kit blocks them (`shared/guard.ts`).
