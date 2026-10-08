# arXiv

arXiv search through the official Atom API: find papers, skim abstracts, look up ids, get BibTeX.

## Tool

One `arxiv` tool with `action: "search"` (query, title, author, abstract or category) or `action: "get"` (metadata and abstracts for ids, optionally BibTeX). It stays off the model's tool list until the `arxiv` skill is loaded (the model reads it, or you run `/skill:arxiv`).

## Limits

- no API key required
- no PDF download or arbitrary URL fetching
- bounded result counts and request timeout
- polite in-process throttle

arXiv papers are preprints, so treat results as leads, not peer-reviewed truth.
