# Bench

Five lanes. A and B are deterministic and free; D and E cost real money or subscription usage. Results land in `results/` (ignored).

| Lane | Command | Measures |
|---|---|---|
| A context | `npm run bench:context` (`-- --claude` refreshes Claude counts, `-- --check` checks ceilings) | Tokens every model pays before its first turn: the lead's tool metadata (`Agent` with its agent types, the other subagents tools, jobs, Runtime), the skill index as Pi renders it, skill bodies, the native MCP catalog and context, docs. o200k via js-tiktoken; Claude via `claude -p` prompt-size deltas cached in `claude-tokens.json`. `test/bench-context.test.ts` pins `context-budget.json`. |
| B protocol | `npm run bench:protocol` | The daemon under load on isolated roots with a fake `herdr`: burst, inbox race, caps, kill-and-restart, host-verification fanout. Any broken invariant exits 1. |
| C wire | `npm run polygon -- --only context-wire` (once per `--kit`, results copied to `results/context-wire/{new,old}`), then `node bench/context-wire/wire.mjs [summary.json]` | What each harness actually sends before any work: the puppet records the first full request of vanilla Pi, Pi with the kit (user turn and a task-notification wake), Claude Code `-p` and interactive, and Codex, split per component and counted in o200k. Claude counts come from real `anthropic/claude-opus-5.5` calls on OpenRouter (`wire.mjs --openrouter`, in a container with the key at `/key`). |
| D terminal-bench | `bench/terminal-bench/prepare.sh`, then `bench/terminal-bench/run.sh <pi-kit\|claude-code\|codex> <model> [harbor run args]` | Terminal-Bench 4.0 through Harbor on rootless Podman, real models via OpenRouter. See below. |
| E orchestration | `node bench/orchestration/run.mjs` ([README](orchestration/README.md)) | One orchestration task set (review, fan-out, implement-and-review, restart) under Claude Code and Pi with the kit on several models, each run in its own polygon container on the polygon's logins: structural success, wall time, tokens, cost, agents launched. Spends subscription usage, and OpenRouter dollars for `pi-opus-or`. |

## Lane D: Terminal-Bench

Everything bills to the OpenRouter key in `~/.config/pi-kit-bench/openrouter.key` (`OPENROUTER_KEY_FILE` points elsewhere), never a subscription login.

- `pi-kit` is Harbor's Pi agent (`pi_kit_agent.py`) on Pi's checked Bun release binary, with this checkout's HEAD installed as a package. `prepare.sh` stages both (`PI_VERSION` picks another Pi, `PI_KIT_STAGE` another stage dir).
- `claude-code` is Harbor's built-in agent with `ANTHROPIC_BASE_URL` on OpenRouter.
- `codex` is `CodexOpenRouter` (`codex_agent.py`), a subclass of Harbor's Codex agent pinned to CLI 0.160.1 with an OpenRouter provider on the Responses API. Pass any OpenRouter id (`openai/gpt-6.1-sol`).
- `TB_DATASET` and `HARBOR_VERSION` override the dataset (`terminal-bench/terminal-bench@4.0.0`) and Harbor (0.24.0).
- `smoke.sh [timeout multiplier] [job suffix]` runs a 5-task pi-kit vs Claude Code smoke (`MODEL` picks the model). `summarize.py <job-dir>...` prints reward, tokens, OpenRouter cost and time per trial. `or-usage.sh` prints the key's usage and limit, never the key. `image_sizes.py` sizes a dataset's images.

## The README scoreboard

[scoreboard.svg](scoreboard.svg) comes from a bigger wave than lane D: Terminal-Bench 4.0 plus a held-out DeepSWE v1.1 sample, Pi + kit vs plain Pi vs Claude Code (Opus 5.5) and Codex (GPT-6.1 Sol), k=1 with a 20 min cap, all on OpenRouter, every trial audited for cheating. That harness (a plain-Pi Harbor agent, multi-service networking for TB tasks, the DeepSWE runner and the row builders) isn't in this branch yet: it lives on a local `bench/bench3` branch and in my scratch space. DeepSWE task names stay held out, so only aggregates get published.
