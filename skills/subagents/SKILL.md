---
name: subagents
description: Use owned curated Pi Kit personas for bounded exploration, review, testing, architecture, devops, language-specific review, and anti-slop passes.
---

# Subagents

Use `subagent` and `subagent_wait`. Pi Kit owns the persona catalog, policy, isolated executor, artifacts, resume identity, limits, and UI.

## Delegate when useful

- `explorer`: targeted non-trivial reconnaissance before editing.
- `reviewer`: fresh independent correctness/security/regression review.
- `tester`: validation strategy and high-value missing cases.
- `anti-slop`: remove unnecessary complexity after correctness is established.
- `architect`: boundaries, migrations, and design trade-offs.
- `devops`: runtime, process, config, deployment, and log failures.
- `python-dev`, `cpp-dev`, `rust-dev`: language-specific review.

Do not delegate a trivial one-file answer. Use `tasks` for genuinely independent parallel perspectives, never parallel writers in one worktree.

## Scope every run

- Give an explicit `cwd` and exact files/directories/diff range.
- State what not to inspect: parent directories, sibling repos, `node_modules`, `~/.pi`, and unrelated logs.
- Ask for concrete evidence and bounded output.
- Prefer `context: "fresh"` for independent review. Use `context: "fork"` only when parent transcript context is necessary.
- Use `resume` only when the same persistent agent context should receive another turn; re-review is fresh by default.

## Lifecycle

1. Start with `subagent`; background defaults to true.
2. Use one bounded `subagent_wait` call rather than polling.
3. Pass `waitMs: 0` for a status-only projection.
4. Pass `cancel: true` to stop and wait for actual worker/child quiescence.
5. Terminal details include exact per-run usage, bounded output, session identity, and artifacts.

Detached runs are owned by a dedicated worker and can be restored after parent reload. Resume starts a new run/generation in the exact private child Pi session; it does not claim to resurrect a dead process.

## Safety and limits

- Personas are read-only by default and receive `safe_read`, `safe_list`, and `safe_search`, not unrestricted shell execution.
- `allowWrite: true` is valid only when the latest real user message explicitly requested delegated/Subagent writes; it enables the write tools and shell.
- A requested `tools` list can narrow persona capabilities, never broaden them.
- Omitted turn, token, and cost limits are unbounded. Wall time defaults to six hours (24-hour cap); set tighter limits only when the orchestration plan needs them. Token/cost enforcement may overshoot by at most one provider call when explicitly set.
- Subagents cannot spawn nested Subagents.
- Persistent/interactive commands belong in Herdr; bounded non-agent commands belong in Jobs.
