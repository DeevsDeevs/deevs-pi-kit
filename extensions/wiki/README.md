# Wiki

Helpers for curated markdown wikis: layout, graph checks, search and context packs. The model still writes every page itself.

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

Chains are for work history, wikis for knowledge you curate.
