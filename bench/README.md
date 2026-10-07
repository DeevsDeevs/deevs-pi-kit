# Runtime bench

Two lanes, both deterministic and cheap.

| Lane | Command | Measures |
|---|---|---|
| A context | `npm run bench:context` (`-- --claude` to refresh Claude counts, `-- --check` for ceilings) | Tokens every model pays before its first turn: the lead's tool metadata (`Agent` and the other subagents tools, Jobs, Runtime), the agent types prompt section, skill index as Pi renders it, skill bodies, native MCP catalog and context, docs. o200k via js-tiktoken; Claude via `claude -p` prompt-size deltas cached in `claude-tokens.json`. `test/bench-context.test.ts` pins `context-budget.json`. |
| B protocol | `npm run bench:protocol` | Daemon under load on isolated roots with a fake `herdr`: burst, inbox race, caps, kill-and-restart, host-verification fanout. Any broken invariant exits 1. |

| C terminal-bench | `bench/terminal-bench/prepare.sh`, then `bench/terminal-bench/run.sh <pi-kit\|claude-code\|codex> <model> [harbor run args]` | Terminal-Bench 4.0 through Harbor on rootless Podman, real models via OpenRouter (`~/.config/pi-kit-bench/openrouter.key`, never a subscription login). `pi-kit` is Harbor's Pi agent on Pi's checked Bun release binary with this checkout's HEAD installed as a package; `claude-code` is Harbor's built-in agent with `ANTHROPIC_BASE_URL` on OpenRouter. `codex` is Harbor's built-in Codex agent (CLI 0.160.1) with an OpenRouter model provider on the Responses API; pass any OpenRouter id (`openai/gpt-6.1-sol`). `summarize.py <job-dir>...` prints reward, tokens, cost and time per trial; `image_sizes.py` sizes a dataset's images. Costs real money. |

Results land in `results/` (ignored).
