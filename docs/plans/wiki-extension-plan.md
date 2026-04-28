# Wiki Extension Plan

## Status
Initial MVP implemented for Phase 1-3: `wiki_init`, `wiki_status`, `wiki_lint`, `wiki_graph`, `wiki_search`, and `wiki_context`. This is a deterministic companion to `skills/wiki/SKILL.md`, not a RAG system, graph database, plugin marketplace, or automatic wiki writer.

A rereview subagent group was attempted (`g_moiwoz23_4`) but produced no final useful output and was cancelled. This plan is the tightened version after manual rereview of the proposal.

## Goal

`skills/wiki` teaches the model the curation workflow. `extensions/wiki` should provide safe deterministic primitives for a normal markdown wiki:

- initialize the standard structure
- inspect status
- lint links/frontmatter/index health
- build an explicit graph from `[[wikilinks]]`
- search pages using ranked/text/regex modes
- pack bounded wiki context for the parent agent or subagents

It should not synthesize pages by itself. Page writing remains model/user-directed through normal `write`/`edit` unless a later tool has a very narrow deterministic purpose.

## Non-goals

- No graph database.
- No embeddings/vector DB.
- No automatic source ingestion from URLs in MVP.
- No automatic mass rewrites or "fix all".
- No web dashboard.
- No global wiki created silently.
- No provider/plugin marketplace.

## Storage model

Use a plain markdown directory:

```text
wiki/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
├── entities/
├── concepts/
├── comparisons/
└── queries/
```

MVP should be project-local by default. Tools should take an explicit `path` and resolve it relative to the current project cwd. Avoid defaulting to `~/wiki`.

## Safety model

Implement a `WikiService` path resolver with guardrails similar to chains:

- resolve against cwd
- reject symlink wiki roots
- reject path traversal outside allowed root
- for existing wiki roots, use `realpath` containment checks
- for init on a new path, validate the nearest existing parent and then create only the requested directory tree
- refuse to initialize into a non-empty directory unless `force`/`overwrite` is explicitly supported later; MVP should avoid force
- bound all file reads and output sizes
- scan only markdown under known wiki dirs by default
- ignore `node_modules`, `.git`, and hidden/cache dirs if a user points at a broad path
- regex mode is opt-in and bounded by query length, max files, and max matches
- no URL fetching in MVP

Subagents should not receive wiki write tools by default. If subagents need wiki knowledge, the parent should call `wiki_context` and pass the packed block, or a later `wikiContext` parent-loaded handoff can mirror `chainContext`.

## Wikilink parsing rules

Parse Obsidian-style wikilinks from markdown body after stripping YAML frontmatter and fenced code blocks:

- `[[page]]`
- `[[page|alias]]`
- `[[folder/page]]`
- `[[page#heading]]`
- `![[asset.png]]` should be treated as an asset reference, not a page edge unless it points to markdown
- `[[#heading]]` is a local anchor, not a graph edge

Node id should be the wiki-relative path without `.md`, e.g. `concepts/chain-context`.

Resolution order:

1. exact wiki-relative path if target includes `/`
2. same-directory page match
3. unique basename match across wiki pages
4. otherwise mark as `broken` or `ambiguous`

Graph output should include broken and ambiguous links separately.

## Types / APIs

### Shared input fields

Most tools use:

```ts
interface WikiPathInput {
  path: string;       // explicit path to wiki root, relative to cwd or absolute if allowed later
  maxBytes?: number;  // output/context cap where relevant
}
```

Do not make `path` optional in MVP. Convenience discovery can come later after config exists.

### `wiki_init`

Create starter structure and files.

```ts
interface WikiInitInput {
  path: string;
  domain: string;
  title?: string;
  dryRun?: boolean;
}
```

Behavior:
- validates target path
- refuses non-empty target
- creates standard dirs
- writes compact starter `SCHEMA.md`, `index.md`, `log.md`
- returns created paths

No `force` in MVP.

### `wiki_status`

Fast overview.

```ts
interface WikiStatusInput {
  path: string;
  maxIssues?: number;
}
```

Returns:
- core files present/missing
- page count by type/dir
- raw source count
- latest log heading if present
- graph summary: nodes, edges, broken links, orphans, ambiguous links
- top warnings, bounded by `maxIssues`

### `wiki_lint`

Deterministic health report.

```ts
interface WikiLintInput {
  path: string;
  maxIssues?: number;
  includeWarnings?: boolean;
}
```

Checks:
- missing core files/dirs
- broken wikilinks
- ambiguous wikilinks
- orphan pages
- pages missing from `index.md`
- index entries pointing to missing pages
- missing required frontmatter fields
- unknown tags compared to `SCHEMA.md` taxonomy when parseable
- raw file hash drift when raw frontmatter has `sha256`
- very long pages as warning only
- `confidence: low` / `contested: true` pages as review notices

This tool reports; it does not mutate.

### `wiki_graph`

Build the explicit graph from wikilinks.

```ts
interface WikiGraphInput {
  path: string;
  includeOrphans?: boolean;
  includeBacklinks?: boolean;
  maxNodes?: number;
  maxEdges?: number;
}
```

Result shape:

```ts
interface WikiGraphNode {
  id: string;
  path: string;
  title: string;
  type?: string;
  tags: string[];
}

interface WikiGraphEdge {
  from: string;
  to: string;
  raw: string;
}
```

Also return `orphans`, `brokenLinks`, and `ambiguousLinks`.

### `wiki_search`

Universal search like `chain_search`.

```ts
interface WikiSearchInput {
  path: string;
  query: string;
  mode?: "lookup" | "text" | "regex";
  maxResults?: number;
  contextLines?: number;
  caseSensitive?: boolean;
}
```

Modes:
- `lookup` default: dependency-free BM25-style ranked lookup over page title/frontmatter/body
- `text`: exact text snippets
- `regex`: opt-in JavaScript regex snippets with caps

Implementation should either extract shared search utilities from `extensions/chains/service.ts` or keep a small local copy initially and refactor after tests pass. Prefer shared utilities if the change stays simple.

### `wiki_context`

Pack bounded context for a task.

```ts
interface WikiContextInput {
  path: string;
  query?: string;
  pages?: string[];
  searchMode?: "lookup" | "text" | "regex";
  maxPages?: number;
  includeBacklinks?: boolean;
  includeForwardLinks?: boolean;
  maxBytes?: number;
  compact?: boolean;
}
```

Behavior:
- includes a short schema/index orientation excerpt
- includes explicitly requested pages and/or top search hits
- optionally includes backlink/forward-link snippets
- marks the block as reference context, not instructions
- respects `maxBytes`

### Deferred `wiki_promote_chain` design

Promotion means turning stable chain history into curated wiki knowledge. It must not dump chain links into pages or auto-write canonical truth.

Future tool shape should be suggest-first:

```ts
interface WikiPromoteChainInput {
  path: string;
  chain: string;
  branch?: string;
  link?: string;
  query?: string;
  maxCandidates?: number;
}
```

Expected result:
- candidate pages to create or update
- durable facts/decisions worth promoting
- stale/session-only items to ignore
- existing wiki pages that may already cover the topic
- suggested sources pointing back to `.chains/...`
- proposed log entry

Workflow:
1. Load chain context with `chain_context` / chain service.
2. Inspect wiki with `wiki_search` and `wiki_graph`.
3. Extract only durable decisions, APIs, architecture, conventions, and pitfalls.
4. Reject temporary next steps, failed attempts, stale TODOs, and raw session chatter.
5. Return suggestions; the model/user performs deliberate `write`/`edit`.

Do not implement as an auto-writer until real usage proves the UX.

### Defer `wiki_log`

Do not include `wiki_log` in MVP. Appending to `log.md` is easy with `edit`, and a tool would add another write surface. Reconsider later if log formatting becomes inconsistent.

### Defer page/source write tools

Defer:
- `wiki_add_source`
- `wiki_page_create`
- `wiki_index_update`
- `wiki_fix_links`
- `wiki_promote_chain`

These can cause broad writes or need UX decisions. The MVP can report and scaffold; the model performs deliberate edits.

## Commands

MVP commands mirror read/status tools plus init:

```text
/wiki:init <path> --domain "..."
/wiki:status <path>
/wiki:lint <path>
/wiki:graph <path>
/wiki:search <path> [--lookup|--text|--regex] <query>
/wiki:context <path> <query>
```

No `/wiki` dashboard in MVP.

## File structure

```text
extensions/wiki/
├── index.ts       # extension registration, duplicate surface guard
├── service.ts     # WikiService, path resolution, scans, graph/search/context
├── tools.ts       # schemas, tool registration, formatters
├── commands.ts    # slash commands
├── parser.ts      # frontmatter, wikilinks, code-fence stripping, slug helpers
├── types.ts       # public input/result types
└── README.md      # concise user docs
```

If search code is shared with chains later:

```text
extensions/shared/search.ts
```

## Subagent integration

Phase 1: parent calls `wiki_context` and includes the result in `agent_start.task` manually.

Phase 2: add optional parent-loaded handoff mirroring `chainContext`:

```ts
wikiContext?: {
  path: string;
  query?: string;
  pages?: string[];
  searchMode?: "lookup" | "text" | "regex";
  includeBacklinks?: boolean;
  maxBytes?: number;
}
```

The parent loads/packs the context before launching the child. Child subagents should still not get wiki write tools by default.

## Phased implementation

### Phase 0: tests and fixtures

Create small temp wiki fixtures for:
- valid wiki
- broken links
- ambiguous links
- orphan page
- missing frontmatter
- index mismatch
- raw hash drift
- symlink/path traversal rejection

### Phase 1: safe read/graph/lint core

Implement:
- `WikiService.resolveRoot()` safety checks
- markdown page discovery under known dirs
- frontmatter parser
- wikilink parser
- `wiki_graph`
- `wiki_lint`
- `wiki_status`

This phase gives deterministic value without many writes.

### Phase 2: init

Implement:
- `wiki_init`
- `/wiki:init`
- starter files
- non-empty refusal
- dry-run

Init is a write surface, so keep it narrow.

### Phase 3: search/context

Implement:
- `wiki_search`
- `wiki_context`
- `/wiki:search`
- `/wiki:context`
- possible shared BM25/text/regex utility with chains

### Phase 4: subagent parent-loaded context

Add `wikiContext` to `agent_start` and per-task `agent_parallel_start`, mirroring `chainContext`.

### Phase 5: optional write helpers, only if needed

Consider narrow helpers after real use:
- append-only `wiki_log`
- `wiki_index_check --suggest` output, not auto-write
- raw local file hash helper

## Validation commands

Expected checks after implementation:

```bash
node_modules/.bin/jiti /tmp/test-wiki.ts
node_modules/.bin/jiti /tmp/test-wiki-security.ts
node_modules/.bin/jiti /tmp/test-wiki-graph.ts
node_modules/.bin/jiti /tmp/test-wiki-search-context.ts
node_modules/.bin/jiti /tmp/test-wiki-surface.ts
bun build extensions/wiki/index.ts --outdir /tmp/deevs-wiki-build \
  --external @mariozechner/pi-coding-agent --external @mariozechner/pi-ai \
  --external @mariozechner/pi-tui --external node-pty
npm pack --dry-run --json
git diff --check
```

## Open decisions before implementation

1. Should MVP allow absolute paths outside the project cwd? Recommendation: no; project-local only until config/consent UX exists.
2. Should `wiki_init` have `force`? Recommendation: no in MVP.
3. Should search code be shared with chains immediately? Recommendation: only if extraction is small; otherwise duplicate briefly and refactor later.
4. Should `wiki_context` include full pages by default? Recommendation: no; compact excerpts plus explicit pages.
5. Should `wiki_lint` parse taxonomy strictly? Recommendation: best-effort initially; report `unknown` only when taxonomy is parseable.
