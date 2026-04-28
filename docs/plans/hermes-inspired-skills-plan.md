# Hermes-inspired Skills Preparation Plan

## Status
First skill draft prepared: `skills/wiki/SKILL.md`. These ports should be Pi-native rewrites, not blind copies from Hermes.

## Source inputs
- Hermes repo: `/Users/deevs/programming/agents/hermes-agent`
- Prior local arXiv work: `/Users/deevs/programming/agents/agent-system/arxiv-search`
- Current package: `/Users/deevs/programming/agents/deevs-pi-kit`
- Recon chain link: `.chains/deevs-pi-kit/2026-04-28-172254115-hermes-plugins-and-plugin-like-skills-analysis.md`

## Porting principles
- Do not copy Hermes skills wholesale. Extract the useful workflow, then rewrite for Pi tools, Pi package layout, and Deevs preferences.
- Prefer compact skills first; add TypeScript extensions only when deterministic tooling materially improves the workflow.
- Keep hard guardrails: explicit paths, no hidden broad writes, bounded output, clear provenance, and subagents read-only by default.
- Every skill should include when to use it, how to orient, exact Pi commands/tools to prefer, and what not to do.
- For larger projects or noisy source ingestion, use subagents deliberately:
  - explorer to map sources and propose structure
  - reviewer to check correctness/provenance
  - anti-slop to reject vague/bloated pages and repeated claims
  - tester when a script/extension is involved
- After each skill is drafted, do a rereview pass before accepting it into the package.

## First four targets

### 1. Wiki / curated knowledge base skill
**Source:** `hermes-agent/skills/research/llm-wiki/SKILL.md`

**Decision:** Port first as a compact Pi skill: `skills/wiki/SKILL.md`.

**Why:** Strong fit. Chains preserve session/work handoffs; a wiki preserves curated, durable knowledge about domains/projects.

**Pi adaptation:**
- Explicit wiki path: ask/confirm or use user-provided env/path. Do not silently default to a global `~/wiki` for writes.
- Keep the good structure:
  - `SCHEMA.md`
  - `index.md`
  - `log.md`
  - `raw/`
  - `entities/`
  - `concepts/`
  - `comparisons/`
  - `queries/`
- Orientation rule before work: read schema, index, recent log, and search existing pages before creating new ones.
- Use provenance markers and source lists.
- Use subagents for huge project/wiki construction:
  - explorer maps source corpus and proposes taxonomy
  - subagents draft independent page candidates
  - reviewer verifies claims and source links
  - anti-slop removes duplicate, vague, or overbroad pages
- Explain relation to chains:
  - chain links = chronological work memory and handoff
  - wiki = curated canonical knowledge
  - stable decisions from chains can be promoted into wiki pages

**TS extension:** `extensions/wiki` initial MVP is implemented and tracked in `docs/plans/wiki-extension-plan.md`: deterministic init/status/lint/graph/search/context helpers, not broad page/source auto-writers.

### 2. Concept diagrams skill
**Source:** `hermes-agent/optional-skills/creative/concept-diagrams/SKILL.md`

**Decision:** Port as a compact static skill, likely `skills/concept-diagrams/SKILL.md`.

**Why:** No dependency burden and high value for architecture/product explanations.

**Pi adaptation:**
- Keep design rules and a minimal template.
- Prefer standalone SVG or HTML-with-inline-SVG artifacts.
- Include guidance for dark/light readability, labels, spacing, grouping, and export paths.
- Avoid copying a gallery wholesale unless it clearly pays rent.

**Possible future TS extension:** probably unnecessary. If later useful, a tiny helper could scaffold an HTML/SVG file, but the skill alone should be enough.

### 3. DuckDuckGo search skill
**Source:** `hermes-agent/optional-skills/research/duckduckgo-search/SKILL.md`

**Decision:** Port-lite as a skill, likely `skills/duckduckgo-search/SKILL.md`.

**Why:** Useful no-API-key fallback when web search is needed and the local `ddgs` CLI/package is available.

**Pi adaptation:**
- Do not install dependencies automatically.
- Check availability first: `command -v ddgs` or Python module check.
- Prefer structured/JSON output when possible.
- Include source/date/citation discipline.
- Make clear this is best-effort public web search, not guaranteed comprehensive research.

**Possible future TS extension:** not initially. A `web_search` extension would need URL safety/SSRF/redirect handling and is out of scope for a simple skill.

### 4. arXiv search skill
**Sources:**
- Hermes: `hermes-agent/skills/research/arxiv/SKILL.md`
- Prior local work: `agent-system/arxiv-search/`

**Decision:** Port-lite using the prior local arXiv work plus Hermes workflow ideas.

**Why:** The user already had an arXiv skill before. This is a good candidate for a polished Pi version.

**Pi adaptation:**
- Reuse/improve the prior local script if it is clean, small, and dependency-light.
- Prefer stdlib/public API access.
- Include query formulation, paper triage, abstracts, links, dates, authors, and citation output.
- Encourage saving durable findings to chain links or the wiki when research becomes project knowledge.

**Possible future TS extension:** maybe `extensions/arxiv` if deterministic search/read tooling is valuable, with typed inputs and bounded results. Start by reviewing the existing `agent-system/arxiv-search` implementation before deciding skill-only vs TS tool.

## Follow-up extension track: local memory

**Source inspiration:** primarily Hermes `plugins/memory/holographic/*`, with selected hygiene ideas from `honcho`, `supermemory`, `openviking`, and `retaindb`.

**Decision:** Add as a separate extension design track after the first four skills. Do not mix it into the skill-port batch.

**Why:** Memory solves a different problem:
- `chains` = chronological work/session handoffs
- `wiki` = curated canonical knowledge base
- `memory` = small reusable facts, preferences, and project conventions

**Likely target:** `extensions/memory/`

**Possible MVP tools:**
- `memory_add` — explicitly save a fact/preference/convention
- `memory_search` — ranked search over saved memories
- `memory_list` — inspect recent or tagged memories
- `memory_remove` — delete by id
- `memory_context` — pack relevant memories for a task within a byte budget

**MVP storage options:**
- Start dependency-free with project-local JSONL plus BM25-style search, reusing chain search ideas.
- Consider SQLite FTS later if the local store grows or if Node runtime support is acceptable.

**Candidate record shape:**

```json
{
  "id": "mem_...",
  "scope": "project",
  "text": "This repo uses bun for extension builds.",
  "tags": ["deevs-pi-kit", "build"],
  "confidence": "high",
  "source": "user|chain|agent",
  "created": "...",
  "updated": "..."
}
```

**Guardrails:**
- Explicit saves only at first; no automatic capture.
- Project-local by default; user/global memory only with explicit scope.
- Do not store injected memory/context back into memory.
- Skip trivial/noisy facts.
- Fenced context injection if/when memory is added to prompts.
- Subagents should receive parent-packed memory context, not broad write access by default.

**Avoid:**
- HRR/holographic complexity in the MVP.
- Cloud/vendor memory providers by default.
- Provider marketplace.
- Automatic every-turn capture.
- Large unbounded memory injection into prompts.

**Future possibilities:**
- `confidence`/`trust` feedback.
- Promote chain decisions into memory.
- Promote stable memory clusters into wiki pages.
- Optional provider adapter interface only after local memory proves useful.

## Not in first batch
- Popular web designs: promising but needs license/provenance review before copying templates.
- Memory extension: promising but separate design track after the first four skills.
- Google Meet, image generation, Langfuse, janitor: later optional extensions after current package hardening.

## First implementation step
Start with the Wiki skill. Draft a compact Pi-native `skills/wiki/SKILL.md`, then run rereview with reviewer + anti-slop before moving to the next skill.
