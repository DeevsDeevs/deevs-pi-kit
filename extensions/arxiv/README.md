# arXiv Extension

Deterministic arXiv metadata search using the official `export.arxiv.org` Atom API.

No API key, no dependencies, no PDF scraping. This extension is for discovery, abstract-level triage, exact-paper lookup, and BibTeX generation.

## Tools

```text
arxiv_search   search by query/title/author/abstract/category
arxiv_get      fetch exact papers by arXiv id
arxiv_bibtex   generate simple BibTeX from official metadata
```

## Commands

```text
/arxiv:search [--max N] [--sort relevance|submittedDate|lastUpdatedDate] [--category cs.LG] [--author name] <query>
/arxiv:get [--bibtex] <id[,id]>
/arxiv:bibtex <id[,id]>
```

## Examples

```json
{ "query": "retrieval augmented generation", "category": "cs.CL", "maxResults": 5, "sortBy": "submittedDate" }
```

```json
{ "ids": "1706.03762,2402.03300", "includeBibtex": true }
```

## Scope and safety

- fixed host: `https://export.arxiv.org/api/query`
- request timeout: 15 seconds
- polite in-process throttle: about one request every 3 seconds
- `maxResults` capped at 25
- ID lookup capped at 25 ids
- no arbitrary URL fetching
- no Semantic Scholar/citation API in the MVP
- no PDF download or full-paper extraction

arXiv papers are preprints. Treat results as research leads, not validated truth.
