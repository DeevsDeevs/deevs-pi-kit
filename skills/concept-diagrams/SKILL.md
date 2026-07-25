---
name: concept-diagrams
description: Create source-grounded visual explanations such as codebase maps, flows, sequence diagrams, state machines, and architecture views. Prefer compact Mermaid; use SVG/HTML only for polished artifacts.
---

# Concept Diagrams

Use this skill to make a system or idea easier to reason about with the smallest useful diagram. This is visual reasoning, not decorative graphics.

Default to **Mermaid in Markdown**: reviewable, diffable, and easy to edit. Use **standalone HTML/SVG** only when the user asks for a polished file, printable artifact, or geometry Mermaid cannot express.

## When to use

Use when the user asks to diagram, visualize, map, sketch, or explain visually:

- architecture, module boundaries, dependencies
- request/data/control flow
- sequence/protocol/lifecycle behavior
- state machines and failure paths
- concept maps or comparison views
- docs/wiki diagrams grounded in code or research notes

Do not use for decorative graphics, production UI comps, animation/video, unknown systems that need research first, or one giant “everything diagram”.

If diagramming code, inspect relevant files first. For broad unfamiliar codebases, orient first or use a scoped `explorer` subagent to produce a factual map.

## Diagram brief

Before drawing, answer these internally. Ask the user only if missing information materially changes the diagram.

1. **Question:** what should the viewer understand after 20 seconds?
2. **Audience:** maintainer, reviewer, planner, user, or newcomer?
3. **View:** structure, runtime flow, sequence, state, concept, or comparison?
4. **Evidence:** what files/docs/sources support nodes and edges?
5. **Artifact:** inline answer, Markdown file, wiki page, or standalone HTML/SVG?

A good diagram has a thesis. Do not draw boxes just to restate prose.

## Output modes

- **Inline Mermaid** — default for normal answers.
- **Markdown diagram doc** — for durable docs/wiki pages.
- **Diagram pack** — 2–4 small diagrams for complex systems.
- **Standalone HTML/SVG** — only for polished or browser-openable artifacts; use `skills/concept-diagrams/templates/standalone-svg.html`.

## Choose the right view

- **Source/architecture map:** ownership, packages, modules, trust boundaries.
- **Runtime/data flow:** what moves where and why.
- **Sequence:** order between actors/services/tools.
- **State/lifecycle:** statuses, transitions, failure modes.
- **Concept relationship map:** terms and relationships where edge labels matter.
- **Comparison table:** use a table instead when classification is clearer than arrows.

## Codebase diagram protocol

1. Read obvious entrypoints first: README, package config, route files, command registration, crate/module roots, extension indexes.
2. Trace only the relevant path. Do not map the whole repo unless asked.
3. Include file paths in node notes or a `Sources inspected` list.
4. Distinguish facts from inferred relationships.
5. Prefer several focused views over one monster diagram.

For wiki diagrams, check `SCHEMA.md`, `index.md`, and existing pages before writing a wiki page.

## Mermaid guardrails

- Use stable ASCII IDs: `WikiContext`, not `wiki-context()`.
- Put human labels in brackets: `WikiContext[wiki_context tool]`.
- Keep labels short and readable.
- Avoid punctuation-heavy IDs and raw `<`, `>`, `|`, `{`, `}` in labels.
- Keep subgraph names short.
- Use edge labels only when they add meaning.
- Explain dashed vs solid arrows if both are used.

## Readability budget

Default limits unless the user explicitly wants detail:

- 5–9 primary nodes per diagram
- 1–3 subgraphs
- 0–2 edge styles
- sequence diagrams: 3–5 participants
- state diagrams: 5–8 states
- node labels: 4–6 words max

If the diagram exceeds the budget, split it by view.

## Standalone HTML/SVG mode

Use for polished files only.

Requirements:

- self-contained HTML; no CDN scripts or remote assets
- inline SVG only
- light/dark friendly CSS variables
- flat, minimal style
- readable at browser default zoom
- title, subtitle, diagram, and notes
- write to the user path or `docs/diagrams/<slug>.html`

Do not start a preview server unless the user asks. Use Herdr for persistent server ownership; use a bounded Job only for a short smoke check.

## Quality checks

Before final output:

- The diagram answers one clear question.
- Direction of reading is obvious.
- Nodes and edges are backed by source, user input, or explicit assumptions.
- Boundaries/subgraphs mean something real.
- There are no unlabeled arrows between vague boxes.
- Large systems are split into focused views.
- Codebase diagrams list inspected paths.
- Mermaid syntax is likely renderable.

## Anti-slop rules

Reject or revise diagrams that:

- restate prose as bubbles without adding structure
- invent architecture from filenames only
- use arrows to mean several unrelated things
- imply certainty where relationships are inferred
- cram everything into one unreadable view
- use decorative colors that imply false categories
- omit source/assumption notes for code or research claims
