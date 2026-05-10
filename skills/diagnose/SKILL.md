---
name: diagnose
description: Run a disciplined debugging loop for broken behavior, failing builds, flaky commands, hung processes, or regressions. Use when the user asks to diagnose, debug, or find root cause.
---

# Diagnose

Use this skill when correctness is uncertain. Do not patch from vibes. Make the bug observable, prove the cause, fix the smallest thing, and verify against the original symptom.

This skill is Pi-native and project-portable: use deevs-pi-kit tools to orchestrate diagnosis, while using the target repo's native build/test/runtime commands as the actual evidence loop.

## 1. Define the symptom

Write the failure as:

```text
Expected: ...
Actual: ...
Observed in: command/log/file/process id/subagent run id/artifact id
```

If the report is vague, ask for the missing observable: exact command, stack trace, process id, subagent run id, artifact id, logs path, screenshot text, or repro steps.

Do not chase unrelated warnings until they connect to this symptom.

## 2. Orient just enough

Before touching code, identify the smallest relevant area:

- repo root and working directory
- package/crate/service/module involved
- entrypoint that triggers the symptom
- closest test, fixture, script, or log source
- expensive commands to avoid by default

For large repos, do not map the whole codebase. Trace only enough callers, data types, config, and state boundaries to build the repro loop.

## 3. Build the feedback loop

Find the fastest deterministic loop that reaches the bug. Prefer project-native commands.

Common Rust loops:

```bash
cargo check -p <crate>
cargo test -p <crate> <test_or_module> -- --nocapture
cargo nextest run -p <crate> <filter>
RUST_BACKTRACE=1 cargo test -p <crate> <filter>
```

Other useful loops:

- focused unit/integration test
- CLI invocation with fixture input and expected output
- service request script against a local dev server
- replay of a captured request, event, trace, or log sample
- small throwaway harness when no existing seam reaches the bug
- benchmark/profiler loop for performance regressions

For long-running servers, watchers, workers, or flaky repro loops, use Pi's `proc_start` and inspect with `proc_read`; never use `&`, `nohup`, `disown`, or `setsid`.

Use subagents only when independent investigation helps. Scope them tightly with `cwd`, exact files/dirs, and explicit exclusions. Use `agent_read` for normal output and reserve `agent_logs` for debugging stuck/failed/confusing runs or deliberate artifact inspection.

For long diagnoses, save durable handoff context with `chain_save`: symptom, repro command, hypotheses tested, files touched, process/subagent ids, and next step.

Do not proceed until the loop reproduces the bug or proves more evidence is needed.

## 4. Reproduce and minimize

Run the loop and confirm it matches the user's symptom, not a nearby failure.

Then reduce:

- smallest file set,
- smallest command,
- smallest input,
- smallest package/crate/service involved,
- shortest log excerpt that proves the problem.

For flaky bugs, raise the reproduction rate: repeat the command, isolate shared state, pin cwd, reduce concurrency where useful, add stress where useful, and record pass/fail counts.

## 5. Hypothesize before probing

For non-obvious bugs, list 3–5 ranked hypotheses before changing code. For obvious failures, state the single likely cause and the check that will confirm it.

```text
Hypothesis 1: [cause]
Prediction: if true, [specific check] will show [specific result].
Probe: [command/read/log inspection]
```

Good hypothesis: “The retry budget is shared across requests; if true, two concurrent fixture calls will exhaust the same counter and logs will show the same budget id.”
Bad hypothesis: “state bug”.

## 6. Probe narrowly

Probe one hypothesis at a time.

- Prefer existing logs, tests, traces, and deterministic reads before adding instrumentation.
- If adding debug output, tag it with a unique marker like `[DEBUG-7f3a]`.
- Never “log everything”. Probe decision boundaries.
- Change one variable per probe.
- Keep notes: hypothesis → probe → result → next hypothesis.

For Rust specifically, useful probes often include:

- `RUST_BACKTRACE=1` or targeted `RUST_LOG=<module>=debug`
- focused assertions in the smallest relevant test
- inspecting trait impl selection, feature flags, cfg gates, and error conversions
- checking ownership/state sharing through `Arc`, locks, caches, globals, or task-local state
- comparing behavior with/without concurrency, retries, timeouts, or feature flags

For performance regressions, measure before fixing. Establish baseline command, input, sample size, and variance; then bisect or profile.

## 7. Fix with a regression guard

Before editing, state the minimal fix and what will prove it.

After editing:

- rerun the minimized loop,
- rerun the original loop,
- run the narrowest relevant package/workspace checks,
- add or update a durable regression check when there is a good test seam.

If no good test seam exists, say so and recommend the smallest future validation improvement.

## 8. Cleanup and report

Before declaring done:

- remove temporary `[DEBUG-...]` probes,
- stop/clear unneeded background processes,
- reference useful logs/artifacts by id/path,
- summarize root cause, fix, verification, and remaining risk.

Final report:

```text
Root cause
- ...

Fix
- ...

Verified
- ...

Remaining risk / follow-up
- ...
```

## Pitfalls

- Do not patch before reproducing unless the user explicitly accepts a speculative fix.
- Do not run the whole workspace when a package/crate-level loop proves the symptom.
- Do not trust a passing narrow check until the original repro also passes.
- Do not leave debug logs or throwaway harnesses hidden in the repo.
- Do not call broad subagent searches “diagnosis”; bound cwd, files, and tool count.
