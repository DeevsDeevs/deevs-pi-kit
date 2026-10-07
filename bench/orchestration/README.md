# Orchestration bench

The same orchestration task under different harness + model configs, measured the same way. Every run is one polygon container (`polygon/Containerfile`'s image) with its own HOME; the logins come only from the polygon's `pi-kit-polygon-login` volume, mounted read-only and copied into the container with dead refresh tokens, so a run can never rotate or log out the volume and no credential reaches the host or the results.

```bash
node bench/orchestration/run.mjs --configs cc-opus --reps 2 --parallel 5 --run cc-baseline   # every task
node bench/orchestration/run.mjs --tasks t2 --configs pi-opus,pi-sol --run pi-final
node bench/orchestration/run.mjs --tasks t1u,t2u,t4u --configs pi-sol,pi-opus --kit '{"autonomy": false}' --run unprompted-off
node bench/orchestration/run.mjs --summarize cc-baseline --out <file>                        # chart-ready summary.json
node bench/orchestration/run.mjs --models     # token expiries and Pi's model list, from the volume
node bench/orchestration/run.mjs --freshen    # the polygon's freshen step: refresh the volume's tokens
```

`node bench/orchestration/inside.mjs --remeasure <run dirs>` recomputes a finished run's metrics on the host from its saved transcripts, and re-judges t1 (no repo needed) and, with `BENCH_PRISTINE=<export of 4080d62>`, t2, t4 and t5; `repo.patch` holds every run's changes for replaying t3's check.

A run directory that already holds `result.json` is skipped, so re-invoking a run resumes it. Scheduling stops at the first `quota` (a Claude `rate_limit_event` rejected) or `no-login` (the staged access token would expire inside the run's time box).

## Tasks

All run on a `git archive` export of this repository (history-free, `AGENTS.md` removed so no harness sees repo instructions the other does not). The prompt is identical across configs and ends with the same rules: no human, delegate to subagents, wait for all of them, write `.bench/result.json`.

| Task | Commit | Structural success |
|---|---|---|
| t1 multi-agent review | `e020683^` | a schema-valid finding at either site of the bug `e020683` fixed: `messaging.ts` 185-225 (the inbox page is marked read) or `protocol.ts` 112-132 (the oversized response is then replaced by an error); `fix_file_hit` says whether the fixed file itself was named |
| t2 fan-out summary | `4080d62` | all 13 extension modules present once, schema-valid; `ts_files` exactness against the checkout is reported |
| t3 implement-and-review | `4080d62`, regex un-fixed | a hidden vitest file passes, tests the agents changed pass, `approved` with 1-3 review rounds |
| t4 44-agent fan-out | `4080d62` | all 44 test files present, schema-valid; `tests` exactness against a regex count is reported |
| t5 restart | `4080d62` | t2, with the lead SIGKILLed 12 s after its first agent launch and resumed (`claude -p --resume`, `pi --continue`) with one fixed resume prompt |
| t1u, t2u, t4u unprompted | as t1, t2, t4 | t1, t2 and t4 judged the same way, with every sentence that asks for subagents or opts in to Workflow removed from the task and the closing rules; `orchestrated` says whether the lead started any Agent or Workflow on its own |

The unprompted tasks run only when `--tasks` names them. Run them with autonomy on and off (`--kit`) to see how often each model fans out by itself, and t1u's hit rate as the review-quality signal.

## Configs

| Config | Lead | Subagents |
|---|---|---|
| `cc-opus` | `claude -p --model claude-opus-5-5 --output-format stream-json`, the volume's Claude login | Claude Code's Agent and Workflow tools (inherit Opus) |
| `pi-sol` | Pi + kit over RPC, `openai/gpt-6.1-sol`, the volume's ChatGPT login | the kit's Agent (inherits the lead) |
| `pi-opus` | Pi + kit over RPC, `anthropic/claude-opus-5-5`, the volume's Anthropic OAuth login | the kit's Agent |
| `pi-opus-or` | Pi + kit, OpenRouter (`~/.config/pi-kit-bench/openrouter.key` mounted read-only, read into the container's env) | the kit's Agent |

`--kit '<json>'` merges a JSON object into every Pi run's global `pi-kit.json` (for example `{"autonomy": false}`); `result.json` records it as `kit`, and the summary keys such a run's cell as `<config> <kit>`, so run sets with different settings summarize side by side.

`claude -p` with a background Workflow or Agent does not exit at the end of the turn: it waits for the background tasks, answers their notifications in new turns, and exits after the last one.

## Metrics

`result.json` per run, `summary.json` per run set (`runs[]` flat rows and `matrix[task][arm]` medians, where the arm is the config plus any `--kit`). Wall time; lead context tokens at the end (Claude: the last lead message's input + cache + output; Pi: `get_session_stats` `contextUsage`); total tokens (Claude: every transcript of the session, lead and subagents, one usage per API message; Pi: `get_session_stats` plus the `<usage>` the kit's notifications report); cost (subscription runs carry the harness's list-price estimate only; OpenRouter runs are dollars); agents launched and failed; runs that started any Agent or Workflow (`orchestrated`) and workflows started; notifications; compactions; restarts; user relays (dialogs answered by the harness; always 0 for `claude -p`).
