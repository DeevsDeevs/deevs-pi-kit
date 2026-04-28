# Wiki

Deterministic helpers for curated markdown wikis used with `skills/wiki`.

## Tools

```text
wiki_init     create SCHEMA.md, index.md, log.md, and standard dirs
wiki_status   show core file/page/graph summary and top issues
wiki_lint     report broken links, orphans, index/frontmatter/tag issues
wiki_graph    parse [[wikilinks]] into nodes/edges/backlinks/orphans
wiki_search   ranked/text/regex search over wiki pages
wiki_context  pack bounded wiki context for tasks/subagents
```

All tools require an explicit `path` to the wiki root. MVP paths must stay inside the project cwd.

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

This extension does not write pages, fetch URLs, fix links automatically, or build a graph database. It initializes, inspects, searches, lints, graphs, and packs context. Page curation remains deliberate via normal `write`/`edit` guided by `skills/wiki`.
