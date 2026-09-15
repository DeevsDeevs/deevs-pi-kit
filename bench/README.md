# Runtime bench

Three lanes; A and B are deterministic and cheap, C spends real (cheap) model tokens.

| Lane | Command | Measures |
|---|---|---|
| A context | `npm run bench:context` (`-- --claude` to refresh Claude counts, `-- --check` for ceilings) | Tokens every model pays before its first turn: Pi tool metadata, skill index as Pi renders it, skill bodies, native MCP catalog and context, docs. o200k via js-tiktoken; Claude via `claude -p` prompt-size deltas cached in `claude-tokens.json`. `test/bench-context.test.ts` pins `context-budget.json`. |
| B protocol | `npm run bench:protocol` | Daemon under load on isolated roots with a fake `herdr`: burst, inbox race, caps, kill-and-restart, host-verification fanout. Any broken invariant exits 1. |
| C live | `npm run bench:live -- --lane claude\|codex\|pi\|fanout [--mails N] [--collaborators K]`, then `node --experimental-strip-types bench/live/score.mjs <lane>` | Real collaborators in `/home/deevs/agents/pi-kit-bench/arena` (Herdr workspace `w1N`) driven by a terra Pi lead in auto mode; per mail: wake and reply latency, wakes, tool calls, stray calls, tokens, model from the transcript. Never astra. |

Results land in `results/` (ignored); `results/baseline/` keeps the pre-optimization live runs.
