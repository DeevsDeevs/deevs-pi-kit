# Wiki

Deterministic helpers for curated markdown wikis. The extension handles structure, graph checks, search, and context packing; the model still writes and edits pages deliberately.

## Layout

`wiki_init` creates:

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

## Tools

```text
wiki_init     create the standard structure
wiki_status   summarize files, graph health, and top issues
wiki_lint     report link, index, frontmatter, tag, and source issues
wiki_graph    build a graph from [[wikilinks]]
wiki_search   ranked, text, or regex page search
wiki_context  pack bounded wiki context for tasks or subagents
```

All tools require an explicit wiki root path. Paths must stay inside the project.

## Commands

```text
/wiki:init <path> --domain "domain" [--dry-run]
/wiki:status <path>
/wiki:lint <path>
/wiki:graph <path>
/wiki:search <path> [--lookup|--text|--regex] <query>
/wiki:context <path> <query>
```

## Scope

- no URL fetching
- no embeddings or external graph database
- no automatic page/source writers
- no automatic link fixing or mass rewrites
- bounded reads and outputs

Use chains for chronological work history. Use wikis for curated, canonical knowledge.
