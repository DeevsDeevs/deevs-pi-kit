# Wiki Extension

Deterministic helpers for curated markdown wikis used with [`skills/wiki`](../../skills/wiki/SKILL.md).

The extension provides safe mechanics; the skill provides the curation workflow. It does **not** auto-write wiki pages from vibes.

## Wiki layout

`wiki_init` creates:

```text
wiki/
├── SCHEMA.md           # domain, conventions, tag taxonomy, page thresholds
├── index.md            # catalog of pages with one-line summaries
├── log.md              # material change log
├── sources/            # immutable saved source artifacts
│   └── assets/         # images/binaries used by pages
├── entities/           # people, orgs, repos, APIs, products, models
├── concepts/           # techniques, ideas, components, patterns
├── comparisons/        # side-by-side analyses
└── queries/            # filed answers worth keeping
```

For codebase wikis, do **not** copy the codebase into `sources/`. Cite repo paths directly in page frontmatter, for example:

```yaml
sources:
  - extensions/wiki/service.ts
  - skills/wiki/SKILL.md
```

Use `sources/` for pasted notes, external articles, PDFs, transcripts, command outputs, screenshots, diagrams, and chain excerpts that need immutable provenance.

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

### `wiki_init`

```json
{ "path": "wiki", "domain": "deevs-pi-kit internals", "dryRun": true }
```

Creates the standard structure. Refuses non-empty target directories. Use `dryRun` first when uncertain.

### `wiki_status`

```json
{ "path": "wiki", "maxIssues": 10 }
```

Returns core file/dir presence, page counts, saved source count, graph summary, latest log entry, and top lint issues.

### `wiki_lint`

Checks:

- broken `[[wikilinks]]`
- ambiguous links
- orphan pages
- pages missing from `index.md`
- stale index entries
- missing frontmatter fields
- tags not present in `SCHEMA.md` taxonomy when parseable
- source hash drift when `sha256` exists
- low-confidence/contested/very long pages

Reports only. It does not mutate files.

### `wiki_graph`

Builds an explicit graph from Obsidian-style links:

```text
[[page]]
[[page|alias]]
[[folder/page]]
[[page#heading]]
```

It skips local anchors and non-markdown assets. Output includes nodes, edges, backlinks, orphans, broken links, and ambiguous links.

### `wiki_search`

Universal search:

```json
{ "path": "wiki", "query": "subagent context" }
{ "path": "wiki", "query": "exact phrase", "mode": "text" }
{ "path": "wiki", "query": "chain(Context|_context)", "mode": "regex" }
```

Default mode is dependency-free ranked lookup. `text` is literal exact matching. `regex` is opt-in and bounded.

### `wiki_context`

```json
{
  "path": "wiki",
  "query": "wiki extension graph",
  "includeBacklinks": true,
  "includeForwardLinks": true,
  "maxBytes": 12000
}
```

Packs schema/index orientation, selected/search-hit pages, snippets, and optional link context. Use this before delegating wiki-aware work to subagents.

## Commands

```text
/wiki:init <path> --domain "domain" [--dry-run]
/wiki:status <path>
/wiki:lint <path>
/wiki:graph <path>
/wiki:search <path> [--lookup|--text|--regex] <query>
/wiki:context <path> <query>
```

## Scope and safety

- explicit path required
- project-local paths only in MVP
- symlink wiki roots rejected
- no URL fetch
- no graph database
- no embeddings/vector DB
- no automatic page/source writers
- no automatic link fixing or mass rewrite
- bounded reads and outputs

Page curation remains deliberate via normal `write`/`edit` guided by `skills/wiki`.

## Relationship to chains

- `chain_*`: chronological work handoff and session history
- `wiki_*`: curated canonical knowledge and graph health

Future `wiki_promote_chain` should be suggest-first: identify stable facts from chain links and propose pages/updates, not auto-write them.
