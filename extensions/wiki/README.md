# Wiki

Deterministic helpers for curated markdown wikis. The extension handles structure, graph checks, search, and context packing; the model still writes and edits pages deliberately.

## Layout

`init` creates:

```text
wiki/
├── SCHEMA.md
├── index.md
├── log.md
├── sources/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

For codebase wikis, cite repository paths directly instead of copying code into `sources/`. Use `sources/` for immutable external artifacts, notes, transcripts, command outputs, screenshots, diagrams, or chain excerpts.

## Tool

One `wiki` tool with an `action`: `init`, `status`, `lint`, `graph` (from `[[wikilinks]]`), `search` (ranked, text or regex) and `context` (a bounded pack for a task or an Agent). Every call names the wiki root `path`, which must stay inside the project. The tool stays off the model's tool list until the `wiki` skill is loaded (the model reads it, or you run `/skill:wiki`).

## Scope

- no URL fetching
- no embeddings or external graph database
- no automatic page/source writers
- no automatic link fixing or mass rewrites
- bounded reads and outputs

Use chains for chronological work history. Use wikis for curated, canonical knowledge.
