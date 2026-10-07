# Runtime bench

Three lanes; A and B are deterministic and free.

| Lane | Command | Measures |
|---|---|---|
| A context | `npm run bench:context` (`-- --claude` to refresh Claude counts, `-- --check` for ceilings) | Tokens every model pays before its first turn: the lead's tool metadata (`Agent` and the other subagents tools, Jobs, Runtime), the agent types prompt section, skill index as Pi renders it, skill bodies, native MCP catalog and context, docs. o200k via js-tiktoken; Claude via `claude -p` prompt-size deltas cached in `claude-tokens.json`. `test/bench-context.test.ts` pins `context-budget.json`. |
| C wire | `npm run polygon -- --only context-wire` (twice: once per `--kit`, results copied to `results/context-wire/{new,old}`), then `node bench/context-wire/wire.mjs [summary.json]` | What each harness actually sends before any work: the polygon puppet records the full first request of vanilla Pi, Pi with the kit (user turn and a task-notification wake), Claude Code `-p` and interactive, and Codex. Split per component (base prompt, each tool schema, snippets, guidelines, skill index, kit sections, Claude context blocks), o200k per component; Claude counts from real `anthropic/claude-opus-5.5` calls on OpenRouter per group (`wire.mjs --openrouter`, run in a container with the key at `/key`). |
| B protocol | `npm run bench:protocol` | Daemon under load on isolated roots with a fake `herdr`: burst, inbox race, caps, kill-and-restart, host-verification fanout. Any broken invariant exits 1. |

Results land in `results/` (ignored).
