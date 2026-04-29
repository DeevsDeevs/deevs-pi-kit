---
name: ask-user
description: Use the interactive ask_user UI when 1-5 concrete clarifications or decisions materially affect implementation, scope, safety, or acceptance criteria. Gather evidence first; do not ask what tools can answer.
---

# Ask User

Use this skill to collect explicit user input through the interactive `ask_user` overlay before making material assumptions.

This is a **clarification and decision gate**, not general conversation. The UI supports searchable option lists, option descriptions, context display, and freeform answers. Batched questions use one overlay with progress tabs; `←`/`→` switch questions in option-list mode.

## When to use

Call `ask_user` — instead of asking inline in normal chat — when you have **1-5 focused questions** and at least one is true:

- requirements, acceptance criteria, or success conditions are ambiguous
- multiple valid implementation paths exist and the trade-off is preference-dependent
- the next step changes architecture, schema, API contracts, deployment, security, or destructive behavior
- scope must be cut or prioritized
- you are about to assume something that would materially affect implementation

Do not use it when:

- a file, command, test, doc, chain, or existing context can answer the question
- the choice is trivial formatting/polish
- asking would only defer obvious next work
- the user already made the exact decision

## Protocol

1. **Gather evidence first** using available tools. Do not ask blind.
2. **Batch related questions** into one `ask_user` call, usually 1-3 questions, never more than 5.
3. **Keep each question decision-shaped**: one concrete choice or missing fact.
4. **Use options when helpful**: 2-5 short choices with trade-off descriptions.
5. **Allow freeform** unless the answer must be one of the provided options.
6. **After the tool returns**, restate the decision/answers and proceed.
7. **If cancelled or incomplete**, stop when the missing answer is high-impact; report what is blocked.

## Good payload shape

```json
{
  "context": "Ghostty config enables desktop notifications and bell audio. The notifier can rely on terminal sequences only, or retain native fallbacks.",
  "questions": [
    {
      "id": "notification-path",
      "question": "Which notification path should the plugin ship with?",
      "options": [
        { "title": "Terminal protocols only", "description": "Simpler; relies on Ghostty/terminal config" },
        { "title": "Keep macOS fallback", "description": "More reliable on macOS, but less terminal-native" }
      ],
      "allowFreeform": true
    }
  ]
}
```

## Question quality

Prefer:

- “Which storage model should v1 use?”
- “Should this be project-local only for MVP?”
- “Which behavior is acceptable when the process is not attached to a TTY?”

Avoid:

- “Any thoughts?”
- multiple unrelated decisions in one question
- asking the user to repeat facts present in the repo
- hiding your recommendation when evidence points clearly one way

## Cancellation policy

If the user cancels:

- For high-stakes or irreversible choices: stop and say what decision is required.
- For low-risk ambiguity only: proceed only if the user explicitly delegated choice elsewhere; otherwise ask inline before continuing.

## Relationship to `grill-me`

- Use `ask-user` to collect explicit choices during implementation.
- Use `grill-me` for a broader one-question-at-a-time pressure test before a plan is ready.
