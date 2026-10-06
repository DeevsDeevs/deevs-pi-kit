---
name: ask-user
description: "Ask the user through ask_user only before an irreversible or destructive choice; otherwise state the assumed default and continue. Gather evidence first."
---

# Ask User

Collect explicit user input through the interactive `ask_user` overlay before an irreversible or destructive step. A decision gate, not general conversation. The UI supports searchable option lists, descriptions, context display, freeform answers, and batched questions with progress tabs (`←`/`→` switch in option-list mode).

## When to use

Call `ask_user` with 1–5 focused questions only when the next step is irreversible or destructive: deleting or overwriting data, rewriting shared history, publishing, deploying, spending money.

For anything else — ambiguous requirements, a preference-dependent trade-off, scope — state the default you assume in one line and continue; the user can redirect. Never when a file, command, test, chain, or existing context can answer, or the user already decided.

## Protocol

1. Gather evidence first — never ask blind.
2. Batch related questions into one call (usually 1–3, never more than 5), each decision-shaped: one concrete choice or missing fact.
3. Offer 2–5 short options with trade-off descriptions when helpful; allow freeform unless the answer must be one of the options.
4. After the tool returns, restate the decisions and proceed.
5. An answer the user types in chat counts. If the dialog is cancelled with no answer, do not take the irreversible step: say which decision it needs and continue with everything else.

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
