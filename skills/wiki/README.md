# Wiki Skill

Agent-facing workflow for building and maintaining curated markdown knowledge bases.

Main instruction file: [`SKILL.md`](SKILL.md).

## When it applies

Use the wiki skill when the user asks to:

- create a project/domain wiki
- ingest durable sources into markdown notes
- answer questions from an existing wiki
- lint/audit wiki health
- promote stable chain findings into canonical knowledge

## Core idea

A wiki is curated knowledge, not a transcript dump.

- **Chains** preserve chronological work/session handoff.
- **Wiki pages** preserve canonical facts, concepts, entities, comparisons, and filed answers.
- **Sources** preserve external/pasted artifacts when needed for provenance.

## Standard layout

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

For codebase wikis, cite repo files directly; do not copy the whole codebase into `sources/`.

## Extension support

The companion extension lives at [`extensions/wiki`](../../extensions/wiki/README.md) and provides:

```text
wiki_init
wiki_status
wiki_lint
wiki_graph
wiki_search
wiki_context
```

The extension handles deterministic mechanics. The skill handles curation judgment.
