# arXiv

Search arXiv through the official Atom API. Use it for paper discovery, abstract-level triage, exact ID lookup, and BibTeX generation.

## Tools

```text
arxiv_search   search by query, title, author, abstract, or category
arxiv_get      fetch metadata and abstracts for arXiv IDs
arxiv_bibtex   generate simple BibTeX entries
```

## Limits

- no API key required
- no PDF download or arbitrary URL fetching
- bounded result counts and request timeout
- polite in-process throttle

arXiv papers are preprints. Treat results as leads, not peer-reviewed truth.
