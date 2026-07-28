---
name: ask-user
description: Use the interactive ask_user UI when 1-5 concrete clarifications or decisions materially affect implementation, scope, safety, or acceptance criteria. Gather evidence first; do not ask what tools can answer.
---

# Ask User

Collect explicit user input through the interactive `ask_user` overlay before making material assumptions. A clarification and decision gate, not general conversation. The UI supports searchable option lists, descriptions, context display, freeform answers, and batched questions with progress tabs (`←`/`→` switch in option-list mode).

## When to use

Call `ask_user` — instead of asking inline — with 1–5 focused questions when at least one holds:

- requirements or acceptance criteria are ambiguous
- multiple valid paths exist and the trade-off is preference-dependent
- the next step changes architecture, schema, API contracts, deployment, security, or destructive behavior
- scope must be cut or prioritized, or you are about to assume something material

Not when a file, command, test, chain, or existing context can answer; the choice is trivial polish; asking only defers obvious work; or the user already decided.

## Protocol

1. Gather evidence first — never ask blind.
2. Batch related questions into one call (usually 1–3, never more than 5), each decision-shaped: one concrete choice or missing fact.
3. Offer 2–5 short options with trade-off descriptions when helpful; allow freeform unless the answer must be one of the options.
4. After the tool returns, restate the decisions and proceed.
5. On cancel: for high-stakes or irreversible choices, stop and say what decision is required; for low-risk ambiguity, proceed only if the user explicitly delegated the choice, else ask inline.

## Payload shape

```json
{
  "context": "The notifier can rely on terminal sequences only, or retain native fallbacks.",
  "questions": [
    {
      "id": "notification-path",
      "question": "Which notification path should the plugin ship with?",
      "options": [
        { "title": "Terminal protocols only", "description": "Simpler; relies on terminal config" },
        { "title": "Keep macOS fallback", "description": "More reliable on macOS, less terminal-native" }
      ],
      "allowFreeform": true
    }
  ]
}
```

## Question quality

"Which storage model should v1 use?" beats "Any thoughts?". One decision per question; never ask the user to repeat facts present in the repo; state your recommendation when evidence points clearly one way.

Use `ask-user` to collect explicit choices during implementation; use `grill-me` for the broader one-question-at-a-time pressure test before a plan is ready.
