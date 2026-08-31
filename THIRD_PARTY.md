# Third-party design and source references

`deevs-pi-kit` prefers behavior-level reimplementation. Any copied or substantially adapted source must add a row identifying the exact source path and retained notice before merge.

| Project | Commit | License | Intended reference |
| --- | --- | --- | --- |
| `pi-subagents` | `e658b40fe72d599df231b5d59ffec40d66f576fa` | MIT | Child protocol, isolated execution, recovery, settlement, and wait semantics |
| `pi-dynamic-workflows` | `31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2` | MIT | Trusted workflow parser, runtime, and display behavior |
| OpenAI Codex Goals | `f69f88f8116f541daddada3a056de5772a891f15` | Apache-2.0 | Mission admission, idle continuation, accounting, and tests |
| Kimi Code | `f06eb5c60e0a4e51162d1854dda1db41892b457c` | MIT, Copyright (c) 2026 Moonshot AI | Goal/task reducers, agent resume, terminal delivery, scheduling semantics, and compact TUI patterns |
| Legacy Kimi CLI | `4a550eff` | Apache-2.0 with Moonshot `NOTICE` | Supplemental durable background and notification behavior |
| `dmmulroy/anti-slop` | `6d538555cb151d4121ed51a27db81890eacf8ae9` | MIT | Vendored Oxlint plugin under `tools/oxlint/anti-slop/` |

## Adapted source map

| Local path | Upstream path | Notes |
| --- | --- | --- |
| `extensions/subagents/protocol.ts` | `pi-subagents/src/runs/shared/child-protocol.ts` at `e658b40fe72d599df231b5d59ffec40d66f576fa` | Reduced bounded JSONL line reader and UTF-8 byte tail; MIT attribution retained in source |
| `extensions/cron/cron.ts` | `kimi-code/packages/agent-core-v2/src/app/cron/{cron-expr.ts,jitter.ts,format.ts}` at `f06eb5c60e0a4e51162d1854dda1db41892b457c` | Adapted five-field parser, local-time next-run, deterministic jitter, and fire-envelope behavior; MIT attribution retained in source |
| `tools/oxlint/anti-slop/**` | `dmmulroy/anti-slop/src/**` at `6d538555cb151d4121ed51a27db81890eacf8ae9` | Vendored by the upstream installer; provenance and license retained in the vendored directory |

The retained MIT notice for adapted source is in `THIRD_PARTY_NOTICES.md`.

`agent-system` is a legacy migration reference only. Curated personas, workflow and review contracts, runtime, and UI are owned by this repository.
