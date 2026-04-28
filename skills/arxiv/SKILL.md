---
name: arxiv
description: Search, triage, and cite arXiv papers. Use when the user asks for arXiv/preprint/academic paper discovery, recent ML/AI/science papers, paper metadata, abstracts, or BibTeX. Prefer arxiv_* tools over ad-hoc curl.
---

# arXiv Research

Use this skill for arXiv paper discovery and abstract-level triage. The companion extension provides deterministic metadata tools; this skill provides the research workflow and judgment.

## Use the extension first

Prefer:

```text
arxiv_search
arxiv_get
arxiv_bibtex
```

Human commands:

```text
/arxiv:search <query>
/arxiv:get <id>
/arxiv:bibtex <id>
```

Do not hand-roll `curl` unless the extension is unavailable or the user explicitly needs a raw API check.

## When to use

Use when the user asks to:

- find papers or preprints on a topic
- look up a specific arXiv ID
- compare recent work
- collect citations/BibTeX
- identify authors, categories, or abstracts
- save research leads into a chain or wiki

Do not use arXiv alone for:

- citation counts or influence metrics
- peer-review status
- exhaustive literature reviews
- full-paper claims not supported by the abstract/metadata

## Search workflow

1. Convert the user request into 1-3 focused queries.
2. Use `arxiv_search` with small `maxResults` first, usually 5-10.
3. Use category filters when helpful, e.g. `cs.LG`, `cs.CL`, `cs.CV`, `cs.AI`, `stat.ML`.
4. Triage by title, abstract, date, authors, and category.
5. Use `arxiv_get` for exact IDs worth citing.
6. Use `arxiv_bibtex` only when the user needs references.
7. Distinguish abstract-supported claims from hypotheses that need full-paper reading.

## Query tips

Common categories:

```text
cs.AI     artificial intelligence
cs.CL     computation and language / NLP
cs.CV     computer vision
cs.LG     machine learning
cs.CR     cryptography and security
stat.ML   machine learning statistics
math.OC   optimization and control
```

Useful tool shapes:

```json
{ "query": "test time scaling language models", "category": "cs.CL", "maxResults": 5, "sortBy": "submittedDate" }
```

```json
{ "author": "Yann LeCun", "category": "cs.LG", "maxResults": 5 }
```

```json
{ "ids": "1706.03762", "includeBibtex": true }
```

## Reporting format

For paper discovery, return:

```text
Top matches
1. Title — arXiv:id, year/category
   Why it matches: ...
   Caveat: ...
   Link: https://arxiv.org/abs/id

Notable misses / query limits
- ...

Suggested next query
- ...
```

For comparisons, use a table:

```markdown
| Paper | Year | Main idea | Why relevant | Caveat |
| --- | --- | --- | --- | --- |
```

## Provenance and persistence

- Cite arXiv IDs and abs URLs.
- If research affects project decisions, save a chain link with query terms and selected IDs.
- If findings become durable project/domain knowledge, ask whether to add them to the wiki; cite arXiv IDs or saved source notes.

## Guardrails

- arXiv preprints may be wrong, superseded, or not peer reviewed.
- Abstracts are not enough for detailed method claims.
- Do not claim citation counts; the arXiv extension does not provide them.
- Do not download PDFs unless the user asks and an appropriate document/OCR workflow exists.
- Keep searches bounded; broaden only after explaining why.
