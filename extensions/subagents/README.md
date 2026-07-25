# Subagents

Owned curated Pi Kit personas executed through a process-isolated runtime.

## Personas

```text
explorer    targeted code/context reconnaissance
architect   design and migration planning
reviewer    correctness, security, and regression review
tester      validation strategy and coverage gaps
devops      runtime, config, and deployment investigation
python-dev  Python-specific review
cpp-dev     C++ correctness and performance review
rust-dev    Rust correctness and idioms
anti-slop   simplify overbuilt or noisy changes
```

Persona Markdown, metadata, discovery, model/tool/write policy, and tests live in this repository. `agent-system` is legacy and not a runtime dependency.

## Model tools

```text
subagent       fresh run, persistent resume, or bounded parallel group
subagent_wait  status, wait, or cancellation with real settlement
```

## Guarantees

- read-only unless `allowWrite: true` is explicit;
- requested tools may narrow but never broaden persona capability;
- detached worker owns the private Pi child and durable artifacts;
- parent reload restoration, stale-worker reconciliation, bounded JSONL/stderr, partial output, and process-group cancellation;
- persistent agent identity resumes the exact private Pi session in a new run/generation;
- wall, provider-turn, token, and cost enforcement with at most one provider-call token/cost overshoot;
- terminal state is withheld until the child process group actually quiesces;
- stable terminal events, exact per-run usage, grouped completion, user-priority wake admission, and Chain/Mission integration.

Project settings in `.pi/subagents.json` cover allowed/default models, per-persona models, timeout bounds, and group concurrency.
