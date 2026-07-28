---
name: arxiv
description: Search, triage, and cite arXiv papers. Use when the user asks for arXiv/preprint/academic paper discovery, recent ML/AI/science papers, paper metadata, abstracts, or BibTeX. Prefer arxiv_* tools over ad-hoc curl.
---

# arXiv Research

Use `arxiv_search`, `arxiv_get`, `arxiv_bibtex` (human commands: `/arxiv:search <query>`, `/arxiv:get <id>`, `/arxiv:bibtex <id>`). No hand-rolled `curl` unless the extension is unavailable or the user needs a raw API check.

Use for paper/preprint discovery, exact-ID lookup, comparing recent work, collecting BibTeX, and saving research leads into a chain or wiki. arXiv alone cannot provide citation counts, peer-review status, exhaustive literature reviews, or full-paper claims beyond the abstract.

## Workflow

1. Convert the request into 1–3 focused queries; `arxiv_search` with small `maxResults` (5–10) first.
2. Filter by category when helpful: `cs.AI`, `cs.CL` (NLP), `cs.CV`, `cs.LG`, `cs.CR`, `stat.ML`, `math.OC`.
3. Triage by title, abstract, date, authors, category; `arxiv_get` for IDs worth citing; `arxiv_bibtex` only when references are needed.
4. Distinguish abstract-supported claims from hypotheses needing full-paper reading.

Tool shapes:

```json
{ "query": "test time scaling language models", "category": "cs.CL", "maxResults": 5, "sortBy": "submittedDate" }
{ "author": "Yann LeCun", "category": "cs.LG", "maxResults": 5 }
{ "ids": "1706.03762", "includeBibtex": true }
```

## Reporting

```text
Top matches
1. Title — arXiv:id, year/category
   Why it matches / Caveat / Link: https://arxiv.org/abs/id

Notable misses / query limits
Suggested next query
```

For comparisons use a table: `| Paper | Year | Main idea | Why relevant | Caveat |`.

Cite arXiv IDs and abs URLs. If research affects project decisions, save a chain link with query terms and selected IDs; if findings become durable knowledge, ask whether to add them to the wiki.

## Guardrails

Preprints may be wrong, superseded, or unreviewed; abstracts are not enough for detailed method claims. Never claim citation counts (the extension has none). No PDF downloads unless asked with an appropriate document workflow. Keep searches bounded; broaden only with a stated reason.
