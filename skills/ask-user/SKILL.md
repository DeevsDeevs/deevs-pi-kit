---
name: ask-user
description: "When and how to ask with ask_user: decision gates before irreversible steps, question and option shape."
---

# Ask User

Collect explicit user input through the interactive `ask_user` overlay before an irreversible or destructive step. A decision gate, not general conversation.

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
  "context": "The migration rewrites the users table; the newest backup is from 02:00.",
  "questions": [
    {
      "id": "users-migration",
      "question": "How should the users table migration run?",
      "options": [
        { "title": "Rewrite in place", "description": "Fast; rollback needs the 02:00 backup" },
        { "title": "Copy to a new table", "description": "Slower; the old table stays until you drop it" }
      ],
      "allowFreeform": true
    }
  ]
}
```

## Question quality

"Drop the legacy `users` table now, or keep it until the migration is verified?" beats "Any thoughts?". One decision per question; never ask the user to repeat facts present in the repo; state your recommendation when evidence points clearly one way.

Use `ask-user` to collect explicit choices during implementation; use `grill-me` for the broader one-question-at-a-time pressure test before a plan is ready.
