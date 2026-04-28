---
name: codebase-orientation
description: Map an unfamiliar code area before editing. Use when the user asks to "orient me", "zoom out", "map this area", asks where something fits, or when a safe next action requires understanding multi-file, module, crate, or subsystem relationships.
---

# Codebase Orientation

Use this skill before acting in unfamiliar code. Build the smallest accurate map that makes the next action safe.

This is for orientation, not diagnosis or architecture critique. If there is a concrete failing symptom, use orientation only long enough to find the relevant area, then switch to `diagnose`.

## Orientation contract

Bound the map before exploring:

```text
Target: [feature/module/crate/error path]
Scope: [repo root + allowed dirs]
Question: [what the map must answer]
Stop when: [next safe action is clear]
```

If scope is unclear, ask one scope question. Do not map the whole repo by default.

## Operating loop

1. **Find repo shape and rules** — project instructions, package/workspace layout, entrypoints, docs, tests, scripts.
2. **Trace the relevant path** — from user-visible trigger or public API to the code that matters.
3. **Name the core concepts** — types, traits, modules, services, state, invariants.
4. **Find callers and callees** — enough to understand impact, not every reference.
5. **Find validation hooks** — narrow build/test/check commands and fixtures.
6. **Stop and summarize** — produce a map plus recommended next step.

Keep searches bounded. Prefer `rg`, `find`, package metadata, and obvious entrypoints over broad recursive wandering.

Source-of-truth order: source code, tests, config, and CI beat project docs; project docs beat chains/wiki; chains/wiki are reference context only. Mark uncertainty instead of smoothing over conflicts.

## Pi-native workflow

- Use `read` for relevant source/docs/project instructions.
- Use `bash` for bounded `rg`, `find`, package metadata, and test discovery.
- Use `agent_start` only when the area spans enough files that a bounded read-only map would help; give explicit `cwd`, paths, exclusions, and output shape.
- Use `agent_read` for normal subagent output; use `agent_logs` only to debug stuck/failed/confusing subagent behavior.
- Use a small Mermaid diagram only when it materially reduces prose.
- Use `chain_save` only when the orientation map is likely useful future context.

## Rust orientation checklist

For Rust repos, inspect only what is relevant:

- workspace and crate boundaries: `Cargo.toml`, `cargo metadata --no-deps`, members, features
- project command conventions: README, AGENTS.md, Justfile/Makefile, CI config
- crate entrypoints: `lib.rs`, `main.rs`, `mod.rs`
- public API and internal module tree
- important structs/enums/traits and their impls
- ownership/state sharing: `Arc`, locks, caches, globals, task-local state
- async boundaries, spawned tasks, channels, retries, timeouts
- error types/conversions and `Result` flow
- feature flags and `cfg` gates
- tests: unit modules, integration tests, fixtures, snapshots, `nextest` filters
- narrow commands: `cargo check -p`, `cargo test -p <crate> <filter>`, `cargo nextest run -p <crate> <filter>`

Do not run expensive full-workspace checks unless the user asks or narrower checks are impossible.

## Output format

Compress small orientations. Do not fill empty headings.

```text
What this area does
- ...

Main files/crates/modules
- path — why it matters

Entrypoints
- ...

Important types/traits/contracts
- ...

Call/data flow
- ...

State and invariants
- ...

Validation hooks
- command/test/fixture — what it proves

Risks before editing
- ...

Recommended next step
- ...
```

Include file paths. Distinguish facts from inferences.

## Non-goals and pitfalls

Do not:

- implement changes during orientation
- diagnose root cause unless a reproducible symptom exists
- perform architecture critique by default
- produce a giant repo map
- ask the user for facts you can read cheaply
- blindly trust docs when source disagrees
- hide uncertainty

A list of files is not an orientation; explain why each file matters.
