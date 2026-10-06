# Runtime bench

Two lanes, both deterministic and cheap.

| Lane | Command | Measures |
|---|---|---|
| A context | `npm run bench:context` (`-- --claude` to refresh Claude counts, `-- --check` for ceilings) | Tokens every model pays before its first turn: Pi tool metadata, skill index as Pi renders it, skill bodies, native MCP catalog and context, docs. o200k via js-tiktoken; Claude via `claude -p` prompt-size deltas cached in `claude-tokens.json`. `test/bench-context.test.ts` pins `context-budget.json`. |
| B protocol | `npm run bench:protocol` | Daemon under load on isolated roots with a fake `herdr`: burst, inbox race, caps, kill-and-restart, host-verification fanout. Any broken invariant exits 1. |

Results land in `results/` (ignored).
